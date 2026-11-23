"""Cross-check pixel geometry, threshold sweep totals and file pairing assumptions."""

from io import BytesIO
from unittest import TestCase

import numpy as np
from PIL import Image

from app.hit import catalog, imaging, measurements, spatial, thresholds
from tests.hit_fixtures import DataVolume, FILES, JOB, standard_mask


class ThresholdSweep(TestCase):
    def test_every_sweep_point_reproduces_direct_binary_comparison(self):
        scores = np.array([[0, 0.5, 0.5, 0.8], [0.4, 1, 0.9, 0.1]], np.float16).astype(np.float32)
        mask = np.array([[True, True, False, True], [False, True, False, True]])
        for point in thresholds.foreground_curve(scores, mask, [0, 0.1, 0.5, 0.55, 0.8, 1]):
            selected = scores > point["threshold"]
            direct = imaging.counts(mask, selected)
            with self.subTest(threshold=point["threshold"]):
                for key in ("added", "erased", "shared", "iou", "dice"):
                    self.assertEqual(point[key], direct[key])
                self.assertEqual(point["selected"], int(np.count_nonzero(selected)))

    def test_complete_sweep_keeps_the_archive_threshold_exactly_once(self):
        scores = np.array([[0.1, 0.25], [0.8, 0.9]], np.float32)
        levels = thresholds.sweep(scores, scores > 0.8, 0, 1, 20, 0.8)
        changes = levels["points"]
        self.assertEqual(len(changes), 21)
        self.assertEqual(sum(row["threshold"] == 0.8 for row in changes), 1)
        for low, high in zip(changes, changes[1:]):
            self.assertGreaterEqual(low["selected"], high["selected"])
            self.assertLess(low["threshold"], high["threshold"])

    def test_model_threshold_inserted_when_off_grid(self):
        scores = np.array([[0.3, 0.7]], np.float32)
        result = thresholds.sweep(scores, scores > 0.55, 0, 1, 2, 0.55)
        self.assertEqual([point["threshold"] for point in result["points"]], [0, 0.5, 0.55, 1])
        self.assertEqual(result["reference_pixels"], 1)

    def test_restricted_interval_excludes_out_of_range_model_setting(self):
        values = np.array([[0.05, 0.5, 1]], np.float32)
        result = thresholds.sweep(values, values > 0.8, 0.1, 0.3, 2, 0.8)
        self.assertEqual([point["threshold"] for point in result["points"]], [0.1, 0.2, 0.3])

    def test_highest_closed_input_and_strict_threshold_leave_no_selected_pixels(self):
        scores = np.ones((3, 3), np.float32)
        empty = np.zeros_like(scores, dtype=bool)
        (at_one,) = thresholds.foreground_curve(scores, empty, [1])
        self.assertEqual(at_one["fraction"], 0)
        self.assertEqual(at_one["iou"], 1)
        self.assertEqual(at_one["dice"], 1)

    def test_all_values_equal_low_threshold_do_not_enter_foreground(self):
        scores = np.full((3, 3), 0.5, np.float32)
        before, exact = thresholds.foreground_curve(scores, scores > 0, [0.49, 0.5])
        self.assertEqual(before["selected"], 9)
        self.assertEqual(exact["selected"], 0)
        self.assertEqual(exact["erased"], 9)


class SurfaceAndWindow(DataVolume):
    def test_depth_map_index_selects_y_then_x(self):
        item = catalog.record(JOB)
        y, x = np.indices((448, 448))
        values = (300 + y // 4 + x // 16).astype(np.int16)
        np.savez_compressed(
            self.run_dir / FILES["surfaces"], ilm=values, opl=values + 30, bm=values + 100
        )
        pos = spatial.at_position(
            item,
            standard_mask() > 0,
            standard_mask() > 0,
            np.zeros((448, 448), np.float32),
            x=16,
            y=40,
        )
        self.assertEqual(pos["depths"], {"ilm": 311, "opl": 341, "bm": 411})
        self.assertEqual(pos["intensities"]["full_projection"], 16)
        self.assertEqual(pos["intensities"]["shallow_projection"], 40)
        self.assertEqual(pos["intensities"]["deep_projection"], 56)

    def test_distance_summary_reports_location_as_x_then_y(self):
        distance = np.full((448, 448), 30, np.int16)
        distance[20, 10] = 7
        distance[390, 400] = 80
        result = measurements.slab_summary(distance)
        self.assertEqual(result["thinnest"], {"x": 10, "y": 20})
        self.assertEqual(result["thickest"], {"x": 400, "y": 390})
        self.assertEqual(result["minimum"], 7)
        self.assertEqual(result["maximum"], 80)
        self.assertEqual(result["row_medians"][20], 30)

    def test_full_distance_equals_sum_of_shallow_and_deep_distances(self):
        sheets = measurements.surfaces(catalog.record(JOB))
        upper = measurements.thickness(sheets, "shallow")
        lower = measurements.thickness(sheets, "deep")
        whole = measurements.thickness(sheets, "full")
        self.assertTrue(np.array_equal(upper + lower, whole))
        self.assertTrue(np.all(whole == 65))

    def test_invalid_surface_blocks_quantitative_inspection(self):
        data = np.zeros((448, 448), np.int16)
        np.savez_compressed(self.run_dir / FILES["surfaces"], ilm=data, opl=data + 20, bm=data + 10)
        with self.assertRaisesRegex(ValueError, "层次顺序"):
            measurements.surfaces(catalog.record(JOB))

    def test_projection_only_crop_preserves_underlying_grayscale(self):
        window = spatial.Window.centered(40, 70, 3)
        empty = np.zeros((448, 448), bool)
        data = spatial.render_crop(
            self.run_dir / FILES["full_projection"], window, empty, empty, "projection"
        )
        with Image.open(BytesIO(data)) as image:
            self.assertEqual(image.size, (3, 3))
            self.assertEqual(image.getpixel((1, 1)), (40, 40, 40))

    def test_local_diff_uses_different_colors_for_addition_and_erasure(self):
        before = np.zeros((448, 448), bool)
        after = before.copy()
        before[70, 39] = True
        after[70, 41] = True
        window = spatial.Window.centered(40, 70, 3)
        data = spatial.render_crop(
            self.run_dir / FILES["full_projection"], window, before, after, "difference"
        )
        with Image.open(BytesIO(data)) as image:
            left = image.getpixel((0, 1))
            right = image.getpixel((2, 1))
        self.assertGreater(left[0], left[1])
        self.assertGreater(right[1], right[0])

    def test_window_metrics_sample_probability_only_where_masks_differ(self):
        before = np.zeros((9, 9), bool)
        after = before.copy()
        before[4, 5] = after[3, 4] = True
        scores = np.zeros((9, 9), np.float32)
        scores[4, 5] = 0.25
        scores[3, 4] = 0.75
        stats = spatial.regional_metrics(before, after, scores, spatial.Window(2, 2, 7, 7))
        self.assertEqual(stats["changed_probability"]["mean"], 0.5)
        self.assertEqual(stats["changed_probability"]["minimum"], 0.25)
        self.assertEqual(stats["changed_probability"]["maximum"], 0.75)
        self.assertEqual(stats["metrics"]["added"], 1)
        self.assertEqual(stats["metrics"]["erased"], 1)
