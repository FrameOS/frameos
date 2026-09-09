"""Pins scripts/frameos-setup.sh's release default to versions.json.

Pure Python, no Docker: ``python3 -m unittest scripts.tests.test_setup_script_defaults``
from the repo root (the "Standalone setup script" CI job runs it before the
container tests).

The script installs FRAMEOS_RELEASE_VERSION_DEFAULT when nobody passes a
version. cloud.frameos.net/install.sh stamps the newest GitHub release over
that line at serve time, but the raw script from the repo does not get that
treatment — and its pin once sat nine releases stale, installing a build whose
binary no longer matched the systemd unit the script writes. versions.json's
``docker`` entry is the release tag (docker-publish-multi.yml), so the default
must be that base version.
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETUP_SCRIPT = ROOT / "scripts" / "frameos-setup.sh"
VERSIONS_FILE = ROOT / "versions.json"

DEFAULT_LINE = re.compile(
    r'^FRAMEOS_RELEASE_VERSION_DEFAULT="(?P<version>[^"]*)"\s*# __FRAMEOS_RELEASE_VERSION_DEFAULT__\s*$',
    re.MULTILINE,
)


def setup_script_default_version() -> str:
    match = DEFAULT_LINE.search(SETUP_SCRIPT.read_text(encoding="utf-8"))
    if match is None:
        raise AssertionError(
            "scripts/frameos-setup.sh has no FRAMEOS_RELEASE_VERSION_DEFAULT line carrying the "
            "__FRAMEOS_RELEASE_VERSION_DEFAULT__ anchor (the cloud's install.sh route stamps that anchor)"
        )
    return match.group("version")


def released_version() -> str:
    versions = json.loads(VERSIONS_FILE.read_text(encoding="utf-8"))
    return versions["docker"].split("+", 1)[0]


class SetupScriptDefaultsTest(unittest.TestCase):
    def test_default_release_version_is_the_current_release(self):
        self.assertEqual(
            setup_script_default_version(),
            released_version(),
            "scripts/frameos-setup.sh pins a release that is not versions.json's `docker` entry; "
            "update FRAMEOS_RELEASE_VERSION_DEFAULT (tools/update_versions.py rewrites it on release)",
        )

    def test_default_is_a_plain_calver_version(self):
        # It lands inside a double-quoted shell assignment, and the cloud
        # route only accepts the same shape from GitHub.
        self.assertRegex(setup_script_default_version(), r"^\d{4}\.\d{1,2}\.\d+$")


if __name__ == "__main__":
    unittest.main()
