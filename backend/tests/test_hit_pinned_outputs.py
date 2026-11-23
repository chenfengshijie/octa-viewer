"""Regression checks for published row measurements and durable revision receipts."""

import csv
from io import StringIO

import numpy as np

from app.hit import catalog, profiles, versioning
from app.hit.audit.database import inspect_database
from tests.hit_fixtures import AUTHOR, CASE, FILES, JOB, DataVolume, png, standard_mask


class PublishedProfiles(DataVolume):
    def setUp(self):
        super().setUp()
        ys, xs = np.indices((448, 448))
        self.ilm = (200 + ys // 8 + xs // 16).astype(np.int16)
        self.opl = (self.ilm + 20 + xs // 32).astype(np.int16)
        self.bm = (self.opl + 45 + ys // 32).astype(np.int16)
        np.savez_compressed(
            self.run_dir / FILES["surfaces"], ilm=self.ilm, opl=self.opl, bm=self.bm
        )
        self.record = catalog.record(JOB)

    def read(self, y):
        profile = profiles.row_profile(self.record, y)
        text = profiles.csv_profile(self.record, y, profile)
        return list(csv.DictReader(StringIO(text)))

    def test_csv_row_shape_and_identity(self):
        data = self.read(240)
        self.assertEqual(len(data), 448)
        self.assertEqual(list(data[0]), list(profiles.FIELDS))
        self.assertEqual({row["case_id"] for row in data}, {CASE})
        self.assertEqual({row["job_id"] for row in data}, {JOB})
        self.assertEqual({row["y"] for row in data}, {"240"})
        self.assertEqual([int(row["x"]) for row in data], list(range(448)))

    def test_corner_locations_are_not_interchanged(self):
        first = self.read(0)[447]
        second = self.read(447)[0]
        self.assertEqual(int(first["ilm_z"]), int(self.ilm[0, 447]))
        self.assertEqual(int(second["ilm_z"]), int(self.ilm[447, 0]))
        self.assertNotEqual(first["ilm_z"], second["ilm_z"])

    def test_readings_match_downloaded_curve_for_every_column(self):
        y = 220
        profile = profiles.row_profile(self.record, y)
        exported = self.read(y)
        names = {"ilm": "ilm_z", "opl": "opl_proxy_z", "bm": "bm_z"}
        for name, column in names.items():
            self.assertEqual(profile[name], [int(row[column]) for row in exported])

    def test_native_thickness_is_difference_of_native_depths(self):
        for row in self.read(447):
            ilm = int(row["ilm_z"])
            opl = int(row["opl_proxy_z"])
            bm = int(row["bm_z"])
            self.assertEqual(int(row["shallow_depth_px"]), opl - ilm)
            self.assertEqual(int(row["deep_depth_px"]), bm - opl)
            self.assertEqual(int(row["full_depth_px"]), bm - ilm)

    def test_export_refuses_to_measure_a_reversed_surface(self):
        self.bm[17, 29] = self.ilm[17, 29]
        np.savez_compressed(
            self.run_dir / FILES["surfaces"], ilm=self.ilm, opl=self.opl, bm=self.bm
        )
        with self.assertRaisesRegex(ValueError, "曲面"):
            self.read(17)


class SaveReceipts(DataVolume):
    def setUp(self):
        super().setUp()
        self.version = versioning.save(
            JOB, AUTHOR, png(standard_mask()), guarded=True, request_id="a" * 32
        )

    def test_receipt_does_not_need_to_be_current(self):
        versioning.reset(JOB, AUTHOR, self.version)
        report = inspect_database(self.dbfile)
        self.assertClean(report)
        self.assertEqual(report.facts["保存回执"], 1)
        self.assertEqual(report.facts["当前个人版本"], 0)

    def test_receipt_cannot_be_claimed_by_another_user(self):
        with self.connection() as db:
            db.execute("UPDATE saves SET username='其他作者'")
        self.assertFinding(inspect_database(self.dbfile), "保存回执与版本作者不符")

    def test_receipt_cannot_be_claimed_by_another_batch(self):
        with self.connection() as db:
            db.execute("UPDATE saves SET job='another-run'")
        self.assertFinding(inspect_database(self.dbfile), "保存回执与版本批次不符")

    def test_receipt_fingerprint_has_digest_format(self):
        with self.connection() as db:
            db.execute("UPDATE saves SET fingerprint='truncated'")
        self.assertFinding(inspect_database(self.dbfile), "应是 SHA-256")

    def test_earlier_snapshot_can_be_inspected_without_receipts(self):
        with self.connection() as db:
            db.execute("DROP TABLE saves")
            db.execute("PRAGMA user_version=0")
        self.assertClean(inspect_database(self.dbfile))

    def test_current_schema_verifies_receipt_table(self):
        with self.connection() as db:
            db.execute("DROP TABLE saves")
        self.assertFinding(inspect_database(self.dbfile), "缺少保存回执表")
