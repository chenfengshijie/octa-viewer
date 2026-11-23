"""Review state transitions across immutable versions and independently owned rounds."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from fastapi import HTTPException

from app.hit import reviews, storage
from tests.hit_fixtures import AUTHOR, JOB, PEER, DataVolume


class ReviewRules(DataVolume):
    def setUp(self):
        super().setUp()
        self.version = self.revision()

    def submit(self, version=None, previous=None, reason="", author=AUTHOR):
        with storage.transaction(write=True) as db:
            return reviews.submitted(db, JOB, version or self.version, author, previous, reason)

    def decide(self, identity, outcome, actor=PEER):
        with storage.transaction(write=True) as db:
            return reviews.conclude(db, identity, actor, outcome, "检查完成")

    def test_only_author_can_submit_saved_version(self):
        with self.assertRaises(HTTPException) as err:
            self.submit(author=PEER)
        self.assertEqual(err.exception.status_code, 403)
        with self.connection() as db:
            self.assertFalse(reviews.queue(db))

    def test_author_can_add_context_but_cannot_make_final_decision(self):
        item = self.submit()
        with storage.transaction(write=True) as db:
            comment_id = reviews.add_comment(db, item["id"], AUTHOR, "提示", 0, 0)
        with self.assertRaises(HTTPException):
            self.decide(item["id"], "approved", AUTHOR)
        with self.connection() as db:
            detail = reviews.thread(db, item["id"])
            self.assertEqual(detail["state"], "pending")
            self.assertEqual(detail["comments"][0]["id"], comment_id)

    def test_new_save_does_not_retarget_existing_review(self):
        item = self.submit()
        new = self.revision(parent=self.version)
        decision = self.decide(item["id"], "approved")
        self.assertEqual(decision["version"], self.version)
        self.assertNotEqual(decision["version"], new)

    def test_first_conclusion_wins_when_two_peers_disagree(self):
        item = self.submit()
        barrier = Barrier(2)

        def write(actor, outcome):
            barrier.wait(timeout=5)
            try:
                return self.decide(item["id"], outcome, actor)["state"]
            except HTTPException as err:
                return err.status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(write, "乙", "approved"), pool.submit(write, "丙", "returned")]
            responses = [f.result() for f in futures]
        self.assertEqual(responses.count(409), 1)
        with self.connection() as db:
            row = reviews.thread(db, item["id"])
        self.assertIn(row["state"], responses)
        self.assertEqual(row["reviewer"], "乙" if row["state"] == "approved" else "丙")

    def test_same_version_resubmission_uses_new_round_id(self):
        original = self.submit()
        self.decide(original["id"], "returned")
        repeat = self.submit(reason="原图符合作者判断")
        self.assertNotEqual(repeat["id"], original["id"])
        self.assertEqual(repeat["version"], original["version"])
        self.assertEqual(repeat["previous"], original["id"])
        self.assertEqual(repeat["reason"], "原图符合作者判断")
        with self.connection() as db:
            self.assertEqual(reviews.thread(db, original["id"])["state"], "returned")

    def test_blank_reason_cannot_reopen_same_mask(self):
        initial = self.submit()
        self.decide(initial["id"], "returned")
        with self.assertRaises(HTTPException) as err:
            self.submit(reason=" \t\n ")
        self.assertEqual(err.exception.status_code, 422)

    def test_new_version_can_reference_previous_returned_round(self):
        initial = self.submit()
        self.decide(initial["id"], "returned")
        new = self.revision(parent=self.version)
        current = self.submit(version=new, previous=initial["id"])
        self.assertEqual(current["version"], new)
        self.assertEqual(current["previous"], initial["id"])

    def test_retired_round_cannot_acquire_new_spatial_opinion(self):
        initial = self.submit()
        self.decide(initial["id"], "returned")
        with self.assertRaises(HTTPException) as err:
            with storage.transaction(write=True) as db:
                reviews.add_comment(db, initial["id"], PEER, "事后意见", 12, 30)
        self.assertEqual(err.exception.status_code, 409)

    def test_wrong_parent_round_refused_for_resubmission(self):
        peer_version = self.revision(author=PEER)
        other = self.submit(version=peer_version, author=PEER)
        self.decide(other["id"], "returned", AUTHOR)
        with self.assertRaises(HTTPException):
            self.submit(previous=other["id"])

    def test_one_returned_round_has_at_most_one_successor(self):
        first = self.submit()
        self.decide(first["id"], "returned")
        new = self.revision(parent=self.version)
        self.submit(version=new, previous=first["id"])
        another = self.revision(parent=self.version)
        with self.assertRaises(HTTPException):
            self.submit(version=another, previous=first["id"])

    def test_approved_version_cannot_be_resubmitted(self):
        first = self.submit()
        self.decide(first["id"], "approved")
        with self.assertRaises(HTTPException):
            self.submit()

    def test_comments_need_nonblank_text_and_optional_point_pair(self):
        first = self.submit()
        for body, x, y in ((" ", None, None), ("点位", 10, None), ("点位", None, 0)):
            with self.subTest(body=body, x=x, y=y):
                with self.assertRaises(HTTPException):
                    with storage.transaction(write=True) as db:
                        reviews.add_comment(db, first["id"], PEER, body, x, y)

    def test_queue_records_successor_id_and_comment_count(self):
        original = self.submit()
        with storage.transaction(write=True) as db:
            reviews.add_comment(db, original["id"], PEER, "边界位置", 447, 0)
        self.decide(original["id"], "returned")
        next_round = self.submit(reason="复查已有标记")
        with self.connection() as db:
            newer, older = reviews.queue(db, JOB)
            self.assertEqual(older["comment_count"], 1)
            self.assertEqual(older["successor"], next_round["id"])
            self.assertEqual(newer["comment_count"], 0)
            self.assertFalse(reviews.queue(db, "other"))
