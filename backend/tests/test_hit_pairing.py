"""Offline attachment, provenance and slice-orientation regressions for optional structural OCT."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
import sys
from unittest.mock import patch

import numpy as np

from app.hit.audit.volume import inspect_volume
from tests.hit_fixtures import CASE, JOB, DataVolume, json_file, write_json

# The algorithm is a repository-level CLI; backend installed packages remain sufficient.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from algorithm.hit import attach_oct


class StructuralPair(DataVolume):
    def setUp(self):
        super().setUp()
        self.input = self.data / "source-oct.npy"
        self.pair_path = self.data / "case_manifest.json"
        self.fixture_shape = (3, 6, 4)
        values = np.arange(72, dtype=np.uint8).reshape(self.fixture_shape)
        np.save(self.input, values)
        self.pair = {
            "case_id": CASE,
            "job_id": JOB,
            "dtype": "uint8",
            "axes": ["Y", "Z", "X"],
            "shape": list(self.fixture_shape),
            "oct_sha256": sha256(self.input.read_bytes()).hexdigest(),
        }
        write_json(self.pair_path, self.pair)
        # Exercise publication and concurrent retries with small files.
        for module in ("algorithm.hit.attach_oct", "algorithm.hit.contract"):
            mock = patch(module + ".EXPECTED_VOLUME_SHAPE", self.fixture_shape)
            mock.start()
            self.addCleanup(mock.stop)

    @property
    def destination(self):
        return self.private / "oct" / JOB

    def attach(self):
        return attach_oct.attach(self.data, JOB, self.input, self.pair_path)

    def test_metadata_matches_published_bytes_and_volume_axes(self):
        metadata = self.attach()
        self.assertEqual(metadata, json_file(self.destination / "pair.json"))
        actual = self.destination / "oct.npy"
        self.assertEqual(metadata["bytes"], actual.stat().st_size)
        self.assertEqual(metadata["sha256"], sha256(actual.read_bytes()).hexdigest())
        self.assertEqual(metadata["axes"], ["Y", "Z", "X"])
        volume = np.load(actual)
        self.assertEqual(volume[1].shape, (6, 4))
        self.assertEqual(int(volume[1, 2, 3]), 35)

    def test_repeat_publication_with_same_volume_preserves_bytes(self):
        first = self.attach()
        before = (self.destination / "oct.npy").stat().st_mtime_ns
        second = self.attach()
        self.assertEqual(first, second)
        self.assertEqual((self.destination / "oct.npy").stat().st_mtime_ns, before)

    def test_concurrent_identical_attachments_publish_one_complete_pair(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.attach), pool.submit(self.attach)]
            first, second = [future.result() for future in futures]
        self.assertEqual(first, second)
        self.assertEqual(
            set(path.name for path in self.destination.iterdir()), {"pair.json", "oct.npy"}
        )

    def test_case_mismatch_precedes_copy(self):
        write_json(self.pair_path, {**self.pair, "case_id": "wrong"})
        with self.assertRaisesRegex(ValueError, "case_id"):
            self.attach()
        self.assertFalse(self.destination.exists())

    def test_batch_mismatch_is_checked_even_when_case_matches(self):
        write_json(self.pair_path, {**self.pair, "job_id": "other"})
        with self.assertRaisesRegex(ValueError, "job_id"):
            self.attach()
        self.assertFalse(self.destination.exists())

    def test_reordered_axes_cannot_be_attached(self):
        write_json(self.pair_path, {**self.pair, "axes": ["X", "Z", "Y"]})
        with self.assertRaisesRegex(ValueError, "axes"):
            self.attach()

    def test_shape_metadata_and_volume_header_checked_independently(self):
        write_json(self.pair_path, {**self.pair, "shape": [3, 4, 6]})
        with self.assertRaisesRegex(ValueError, "shape"):
            self.attach()
        write_json(self.pair_path, self.pair)
        np.save(self.input, np.zeros((3, 4, 6), dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "expected"):
            self.attach()
        self.assertFalse(self.destination.exists())

    def test_source_checksum_validated_when_handoff_provides_it(self):
        write_json(self.pair_path, {**self.pair, "oct_sha256": "f" * 64})
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.attach()

    def test_legacy_case_manifest_without_checksum_can_be_attached(self):
        del self.pair["oct_sha256"]
        write_json(self.pair_path, self.pair)
        result = self.attach()
        self.assertEqual(result["sha256"], sha256(self.input.read_bytes()).hexdigest())

    def test_cannot_replace_attached_volume_with_another(self):
        first = self.attach()
        np.save(self.input, np.zeros(self.fixture_shape, np.uint8))
        self.pair.pop("oct_sha256")
        write_json(self.pair_path, self.pair)
        with self.assertRaisesRegex(ValueError, "另一份"):
            self.attach()
        self.assertEqual(first, json_file(self.destination / "pair.json"))
        self.assertEqual(
            first["sha256"], sha256((self.destination / "oct.npy").read_bytes()).hexdigest()
        )

    def test_repeated_attach_detects_corruption_in_stored_volume(self):
        self.attach()
        (self.destination / "oct.npy").write_bytes(b"truncated")
        with self.assertRaisesRegex(ValueError, "已保存"):
            self.attach()

    def test_incomplete_stage_is_cleaned_after_invalid_source_file(self):
        self.input.write_bytes(b"invalid")
        with self.assertRaises(ValueError):
            self.attach()
        self.assertFalse(self.destination.exists())
        self.assertFalse(list(self.destination.parent.glob(".attach-*")))

    def test_source_filename_is_not_published_in_public_result(self):
        record = (self.run_dir / "record.json").read_bytes()
        self.attach()
        self.assertEqual(record, (self.run_dir / "record.json").read_bytes())
        self.assertNotIn(str(self.input), (self.destination / "pair.json").read_text())
        self.assertFalse((self.run_dir / "oct.npy").exists())

    def test_unimported_batch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "先导入"):
            attach_oct.attach(self.data, "absent", self.input, self.pair_path)

    def test_audit_uses_native_contract_even_if_fixture_was_published_at_small_scale(self):
        self.attach()
        report = inspect_volume(self.data)
        self.assertFinding(report, "结构体维度")
