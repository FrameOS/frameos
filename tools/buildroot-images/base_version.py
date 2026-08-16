#!/usr/bin/env python3
"""Resolve the FrameOS version a Buildroot base image is published under.

Split out of buildroot_images.py so CI can resolve the version WITHOUT
installing backend/requirements.txt: importing buildroot_images drags in the
whole backend app (app.tasks.buildroot_image and friends), which is a minute of
pip for a job whose only output is a version string. Everything here is
stdlib + tools/update_versions.py, so `python3 tools/buildroot-images/base_version.py`
works on a bare checkout.

buildroot_images.py re-exports these, so there is still exactly one
implementation.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
# tools/ holds update_versions.py, whose CalVer helpers decide what the next
# release is called; base images are stamped with that (see
# next_frameos_version) rather than duplicating the rules here.
sys.path.insert(0, str(REPO_ROOT / "tools"))

from update_versions import (  # noqa: E402
    _max_base_version,
    _next_calver,
    _validate_base_version,
)


def published_frameos_version(version: str) -> str:
    return version.split("+", 1)[0]


def next_frameos_version() -> str:
    """The version a base image is published under.

    Base images are stamped with the version of the release they are FOR, not
    the one that happens to be current while CI builds them: the workflow
    order is publish base images -> merge the manifest -> bump versions ->
    release, so by the time anything consumes these images the current version
    is this one. Stamping the current version instead left every fresh base
    image looking a release behind, and the SD builder's version-match then
    fell through to "newest entry" instead of an exact hit.

    FRAMEOS_NEXT_VERSION pins it explicitly, matching the release workflow's
    own `next_version` input — pass the same value to both when overriding.
    The computed default reuses tools/update_versions.py so the CalVer rules
    cannot drift from the bump that will actually happen.
    """
    override = (os.environ.get("FRAMEOS_NEXT_VERSION") or "").strip()
    if override:
        return published_frameos_version(_validate_base_version(override))
    payload = json.loads((REPO_ROOT / "versions.json").read_text(encoding="utf-8"))
    versions = {key: str(value) for key, value in payload.items() if value}
    return _next_calver(_max_base_version(versions), dt.date.today())


if __name__ == "__main__":
    print(next_frameos_version())
