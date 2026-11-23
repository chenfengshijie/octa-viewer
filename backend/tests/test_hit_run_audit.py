"""Cross-artifact checks that file-presence or checksum-only validation would miss."""

from io import BytesIO

import numpy as np

from app.hit.audit.run import inspect_run, probability_precision
from app.hit.audit.common import InvalidArtifact
from tests.hit_fixtures import DataVolume, FILES, png, standard_mask


class RunContract(DataVolume):
    def test_complete_run_reports_native_foreground_and_thickness(self):
        report = inspect_run(self.run_dir)
        self.assertClean(report)
        self.assertEqual(report.facts["前景像素"], int(np.count_nonzero(standard_mask())))
        self.assertEqual(report.facts["背景像素"] + report.facts["前景像素"], 448 * 448)
        self.assertEqual(report.facts["归档产物"], 9)
        self.assertEqual(report.facts["浅层厚度范围 px"], [30, 30])
        self.assertEqual(report.facts["深层厚度范围 px"], [35, 35])

    def test_audit_does_not_repair_bad_digest(self):
        self.change_record(lambda record: record["sha256"].update(mask="0" * 64))
        before = (self.run_dir / "record.json").read_bytes()
        self.assertFinding(inspect_run(self.run_dir), "产物摘要与清单不符")
        self.assertEqual((self.run_dir / "record.json").read_bytes(), before)

    def test_missing_asset_is_named(self):
        (self.run_dir / FILES["probability"]).unlink()
        report = inspect_run(self.run_dir)
        self.assertFinding(report, "probability")
        self.assertIn("文件缺失", report.render())

    def test_channels_can_have_correct_hash_and_wrong_order(self):
        from PIL import Image

        with Image.open(self.run_dir / FILES["model_input"]) as img:
            swapped = np.asarray(img)[:, :, [2, 1, 0]]
        self.replace_asset("model_input", png(swapped))
        self.assertFinding(inspect_run(self.run_dir), "模型输入通道")

    def test_lossless_mask_type_is_checked_before_conversion(self):
        value = standard_mask()
        self.replace_asset("mask", png(np.stack([value] * 3, axis=2)))
        self.assertFinding(inspect_run(self.run_dir), "PNG 通道")

    def test_mask_may_not_contain_partial_opacity(self):
        value = standard_mask()
        value[0, 0] = 128
        self.replace_asset("mask", png(value))
        self.assertFinding(inspect_run(self.run_dir), "掩膜含")

    def test_overlay_is_compared_to_origin_even_with_matching_digest(self):
        self.replace_asset("overlay", png(np.zeros((448, 448, 3), dtype=np.uint8)))
        self.assertFinding(inspect_run(self.run_dir), "叠加图与归档模型输入")

    def test_collapsed_and_inverted_surfaces_are_both_rejected(self):
        base = np.full((448, 448), 100, np.int16)
        for offset in (0, -1):
            with self.subTest(offset=offset):
                f = BytesIO()
                np.savez_compressed(f, ilm=base, opl=base + offset, bm=base + 60)
                self.replace_asset("surfaces", f.getvalue())
                self.assertFinding(inspect_run(self.run_dir), "层次顺序")

    def test_slice_count_and_depth_order_are_not_interchangeable(self):
        f = BytesIO()
        surface = np.zeros((1024, 448), np.int16)
        np.savez_compressed(f, ilm=surface, opl=surface + 10, bm=surface + 20)
        self.replace_asset("surfaces", f.getvalue())
        self.assertFinding(inspect_run(self.run_dir), "曲面尺寸或类型错误")

    def test_empty_probability_and_nan_are_distinguished(self):
        for invalid in (np.nan, np.inf, -0.1, 1.1):
            with self.subTest(invalid=invalid):
                f = BytesIO()
                values = np.zeros((448, 448), dtype=np.float16)
                values[0, 0] = invalid
                np.save(f, values)
                self.replace_asset("probability", f.getvalue())
                self.assertFinding(inspect_run(self.run_dir), "有限数")

    def test_invalid_precision_is_rejected(self):
        f = BytesIO()
        np.save(f, np.ones((448, 448), np.float32))
        self.replace_asset("probability", f.getvalue())
        self.assertFinding(inspect_run(self.run_dir), "概率数组类型或尺寸")

    def test_same_file_named_for_two_outputs_is_rejected(self):
        self.change_record(
            lambda row: row["outputs"].update(deep_projection=FILES["shallow_projection"])
        )
        self.assertFinding(inspect_run(self.run_dir), "多个产物共用同一文件")

    def test_job_must_match_directory(self):
        self.change_record(lambda row: row.update(job_id="another-job"))
        self.assertFinding(inspect_run(self.run_dir), "目录名称与批次标识")

    def test_thresholds_must_be_finite_and_bounded(self):
        for value in (True, 1.2, float("nan")):
            with self.subTest(value=value):
                self.change_record(lambda row: row["parameters"].update(threshold=value))
                self.assertFinding(inspect_run(self.run_dir), "推理参数")

    def test_model_weight_and_digest_have_separate_contracts(self):
        self.change_record(lambda row: row["model"].update(vessel_weight=" "))
        self.assertFinding(inspect_run(self.run_dir), "vessel_weight")
        self.change_record(
            lambda row: row["model"].update(
                vessel_weight="model.pth", vessel_weight_sha256="unknown"
            )
        )
        self.assertFinding(inspect_run(self.run_dir), "SHA-256")

    def test_bad_json_does_not_crash_inspector(self):
        (self.run_dir / "record.json").write_text('{"job_id":')
        self.assertFinding(inspect_run(self.run_dir), "record.json")

    def test_absent_directory_is_read_only(self):
        absent = self.data / "missing"
        self.assertFalse(inspect_run(absent).output()["ok"])
        self.assertFalse(absent.exists())


class ProbabilityRounding(DataVolume):
    def test_two_different_float32_decisions_can_have_identical_float16(self):
        # Adjacent float32 values around .8 quantize to the same archived value.
        low = np.float32(0.8)
        high = np.nextafter(low, np.float32(1))
        original = np.array([low, high], dtype=np.float32)
        archive = original.astype(np.float16)
        self.assertEqual(archive[0], archive[1])
        self.assertEqual(probability_precision(archive, np.array([0, 255], np.uint8), 0.8), 2)

    def test_rounding_never_justifies_a_large_disagreement(self):
        with self.assertRaises(InvalidArtifact):
            probability_precision(np.array([0.1, 0.99], np.float16), np.array([255, 0]), 0.8)

    def test_off_and_on_far_from_threshold_are_unambiguous(self):
        values = np.array([0, 0.25, 0.9, 1], np.float16)
        self.assertEqual(probability_precision(values, np.array([0, 0, 255, 255]), 0.8), 0)
