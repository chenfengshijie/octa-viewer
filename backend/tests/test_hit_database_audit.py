"""Inspect the persistent representation independently of the HTTP handlers."""

from hashlib import sha256
import sqlite3

from app.hit.audit.database import inspect_database
from tests.hit_fixtures import AUTHOR, JOB, PEER, DataVolume, moment


class StoredHistory(DataVolume):
    def report(self):
        return inspect_database(self.dbfile)

    def test_empty_database_has_no_artificial_history(self):
        report = self.report()
        self.assertClean(report)
        self.assertEqual(report.facts["历史版本"], 0)
        self.assertEqual(report.facts["复核意见"], 0)

    def test_original_and_threshold_versions_are_both_valid_roots(self):
        self.revision(source="threshold", threshold=0.0)
        self.revision(source="threshold", threshold=1.0)
        self.revision()
        report = self.report()
        self.assertClean(report)
        self.assertEqual(report.facts["历史版本"], 3)
        self.assertEqual(report.facts["当前个人版本"], 1)

    def test_old_version_can_become_parent_after_a_newer_save(self):
        first = self.revision()
        self.revision(parent=first)
        self.revision(parent=first)
        self.assertClean(self.report())

    def test_stored_png_digest_is_recomputed(self):
        key = self.revision()
        with self.connection() as db:
            db.execute("UPDATE versions SET digest=? WHERE id=?", ("0" * 64, key))
        self.assertFinding(self.report(), "掩膜摘要与修订记录不符")

    def test_binary_format_is_verified_even_if_digest_is_fresh(self):
        key = self.revision()
        raw = b"not a png"
        with self.connection() as db:
            db.execute(
                "UPDATE versions SET png=?,digest=? WHERE id=?", (raw, sha256(raw).hexdigest(), key)
            )
        report = self.report()
        self.assertFalse(report.output()["ok"])
        self.assertIn(key, report.render())

    def test_head_belongs_to_author_and_batch(self):
        original = self.revision()
        self.revision(author=PEER)
        with self.connection() as db:
            db.execute("UPDATE heads SET version=? WHERE username=?", (original, PEER))
        self.assertFinding(self.report(), "指向其他批次或作者")

    def test_removing_current_pointer_preserves_accessible_history(self):
        first = self.revision()
        self.review(first)
        with self.connection() as db:
            db.execute("DELETE FROM heads")
        report = self.report()
        self.assertClean(report)
        self.assertEqual(report.facts["历史版本"], 1)
        self.assertEqual(report.facts["当前个人版本"], 0)

    def test_legacy_root_with_migration_marker_is_valid(self):
        self.revision(source="legacy")
        self.assertClean(self.report())
        with self.connection() as db:
            db.execute("DELETE FROM imported WHERE job=?", (JOB,))
        self.assertFinding(self.report(), "缺少迁移标记")

    def test_parent_chain_may_not_link_to_another_run(self):
        parent = self.revision()
        self.revision(job="other", parent=parent)
        self.assertFinding(self.report(), "来源版本属于其他批次")

    def test_cycle_found_without_recursion(self):
        first = self.revision()
        second = self.revision(parent=first)
        with self.connection() as db:
            db.execute("UPDATE versions SET source='revision',parent=? WHERE id=?", (second, first))
        self.assertFinding(self.report(), "历史关系出现环")

    def test_all_revisions_retain_timezone(self):
        key = self.revision()
        with self.connection() as db:
            db.execute("UPDATE versions SET created='2026-11-23T01:01:01' WHERE id=?", (key,))
        self.assertFinding(self.report(), "缺少时区")

    def test_missing_file_read_is_non_destructive(self):
        missing = self.private / "other.sqlite3"
        self.assertFinding(inspect_database(missing), "数据库文件不存在")
        self.assertFalse(missing.exists())

    def test_missing_table_reports_structural_error(self):
        with self.connection() as db:
            db.execute("DROP TABLE comments")
        self.assertFinding(self.report(), "缺少字段")

    def test_scan_leaves_database_bytes_unchanged(self):
        self.review(self.revision())
        before = self.dbfile.read_bytes()
        self.assertClean(self.report())
        self.assertEqual(self.dbfile.read_bytes(), before)


class StoredReview(DataVolume):
    def test_resubmission_with_reason_preserves_one_mask_two_decisions(self):
        version = self.revision()
        first = self.review(version, "returned")
        self.note(first)
        self.review(version, previous=first, reason="说明原判断")
        report = inspect_database(self.dbfile)
        self.assertClean(report)
        self.assertEqual(report.facts["轮次状态"], {"returned": 1, "approved": 1})
        self.assertEqual(report.facts["历史版本"], 1)
        self.assertEqual(report.facts["带位置的意见"], 1)

    def test_resubmission_after_edit_retains_location_on_old_mask(self):
        original = self.revision()
        first = self.review(original, "returned")
        self.note(first)
        replacement = self.revision(parent=original)
        self.review(replacement, previous=first)
        self.assertClean(inspect_database(self.dbfile))

    def test_pending_round_has_no_formal_decision(self):
        current = self.review(self.revision(), "pending")
        with self.connection() as db:
            db.execute("UPDATE rounds SET reviewer=? WHERE id=?", (PEER, current))
        self.assertFinding(inspect_database(self.dbfile), "待复核轮次已有结论")

    def test_self_approval_is_detected_in_snapshot(self):
        self.review(self.revision(), reviewer=AUTHOR)
        self.assertFinding(inspect_database(self.dbfile), "作者本人审批")

    def test_returned_same_mask_requires_non_whitespace_reason(self):
        version = self.revision()
        first = self.review(version, "returned")
        self.review(version, previous=first, reason="  ")
        self.assertFinding(inspect_database(self.dbfile), "原版重提理由")

    def test_completed_round_cannot_gain_a_later_comment(self):
        current = self.review(self.revision())
        comment = self.note(current)
        with self.connection() as db:
            db.execute("UPDATE comments SET created=? WHERE id=?", (moment(1000), comment))
        self.assertFinding(inspect_database(self.dbfile), "归档后写入")

    def test_general_comment_has_no_location(self):
        current = self.review(self.revision(), "pending")
        self.note(current, x=None, y=None)
        report = inspect_database(self.dbfile)
        self.assertClean(report)
        self.assertEqual(report.facts["带位置的意见"], 0)

    def test_partial_and_off_image_coordinates_are_rejected(self):
        current = self.review(self.revision(), "pending")
        item = self.note(current, x=None, y=0)
        self.assertFinding(inspect_database(self.dbfile), "缺少一个坐标")
        with self.connection() as db:
            db.execute("UPDATE comments SET x=448 WHERE id=?", (item,))
        self.assertFinding(inspect_database(self.dbfile), "大于 447")

    def test_review_text_is_not_emitted_in_report(self):
        current = self.review(self.revision())
        self.note(current, body="仅成员可见的文本")
        report = inspect_database(self.dbfile)
        self.assertClean(report)
        self.assertNotIn("仅成员可见的文本", str(report.output()))

    def test_new_review_cannot_use_another_authors_return_as_predecessor(self):
        first = self.review(self.revision(), "returned")
        other = self.revision(author="另一作者")
        self.review(other, previous=first)
        self.assertFinding(inspect_database(self.dbfile), "重提跨越修订作者")

    def test_one_version_cannot_be_approved_and_also_pending(self):
        version = self.revision()
        self.review(version)
        self.review(version, state="pending")
        self.assertFinding(inspect_database(self.dbfile), "仍待复核")

    def test_unique_pending_constraint_survives_concurrent_submissions(self):
        version = self.revision()
        self.review(version, state="pending")
        with self.assertRaises(sqlite3.IntegrityError):
            self.review(version, state="pending")
        self.assertClean(inspect_database(self.dbfile))

    def test_wrong_foreign_key_is_detected_before_reading_mask_bytes(self):
        key = self.revision()
        with self.connection() as db:
            db.execute("UPDATE versions SET source='revision',parent=? WHERE id=?", ("e" * 32, key))
        self.assertFinding(inspect_database(self.dbfile), "失效的外键引用")
