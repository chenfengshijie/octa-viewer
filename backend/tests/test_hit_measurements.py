"""Native-coordinate and agreement regressions with known, hand-counted masks."""

from io import BytesIO
from unittest import TestCase

import numpy as np
from PIL import Image

from app.hit import agreement, catalog, imaging, measurements, spatial
from tests.hit_fixtures import AUTHOR, DataVolume, make_run, standard_mask


class PixelAgreement(TestCase):
    def test_two_empty_masks_count_as_exact_agreement(self):
        empty = np.zeros((3, 5), bool)
        result = imaging.counts(empty, empty)
        self.assertEqual(result["dice"], 1)
        self.assertEqual(result["iou"], 1)
        self.assertEqual(result["added"], 0)
        self.assertEqual(result["reference_pixels"], 0)

    def test_direction_changes_counts_but_not_overlap(self):
        first = np.array([[True, False, True], [False, False, False]])
        second = np.array([[True, True, False], [True, False, False]])
        result = imaging.counts(first, second)
        reverse = imaging.counts(second, first)
        self.assertEqual(result["shared"], 1)
        self.assertEqual(result["erased"], 1)
        self.assertEqual(result["added"], 2)
        self.assertEqual(result["dice"], 2 / 5)
        self.assertEqual(result["iou"], 1 / 4)
        self.assertEqual(reverse["dice"], result["dice"])
        self.assertEqual(reverse["erased"], result["added"])
        self.assertEqual(reverse["added"], result["erased"])

    def test_only_one_empty_mask_has_zero_overlap(self):
        empty = np.zeros((2, 3), bool)
        full = np.ones((2, 3), bool)
        for a, b in ((empty, full), (full, empty)):
            with self.subTest(foreground=a.any()):
                metrics = imaging.counts(a, b)
                self.assertEqual(metrics["dice"], 0)
                self.assertEqual(metrics["iou"], 0)
                self.assertEqual(metrics["erased"] + metrics["added"], 6)

    def test_visual_classes_have_the_same_direction_as_numeric_metrics(self):
        ref = np.array([[True, True, False, False]])
        target = np.array([[True, False, True, False]])
        with Image.open(BytesIO(imaging.difference(ref, target))) as image:
            colors = np.asarray(image)[0]
        self.assertEqual(colors[3, 3], 0)
        self.assertGreater(colors[0, 3], 0)
        self.assertGreater(colors[1, 0], colors[1, 1])
        self.assertGreater(colors[2, 1], colors[2, 0])

    def test_threshold_uses_strict_greater_than(self):
        values = np.array([[0, 0.5, 1]], np.float32)
        with Image.open(BytesIO(imaging.threshold_mask(values, 0.5))) as img:
            self.assertEqual(np.array(img).tolist(), [[0, 0, 255]])
        self.assertEqual(measurements.probability_summary(values, values > 0, 0.5)["selected"], 1)

    def test_histogram_includes_one_in_last_bin(self):
        values = np.array([[0, 0.5, 1]], np.float32)
        summary = measurements.probability_summary(values, values > 0, 0)
        self.assertEqual(sum(bin["count"] for bin in summary["bins"]), 3)
        self.assertEqual(summary["bins"][-1]["count"], 1)
        self.assertEqual(summary["bins"][0]["count"], 1)
        self.assertEqual(summary["probability"]["median"], 0.5)

    def test_connected_regions_include_diagonal_and_exclusive_bounds(self):
        ref = np.zeros((5, 7), bool)
        target = ref.copy()
        target[0, 0] = True
        target[1, 1] = True
        target[4, 6] = True
        regions = measurements.changed_regions(ref, target)
        self.assertEqual([item["pixels"] for item in regions], [2, 1])
        self.assertEqual(regions[0]["bounds"], [0, 0, 2, 2])
        self.assertEqual(regions[1]["bounds"], [6, 4, 7, 5])
        self.assertEqual(measurements.changed_regions(ref, target, min_area=2), regions[:1])

    def test_touching_added_and_erased_are_independent_components(self):
        ref = np.array([[True, False]])
        target = np.array([[False, True]])
        regions = measurements.changed_regions(ref, target)
        self.assertEqual(
            [(row["kind"], row["x"]) for row in regions], [("erased", 0), ("added", 1)]
        )

    def test_region_marker_lies_on_a_changed_pixel_in_a_ring(self):
        before = np.zeros((7, 7), bool)
        after = np.ones_like(before)
        after[1:-1, 1:-1] = False
        (region,) = measurements.changed_regions(before, after)
        self.assertTrue(after[region["y"], region["x"]])
        self.assertEqual(region["pixels"], 24)

    def test_zero_thickness_span_has_a_defined_color(self):
        slab = np.full((3, 4), 30, np.int16)
        with Image.open(BytesIO(measurements.thickness_map(slab))) as image:
            colors = np.asarray(image)
        self.assertEqual(colors.shape, (3, 4, 3))
        self.assertEqual(len(np.unique(colors.reshape(-1, 3), axis=0)), 1)


class LocalWindow(TestCase):
    def test_crop_shifts_into_bounds_at_four_corners(self):
        for x, y, left, top in (
            (0, 0, 0, 0),
            (447, 0, 383, 0),
            (0, 447, 0, 383),
            (447, 447, 383, 383),
        ):
            with self.subTest(x=x, y=y):
                win = spatial.Window.centered(x, y, 65)
                self.assertEqual(win.as_list(), [left, top, left + 65, top + 65])
                self.assertTrue(win.left <= x < win.right)
                self.assertTrue(win.top <= y < win.bottom)

    def test_full_viewport_is_independent_of_marker(self):
        first = spatial.Window.centered(12, 42, 448)
        second = spatial.Window.centered(400, 407, 448)
        self.assertEqual(first, second)
        self.assertEqual(first.as_list(), [0, 0, 448, 448])

    def test_coordinates_follow_x_column_y_row_convention(self):
        rows, cols = np.indices((448, 448))
        window = spatial.Window.centered(300, 100, 1)
        self.assertEqual(window.cut(cols)[0, 0], 300)
        self.assertEqual(window.cut(rows)[0, 0], 100)

    def test_local_agreement_ignores_changes_outside_window(self):
        a = np.zeros((10, 10), bool)
        b = a.copy()
        b[0, 0] = b[-1, -1] = True
        probs = np.zeros(a.shape, np.float32)
        probs[0, 0] = 0.75
        result = spatial.regional_metrics(a, b, probs, spatial.Window(0, 0, 5, 5))
        self.assertEqual(result["pixels"], 25)
        self.assertEqual(result["metrics"]["added"], 1)
        self.assertEqual(result["changed_probability"]["mean"], 0.75)

    def test_unchanged_region_has_no_changed_pixel_distribution(self):
        a = np.ones((4, 4), bool)
        result = spatial.regional_metrics(a, a, a.astype(np.float32), spatial.Window(0, 0, 4, 4))
        self.assertIsNone(result["changed_probability"])


class BatchAgreement(DataVolume):
    def summaries(self, author=None, reference=None):
        items = list(catalog.records())
        with self.connection() as db:
            return agreement.compare_cohort(db, items, author, reference)

    def test_original_is_used_when_there_is_only_one_author(self):
        version = self.revision()
        data = self.summaries()
        (row,) = data["rows"]
        self.assertEqual(row["reference"], catalog.ORIGINAL)
        self.assertEqual(row["target"], version)
        self.assertEqual(row["added"], 18)
        self.assertEqual(row["erased"], 36)
        self.assertEqual(data["mean"]["dice"], row["dice"])

    def test_latest_revision_is_pinned_at_summary_time(self):
        first = self.revision()
        before = self.summaries()
        second = self.revision(parent=first)
        after = self.summaries()
        self.assertEqual(before["rows"][0]["target"], first)
        self.assertEqual(after["rows"][0]["target"], second)

    def test_missing_target_not_counted_in_average(self):
        make_run(self.data, job="missing")
        self.revision(pixels=standard_mask())
        data = self.summaries()
        self.assertEqual(len(data["rows"]), 1)
        self.assertEqual(data["missing"][0]["job"], "missing")
        self.assertEqual(data["mean"], {"dice": 1, "iou": 1})

    def test_no_revisions_is_an_empty_cohort_not_zero_agreement(self):
        data = self.summaries()
        self.assertIsNone(data["mean"]["dice"])
        self.assertIsNone(data["distribution"]["iou"]["median"])
        self.assertFalse(data["rows"])
        self.assertEqual(len(data["missing"]), 1)

    def test_peer_comparison_is_directional_and_version_pinned(self):
        reviewer = "作者乙"
        target = self.revision(author=AUTHOR)
        before = self.revision(author=reviewer, pixels=standard_mask())
        data = self.summaries(AUTHOR, reviewer)
        (row,) = data["rows"]
        self.assertEqual(row["target"], target)
        self.assertEqual(row["reference"], before)
        self.assertEqual(row["reference_author"], reviewer)
        self.assertEqual(row["erased"], 36)
        self.assertEqual(row["added"], 18)

    def test_different_batches_of_same_case_never_form_a_pair(self):
        make_run(self.data, job="same-case")
        self.revision(author=AUTHOR)
        self.revision(author="作者乙", job="same-case")
        data = self.summaries(AUTHOR, "作者乙")
        self.assertFalse(data["rows"])
        self.assertEqual(len(data["missing"]), 2)

    def test_aggregate_means_weight_batches_equally(self):
        make_run(self.data, job="second")
        self.revision(pixels=np.zeros((448, 448), np.uint8))
        self.revision(job="second", pixels=standard_mask())
        data = self.summaries()
        self.assertEqual(data["mean"], {"dice": 0.5, "iou": 0.5})
        self.assertEqual(data["cases"], 1)
        self.assertEqual(len(data["rows"]), 2)

    def test_per_author_counts_count_runs_not_saves(self):
        self.revision()
        self.revision()
        data = self.summaries()
        self.assertEqual(data["available_authors"], [{"username": AUTHOR, "batches": 1}])
