"""Behavior checks for training labels and the browser promotion boundary."""

import unittest
from pathlib import Path

from train_card_yolo import (
    browser_boxes,
    detection_label,
    promotion_allowed,
    source_group,
)


class TrainingTests(unittest.TestCase):
    def test_second_nms_uses_engine_score_after_padding_is_removed(self):
        boxes = browser_boxes(
            [[320, 320, 640, 240, 0.93], [320, 320, 132, 240, 0.95]], 400, 1600
        )
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0][4], 0.95)

    def test_high_map_does_not_promote_zero_recall_detector(self):
        self.assertFalse(promotion_allowed(640, 0.97, 0.81, 0, 0))
        self.assertTrue(promotion_allowed(640, 0.99, 0.91, 0.99, 0.99))
        self.assertFalse(promotion_allowed(320, 0.99, 0.91, 0.99, 0.99))

    def test_polygons_become_detection_boxes(self):
        self.assertEqual(
            detection_label("0 0.1 0.2 0.9 0.2 0.9 0.8 0.1 0.8"),
            "0 0.500000 0.500000 0.800000 0.600000\n",
        )
        for line in [
            "0 nan .2 .3 .4",
            "1 .5 .5 .4 .4",
            "0 .1 .1 .9 .9",
            "0 .5 .5 0 .4",
            "0 .2 .4 .5",
        ]:
            with self.assertRaises(ValueError):
                detection_label(line)

    def test_front_and_back_scanner_pair_stay_together(self):
        self.assertEqual(
            source_group(Path("001_Year-Manfucturer-Card-0199.jpg"), "a"),
            source_group(Path("002_Year-Manfucturer-Card-0200.jpg"), "b"),
        )
        self.assertNotEqual(
            source_group(Path("Year-Manfucturer-Card-0200.jpg"), "a"),
            source_group(Path("Year-Manfucturer-Card-0201.jpg"), "b"),
        )

    def test_browser_validation_uses_centered_geometry_nms_and_full_card_scans(self):
        # 400x600 source, 640x640 input: horizontal padding 106.
        boxes = browser_boxes(
            [[320, 320, 426, 640, 0.95], [320, 320, 425, 639, 0.90]], 400, 600
        )
        self.assertEqual(len(boxes), 1)
        self.assertAlmostEqual(boxes[0][2], 400, delta=1)
        self.assertEqual(boxes[0][3], 600)
        self.assertEqual(browser_boxes([[320, 320, 426, 640, 0.14]], 400, 600), [])


if __name__ == "__main__":
    unittest.main()
