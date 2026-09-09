"""Pins tools/update_versions.py's CalVer arithmetic.

Run from the repo root: ``python3 -m unittest tools.tests.test_update_versions``
(the "Standalone setup script" job in .github/workflows/pull-request-tests.yml).

The release workflow (docker-publish-multi.yml) computes the next version from
versions.json and today's date, tags it, and offers it to every frame. A
version that went backwards would be a fleet-wide downgrade both the ESP32 and
the Pi door refuse — so the one property that matters is monotonicity, in
every calendar position.
"""
from __future__ import annotations

import datetime as dt
import json
import unittest
from pathlib import Path

from tools.update_versions import (
    _max_base_version,
    _next_calver,
    _parse_version,
)

ROOT = Path(__file__).resolve().parents[2]
VERSIONS_FILE = ROOT / "versions.json"


def _greater(newer: str, older: str) -> bool:
    return _parse_version(newer) > _parse_version(older)


class NextCalverTest(unittest.TestCase):
    def test_first_release_ever_is_today_dot_zero(self):
        self.assertEqual(_next_calver(None, dt.date(2026, 9, 9)), "2026.9.0")
        self.assertEqual(_next_calver("", dt.date(2026, 9, 9)), "2026.9.0")

    def test_same_day_bumps_the_patch(self):
        # A second cut on the day of the first: the patch counter carries on.
        self.assertEqual(_next_calver("2026.9.0", dt.date(2026, 9, 9)), "2026.9.1")
        self.assertEqual(_next_calver("2026.9.12", dt.date(2026, 9, 9)), "2026.9.13")

    def test_same_month_bumps_the_patch(self):
        self.assertEqual(_next_calver("2026.9.3", dt.date(2026, 9, 28)), "2026.9.4")

    def test_next_month_resets_the_patch(self):
        self.assertEqual(_next_calver("2026.8.17", dt.date(2026, 9, 1)), "2026.9.0")

    def test_year_rollover_resets_the_patch(self):
        self.assertEqual(_next_calver("2026.12.4", dt.date(2027, 1, 2)), "2027.1.0")

    def test_release_cut_ahead_of_the_calendar_keeps_counting_on_its_base(self):
        # 2026.10.0 shipped in September: the next automatic cut must not
        # step back to 2026.9.N (the 2026.9.2 runtime-stamp incident class).
        self.assertEqual(_next_calver("2026.10.0", dt.date(2026, 9, 20)), "2026.10.1")
        self.assertEqual(_next_calver("2027.1.0", dt.date(2026, 12, 31)), "2027.1.1")

    def test_build_metadata_on_the_previous_version_is_ignored(self):
        previous = "2026.9.12+b31ecadd0f9487812600eb084f5b18326a719dfd"
        self.assertEqual(_next_calver(previous, dt.date(2026, 9, 9)), "2026.9.13")

    def test_next_is_strictly_greater_in_every_calendar_position(self):
        previous_versions = ["2025.12.9", "2026.1.0", "2026.8.0", "2026.9.12", "2026.10.0", "2027.1.3"]
        days = [
            dt.date(2026, 1, 1),
            dt.date(2026, 8, 31),
            dt.date(2026, 9, 1),
            dt.date(2026, 9, 9),
            dt.date(2026, 12, 31),
            dt.date(2027, 1, 1),
            dt.date(2027, 6, 15),
        ]
        for previous in previous_versions:
            for today in days:
                with self.subTest(previous=previous, today=today.isoformat()):
                    nxt = _next_calver(previous, today)
                    self.assertTrue(_greater(nxt, previous), f"{nxt} is not newer than {previous}")
                    # And a second cut on the same day is newer still.
                    self.assertTrue(_greater(_next_calver(nxt, today), nxt))


class VersionsFileRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.versions = json.loads(VERSIONS_FILE.read_text(encoding="utf-8"))

    def test_every_entry_parses(self):
        for name, value in self.versions.items():
            with self.subTest(project=name):
                year, month, patch = _parse_version(value)
                self.assertGreaterEqual(year, 2025)
                self.assertTrue(1 <= month <= 12, value)
                self.assertGreaterEqual(patch, 0)

    def test_release_and_runtime_carry_the_same_base_version(self):
        # The release workflow forces both `docker` (the release tag) and
        # `frameos` (what the runtime binary reports) onto the new version:
        # 2026.9.2 shipped a runtime still stamped 2026.9.1 and every frame
        # upgraded in a loop. Keep them equal.
        docker = self.versions["docker"].split("+", 1)[0]
        frameos = self.versions["frameos"].split("+", 1)[0]
        self.assertEqual(docker, frameos)

    def test_next_release_from_the_checked_in_file_is_newer_on_any_day(self):
        current = _max_base_version(self.versions)
        self.assertIsNotNone(current)
        for today in (dt.date.today(), dt.date(2026, 1, 1), dt.date(2030, 12, 31)):
            with self.subTest(today=today.isoformat()):
                self.assertTrue(_greater(_next_calver(current, today), current))


if __name__ == "__main__":
    unittest.main()
