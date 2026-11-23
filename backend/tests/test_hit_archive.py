"""Version-pinned exports and independent offline verification."""

from hashlib import sha256
import json
from zipfile import ZipFile

from fastapi import HTTPException

from app.hit import cohort, research
from app.hit.audit.archive import inspect_archive
from app.hit.audit.source import inspect_sources
from tests.hit_fixtures import AUTHOR, CASE, FILTERS, JOB, DataVolume, make_run


class ArchiveContract(DataVolume):
    def test_research_zip_can_be_checked_without_source_volume(self):
        archive = self.package()
        report = inspect_archive(archive)
        self.assertClean(report)
        self.assertEqual(report.facts["病例"], 1)
        self.assertEqual(report.facts["批次"], 1)
        self.assertEqual(report.facts["文件"], 7)

    def test_manifest_points_to_approved_version_after_later_edits(self):
        v1 = self.revision()
        approved = self.review(v1)
        v2 = self.revision(parent=v1)
        self.review(v2, state="pending")
        archive = self.export([v1])
        self.assertClean(inspect_sources(archive, self.data))
        with ZipFile(archive) as package:
            row = json.loads(package.read("manifest.json"))["runs"][0]
            self.assertEqual(row["review"]["round_id"], approved)
            self.assertEqual(row["revision"]["id"], v1)
            self.assertNotIn(v2, row["files"]["revision"]["path"])

    def test_two_runs_of_one_case_have_one_subset(self):
        other = "scan-b"
        make_run(self.data, job=other)
        first = self.revision()
        second = self.revision(job=other)
        for version in (first, second):
            self.review(version)
        archive = self.export([first, second])
        report = inspect_archive(archive)
        self.assertClean(report)
        self.assertEqual(report.facts["批次"], 2)
        self.assertEqual(report.facts["病例"], 1)
        self.assertEqual(sum(report.facts["各子集病例数"].values()), 1)

    def test_selection_order_does_not_change_membership(self):
        make_run(self.data, "repeat-scan")
        first = self.revision()
        second = self.revision(job="repeat-scan")
        for version in (first, second):
            self.review(version)

        def memberships(identities):
            path = self.export(identities)
            with ZipFile(path) as pack:
                return {
                    row["job_id"]: row["split"]
                    for row in json.loads(pack.read("manifest.json"))["runs"]
                }

        self.assertEqual(memberships([first, second]), memberships([second, first]))

    def test_distinct_versions_of_one_run_cannot_both_be_selected(self):
        first, second = self.revision(), self.revision()
        self.review(first)
        self.review(second)
        with self.assertRaises(HTTPException) as raised:
            self.export([first, second])
        self.assertEqual(raised.exception.status_code, 422)

    def test_returned_version_is_ineligible(self):
        key = self.revision()
        self.review(key, state="returned")
        with self.assertRaises(HTTPException) as raised:
            self.export([key])
        self.assertIn("通过复核", raised.exception.detail)

    def test_nonmatching_filter_cannot_be_recorded_as_provenance(self):
        key = self.revision()
        self.review(key)
        with self.assertRaises(HTTPException):
            self.export([key], filters={**FILTERS, "author": "另一位作者"})

    def test_tampered_bytes_detected_even_with_intact_zip_crc(self):
        archive = self.package()

        def edit(manifest, files):
            entry = manifest["runs"][0]["files"]["revision"]
            files[entry["path"]] += b"changed"
            entry["bytes"] = len(files[entry["path"]])

        self.modify_zip(archive, edit)
        self.assertFinding(inspect_archive(archive), "实际数据摘要不符")

    def test_missing_binary_is_distinct_from_unlisted_binary(self):
        archive = self.package()
        path = "unknown/image.png"

        def edit(manifest, files):
            entry = manifest["runs"][0]["files"]["mask"]
            files[path] = files.pop(entry["path"])

        self.modify_zip(archive, edit)
        report = inspect_archive(archive)
        self.assertFinding(report, "清单引用缺失的文件")
        self.assertIn("未被清单引用", report.render())

    def test_case_split_can_be_recomputed_after_download(self):
        archive = self.package()

        def edit(manifest, _):
            row = manifest["runs"][0]
            row["split"] = "train" if row["split"] != "train" else "test"

        self.modify_zip(archive, edit)
        self.assertFinding(inspect_archive(archive), "病例划分与种子不符")

    def test_modified_band_allocation_is_not_accepted_as_original_policy(self):
        archive = self.package()
        self.modify_zip(archive, lambda m, _: m["split"].update(train=[0, 89]))
        self.assertFinding(inspect_archive(archive), "区间与划分方法不符")

    def test_wrong_reviewer_identity_detected_by_source_check(self):
        archive = self.package()

        def edit(manifest, _):
            manifest["runs"][0]["review"]["reviewer"] = "另一人"

        self.modify_zip(archive, edit)
        self.assertClean(inspect_archive(archive))
        self.assertFinding(inspect_sources(archive, self.data), "复核人字段")

    def test_metadata_digest_cannot_substitute_for_actual_source_bytes(self):
        archive = self.package()
        self.replace_asset("mask", b"damaged", rehash=False)
        self.assertFinding(inspect_sources(archive, self.data), "源文件实际摘要")

    def test_relabelled_version_is_detected_even_after_removing_head(self):
        archive = self.package()
        with self.connection() as db:
            db.execute("DELETE FROM heads")
            db.execute("UPDATE versions SET username='不同作者'")
        self.assertFinding(inspect_sources(archive, self.data), "username")

    def test_declared_file_bytes_match_actual_zip_member_length(self):
        archive = self.package()
        self.modify_zip(archive, lambda m, _: m["runs"][0]["files"]["mask"].update(bytes=1))
        self.assertFinding(inspect_archive(archive), "字节数")

    def test_archive_preserves_version_source_threshold(self):
        key = self.revision(source="threshold", threshold=0.712)
        self.review(key)
        archive = self.export([key])
        with ZipFile(archive) as z:
            row = json.loads(z.read("manifest.json"))["runs"][0]
            self.assertEqual(row["revision"]["source"], "threshold")
            self.assertEqual(row["revision"]["threshold"], 0.712)
        self.assertClean(inspect_sources(archive, self.data))

    def test_run_prefix_and_filename_match_pinned_identifiers(self):
        archive = self.package()

        def edit(manifest, files):
            row = manifest["runs"][0]
            entry = row["files"]["revision"]
            path = f"{CASE}/{JOB}/revision/latest.png"
            files[path] = files.pop(entry["path"])
            entry["path"] = path

        self.modify_zip(archive, edit)
        self.assertFinding(inspect_archive(archive), "修订文件名与版本标识不符")

    def test_current_head_can_change_without_invalidating_export(self):
        archive = self.package()
        self.revision()
        with self.connection() as db:
            db.execute("DELETE FROM heads WHERE username=?", (AUTHOR,))
        self.assertClean(inspect_sources(archive, self.data))

    def test_missing_database_check_does_not_create_one(self):
        archive = self.package()
        absent = self.data / "other"
        self.assertFinding(inspect_sources(archive, absent), "源数据库文件不存在")
        self.assertFalse(absent.exists())

    def test_preview_uses_same_case_counts_and_eligible_versions(self):
        ids = [self.revision(), self.revision(author="另一位")]
        for key in ids:
            self.review(key)
        with self.connection() as db:
            rows = research.candidates(db)
            approved = {row["version"]: row for row in rows}
            chosen = cohort.select([ids[0]], "fixture", FILTERS, approved)
            before = cohort.preview(chosen, "fixture")
        archive = self.export([ids[0]])
        with ZipFile(archive) as z:
            row = json.loads(z.read("manifest.json"))["runs"][0]
        self.assertEqual(before["rows"][0]["version"], row["revision"]["id"])
        self.assertEqual(before["rows"][0]["split"], row["split"])
        self.assertEqual(before["case_counts"], {row["split"]: 1})

    def test_filter_text_has_the_same_substring_meaning_on_export_and_audit(self):
        version = self.revision()
        self.review(version)
        archive = self.export([version], filters={"case": "01", "job": "scan", "author": "者"})
        self.assertClean(inspect_archive(archive))

    def test_version_digest_matches_actual_exported_file(self):
        archive = self.package()
        with ZipFile(archive) as z:
            row = json.loads(z.read("manifest.json"))["runs"][0]
            field = row["files"]["revision"]
            self.assertEqual(sha256(z.read(field["path"])).hexdigest(), row["revision"]["digest"])
            self.assertEqual(field["sha256"], row["revision"]["digest"])
