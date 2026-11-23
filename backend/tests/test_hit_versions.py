"""Regression cases for immutable saves, legacy import and concurrent editors."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from fastapi import HTTPException

from app.hit import catalog, storage, versioning
from tests.hit_fixtures import AUTHOR, JOB, PEER, DataVolume, changed_mask, png, standard_mask


class VersionWrites(DataVolume):
    def setUp(self):
        super().setUp()
        self.mask = png(standard_mask())
        self.changed = png(changed_mask())

    def save(self, **kwargs):
        return versioning.save(JOB, AUTHOR, self.mask, **kwargs)

    def current(self, author=AUTHOR):
        with self.connection() as db:
            return storage.head(db, JOB, author)

    def history(self):
        with self.connection() as db:
            return storage.history(db, JOB)

    def test_clean_explicit_saves_create_distinct_revisions(self):
        first = self.save()
        second = self.save()
        self.assertNotEqual(first, second)
        versions = self.history()
        self.assertEqual([row["current"] for row in versions], [True, False])
        self.assertEqual(versions[0]["digest"], versions[1]["digest"])
        self.assertNotEqual(versions[0]["mask_url"], versions[1]["mask_url"])

    def test_retransmission_has_exactly_one_receipt_and_one_revision(self):
        request_id = "a" * 32
        first = self.save(request_id=request_id, expected=None, guarded=True)
        second = self.save(request_id=request_id, expected=None, guarded=True)
        self.assertEqual(first, second)
        self.assertEqual(len(self.history()), 1)
        with self.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM saves").fetchone()[0], 1)

    def test_old_retry_after_more_recent_save_does_not_move_current_pointer(self):
        prior = self.save(request_id="b" * 32, expected=None, guarded=True)
        newest = self.save(parent=prior, expected=prior, guarded=True)
        result = self.save(request_id="b" * 32, expected=None, guarded=True)
        self.assertEqual(result, prior)
        self.assertEqual(self.current(), newest)

    def test_reusing_request_id_for_changed_content_is_rejected(self):
        req = "c" * 32
        head = self.save(request_id=req)
        with self.assertRaises(HTTPException) as err:
            versioning.save(JOB, AUTHOR, self.changed, request_id=req)
        self.assertEqual(err.exception.status_code, 409)
        self.assertEqual(self.current(), head)
        self.assertEqual(len(self.history()), 1)

    def test_retry_scope_is_per_author_per_run(self):
        req = "d" * 32
        first = self.save(request_id=req)
        other = versioning.save(JOB, PEER, self.mask, request_id=req)
        self.assertNotEqual(first, other)
        self.assertEqual(self.current(PEER), other)

    def test_two_windows_guarded_against_same_head_keep_both_authors_history_intact(self):
        initial = self.save()
        peer = versioning.save(JOB, PEER, self.mask)
        barrier = Barrier(2)

        def write():
            barrier.wait(timeout=5)
            try:
                return self.save(parent=initial, expected=initial, guarded=True)
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=2) as workers:
            results = [future.result() for future in [workers.submit(write), workers.submit(write)]]
        self.assertIn(409, results)
        self.assertIn(self.current(), results)
        self.assertEqual(self.current(PEER), peer)
        self.assertEqual(len(self.history()), 3)

    def test_guard_uses_current_pointer_instead_of_parent(self):
        old = self.save()
        head = self.save(parent=old)
        branch = self.save(parent=old, expected=head, guarded=True)
        with self.connection() as db:
            self.assertEqual(storage.version(db, JOB, branch)["parent"], old)
            self.assertEqual(storage.version(db, JOB, head)["parent"], old)
        self.assertEqual(self.current(), branch)

    def test_stale_reset_is_rejected_and_reset_preserves_immutable_masks(self):
        first = self.save()
        second = self.save()
        with self.assertRaises(HTTPException):
            versioning.reset(JOB, AUTHOR, expected=first)
        self.assertEqual(self.current(), second)
        versioning.reset(JOB, AUTHOR, expected=second)
        self.assertIsNone(self.current())
        with self.connection() as db:
            self.assertEqual(storage.mask_bytes(db, {"job_id": JOB}, second), self.mask)
            self.assertEqual(len(storage.history(db, JOB)), 2)

    def test_revision_base_is_validated_in_its_own_run(self):
        other = versioning.save("another-job", AUTHOR, self.mask)
        with self.assertRaises(HTTPException) as err:
            self.save(parent=other)
        self.assertEqual(err.exception.status_code, 404)
        self.assertIsNone(self.current())

    def test_other_users_base_is_read_only(self):
        another = versioning.save(JOB, PEER, self.mask)
        with self.assertRaises(HTTPException) as err:
            self.save(parent=another)
        self.assertEqual(err.exception.status_code, 403)
        self.assertIsNone(self.current())

    def test_threshold_zero_remains_a_threshold_origin(self):
        version = self.save(threshold=0)
        with self.connection() as db:
            row = storage.version(db, JOB, version)
        self.assertEqual(row["source"], "threshold")
        self.assertEqual(row["threshold"], 0)
        self.assertIsNone(row["parent"])

    def test_threshold_and_parent_are_mutually_exclusive(self):
        parent = self.save()
        with self.assertRaises(HTTPException) as err:
            self.save(parent=parent, threshold=0.2)
        self.assertEqual(err.exception.status_code, 422)
        self.assertEqual(self.current(), parent)

    def test_partial_transaction_never_exposes_uncommitted_version(self):
        head = self.save()
        with self.assertRaises(RuntimeError):
            with storage.transaction(write=True) as db:
                storage.insert_version(db, JOB, AUTHOR, self.mask, "revision", parent=head)
                raise RuntimeError("interrupted before commit")
        self.assertEqual(self.current(), head)
        self.assertEqual(len(self.history()), 1)


class LegacyImport(DataVolume):
    def setUp(self):
        super().setUp()
        with self.connection() as db:
            db.execute("DELETE FROM imported")
        self.folder = catalog.LEGACY / JOB
        self.folder.mkdir(parents=True)
        self.mask = png(standard_mask())
        (self.folder / (AUTHOR + ".png")).write_bytes(self.mask)

    def test_first_read_imports_legacy_bytes_without_mutating_them(self):
        storage.prepare(JOB)
        with self.connection() as db:
            (row,) = storage.history(db, JOB)
            self.assertEqual(row["source"], "legacy")
            self.assertTrue(row["current"])
            self.assertEqual(storage.mask_bytes(db, {"job_id": JOB}, row["id"]), self.mask)
        self.assertEqual((self.folder / (AUTHOR + ".png")).read_bytes(), self.mask)

    def test_later_reads_preserve_the_first_immutable_id(self):
        storage.prepare(JOB)
        with self.connection() as db:
            first = storage.head(db, JOB, AUTHOR)
        storage.prepare(JOB)
        with self.connection() as db:
            self.assertEqual(storage.head(db, JOB, AUTHOR), first)
            self.assertEqual(len(storage.history(db, JOB)), 1)

    def test_delete_current_does_not_reimport_legacy_file(self):
        storage.prepare(JOB)
        versioning.reset(JOB, AUTHOR)
        storage.prepare(JOB)
        with self.connection() as db:
            self.assertIsNone(storage.head(db, JOB, AUTHOR))
            (row,) = storage.history(db, JOB)
            self.assertFalse(row["current"])

    def test_concurrent_first_read_has_only_one_migration(self):
        barrier = Barrier(2)

        def read():
            barrier.wait(timeout=5)
            storage.prepare(JOB)
            with storage.transaction() as db:
                return storage.head(db, JOB, AUTHOR)

        with ThreadPoolExecutor(max_workers=2) as pool:
            a, b = [f.result() for f in [pool.submit(read), pool.submit(read)]]
        self.assertEqual(a, b)
        with self.connection() as db:
            self.assertEqual(len(storage.history(db, JOB)), 1)

    def test_failure_mid_migration_rolls_back_both_head_and_marker(self):
        original = storage.insert_version

        def fail_after_insert(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("migration interrupted")

        with patch.object(storage, "insert_version", side_effect=fail_after_insert):
            with self.assertRaises(RuntimeError):
                storage.prepare(JOB)
        with self.connection() as db:
            self.assertFalse(storage.history(db, JOB))
            self.assertFalse(db.execute("SELECT 1 FROM imported").fetchone())
        storage.prepare(JOB)
        with self.connection() as db:
            self.assertEqual(len(storage.history(db, JOB)), 1)
