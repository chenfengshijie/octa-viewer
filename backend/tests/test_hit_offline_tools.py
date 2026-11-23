"""Static acceptance commands inspect existing files and return machine-readable diagnostics."""

from contextlib import redirect_stdout
from io import StringIO
import shutil

from app.hit import agreement, catalog
from app.hit.audit.__main__ import main
from app.hit.audit.comparisons import inspect_comparisons
from app.hit.audit.handoff import inspect_handoff
from app.hit.audit.volume import inspect_volume
from tests.hit_fixtures import (
    AUTHOR,
    CASE,
    JOB,
    FILES,
    DataVolume,
    json_file,
    make_run,
    png,
    standard_mask,
    write_json,
)


class HandoffContract(DataVolume):
    def setUp(self):
        super().setUp()
        self.source = self.data / "handoff"
        shutil.copytree(self.run_dir, self.source)
        info = json_file(self.source / "record.json")
        self.handoff = {
            "case_id": CASE,
            "task": "large_vessel",
            "schema_version": "1.0",
            "status": "complete",
            "parameters": info["parameters"],
            "model": info["model"],
            "outputs": info["outputs"],
        }
        self.pair = {
            "case_id": CASE,
            "job_id": JOB,
            "axes": ["Y", "Z", "X"],
            "shape": [448, 1024, 448],
            "dtype": "uint8",
            "fov_mm": [12, 12],
            "parameters": info["parameters"],
        }

    def inspect(self):
        write_json(self.source / "output_manifest.json", self.handoff)
        write_json(self.source / "case_manifest.json", self.pair)
        return inspect_handoff(self.run_dir, self.source)

    def test_legacy_result_without_job_id_is_checked_against_imported_batch(self):
        self.assertNotIn("job_id", self.handoff)
        report = self.inspect()
        self.assertClean(report)
        self.assertEqual(report.facts["逐字节摘要匹配产物"], 9)

    def test_implicit_slab_names_are_accepted_for_older_result(self):
        del self.handoff["outputs"]["deep_projection"]
        del self.handoff["outputs"]["shallow_projection"]
        self.assertClean(self.inspect())

    def test_declared_wrong_job_is_distinct_from_absent_job(self):
        self.handoff["job_id"] = "another-run"
        self.assertFinding(self.inspect(), "导入前后批次标识不符")

    def test_declared_source_must_be_complete(self):
        self.handoff["status"] = "running"
        self.assertFinding(self.inspect(), "交接清单未完成")

    def test_job_identity_cannot_bridge_different_cases(self):
        self.pair["case_id"] = "unrelated"
        self.assertFinding(self.inspect(), "配对声明中的病例不符")

    def test_metadata_mismatch_detected_before_exporting_provenance(self):
        self.handoff["parameters"]["tile_overlap"] = 0.5
        self.assertFinding(self.inspect(), "导入前后推理参数不符")

    def test_source_file_bytes_are_compared_even_when_sizes_match(self):
        absolute = self.source / FILES["overlay"]
        raw = bytearray(absolute.read_bytes())
        raw[-1] ^= 1
        absolute.write_bytes(raw)
        self.assertFinding(self.inspect(), "导入前后摘要不符")

    def test_axis_declaration_checked_independently_of_image_shape(self):
        self.pair["axes"] = ["X", "Z", "Y"]
        self.assertFinding(self.inspect(), "坐标轴不符")

    def test_legacy_fallback_is_limited_to_the_two_implicit_planes(self):
        del self.handoff["outputs"]["mask"]
        self.assertFinding(self.inspect(), "mask 交接对照")

    def test_model_description_should_survive_import(self):
        self.handoff["model"] = {**self.handoff["model"], "layer_model": "another-model"}
        self.assertFinding(self.inspect(), "导入前后模型描述不符")


class DataVolumeContract(DataVolume):
    def test_complete_read_only_volume(self):
        self.review(self.revision())
        report = inspect_volume(self.data)
        self.assertClean(report)
        self.assertEqual(report.facts["病例"], 1)
        self.assertEqual(report.facts["历史版本"], 1)
        self.assertEqual(report.facts["配对结构体"], 0)

    def test_viewer_without_first_save_does_not_need_database(self):
        self.dbfile.unlink()
        report = inspect_volume(self.data)
        self.assertClean(report)
        self.assertFalse(self.dbfile.exists())
        self.assertEqual(report.facts["复核数据库"], "尚未创建")

    def test_temporary_imports_are_not_batches(self):
        incomplete = catalog.RUNS / ".import-temp" / "result-set"
        incomplete.mkdir(parents=True)
        report = inspect_volume(self.data)
        self.assertClean(report)
        self.assertEqual(report.facts["已导入批次"], 1)

    def test_historical_revision_must_still_resolve_its_batch(self):
        self.revision(job="absent-run")
        self.assertFinding(inspect_volume(self.data), "缺失的推理批次")

    def test_imports_of_same_case_count_once_in_case_total(self):
        make_run(self.data, job="same-case")
        make_run(self.data, job="another-case", case="02")
        report = inspect_volume(self.data)
        self.assertClean(report)
        self.assertEqual(report.facts["已导入批次"], 3)
        self.assertEqual(report.facts["病例"], 2)

    def test_orphan_legacy_png_is_reported(self):
        d = catalog.LEGACY / "missing"
        d.mkdir(parents=True)
        (d / "annotator.png").write_bytes(png(standard_mask()))
        self.assertFinding(inspect_volume(self.data), "旧修订未关联")

    def test_private_pair_is_attached_by_run_not_case_alone(self):
        d = self.private / "oct" / CASE
        d.mkdir(parents=True)
        self.assertFinding(inspect_volume(self.data), "配对体未关联已导入的批次")

    def test_unrecognized_volume_data_does_not_become_public_or_mutated(self):
        other = self.data / "unrelated.bin"
        other.write_bytes(b"private bytes")
        self.assertClean(inspect_volume(self.data))
        self.assertEqual(other.read_bytes(), b"private bytes")


class DownloadedAgreement(DataVolume):
    def table(self, author="", reference=""):
        with self.connection() as db:
            result = agreement.compare_cohort(
                db, list(catalog.records()), author or None, reference or None
            )
        doc = {
            "selection": {"author": author, "reference_author": reference},
            "filter": "",
            "rows": result["rows"],
        }
        path = self.data / "table.json"
        write_json(path, doc)
        return path

    def test_original_table_reproduces_after_subsequent_saves(self):
        self.revision()
        path = self.table()
        self.revision(pixels=standard_mask())
        report = inspect_comparisons(path, self.data)
        self.assertClean(report)
        self.assertEqual(report.facts["成功复算批次"], 1)

    def test_peer_table_reproduces_after_either_current_pointer_changes(self):
        self.revision()
        self.revision(author="同事", pixels=standard_mask())
        path = self.table(AUTHOR, "同事")
        self.revision(author="同事")
        self.revision()
        self.assertClean(inspect_comparisons(path, self.data))

    def test_reversed_change_direction_is_detected(self):
        self.revision()
        path = self.table()
        table = json_file(path)
        (row,) = table["rows"]
        row["added"], row["erased"] = row["erased"], row["added"]
        write_json(path, table)
        self.assertFinding(inspect_comparisons(path, self.data), "added 与掩膜复算结果不符")

    def test_table_cannot_claim_a_different_filter(self):
        self.revision()
        path = self.table()
        table = json_file(path)
        table["filter"] = "nonmatching"
        write_json(path, table)
        self.assertFinding(inspect_comparisons(path, self.data), "筛选条件不符")

    def test_duplicate_pair_not_counted_twice(self):
        self.revision()
        path = self.table()
        table = json_file(path)
        table["rows"] *= 2
        write_json(path, table)
        self.assertFinding(inspect_comparisons(path, self.data), "同一批次被统计多次")

    def test_empty_filtered_table_has_no_means(self):
        path = self.table()
        report = inspect_comparisons(path, self.data)
        self.assertClean(report)
        self.assertEqual(report.facts["成功复算批次"], 0)
        self.assertNotIn("dice", report.facts)


class CommandOutput(DataVolume):
    def invoke(self, *args):
        out = StringIO()
        with redirect_stdout(out):
            status = main(list(map(str, args)))
        return status, out.getvalue()

    def test_command_emits_parseable_json(self):
        import json

        code, text = self.invoke("run", self.run_dir, "--json")
        self.assertEqual(code, 0)
        decoded = json.loads(text)
        self.assertTrue(decoded["ok"])
        self.assertEqual(decoded["facts"]["归档产物"], 9)

    def test_invalid_package_returns_nonzero(self):
        file = self.data / "bad.zip"
        file.write_bytes(b"bad")
        code, text = self.invoke("archive", file)
        self.assertEqual(code, 1)
        self.assertIn("ZIP 索引", text)

    def test_source_option_reads_owning_records(self):
        package = self.package()
        code, text = self.invoke("archive", package, "--data-dir", self.data)
        self.assertEqual(code, 0)
        self.assertIn("对照数据卷", text)
