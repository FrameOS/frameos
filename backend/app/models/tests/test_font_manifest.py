"""The committed font catalogue must match the fonts the repo actually ships.

`cloud/apps/auth-web/src/generated/fonts.json` is what FrameOS Cloud answers
/api/fonts with, and what its font-sync loop walks. It is generated (fontTools
lives here, not in the Node app) and committed, so nothing at build or request
time re-reads the .ttf files — which means a font added to
`frameos/assets/copied/fonts` without regenerating is invisible on the cloud,
and one removed leaves an entry whose bytes 404.

Regenerate with `python backend/scripts/generate_font_manifest.py`.
"""

from __future__ import annotations

import json
import os

from scripts.generate_font_manifest import FONTS_DIR, MANIFEST_PATH, build_manifest


def committed_manifest() -> dict:
    with open(MANIFEST_PATH) as handle:
        return json.load(handle)


def test_manifest_matches_the_fonts_folder():
    committed = committed_manifest()
    generated = build_manifest()
    assert committed == generated, (
        "cloud/apps/auth-web/src/generated/fonts.json is stale — run "
        "`python backend/scripts/generate_font_manifest.py`."
    )


def test_every_listed_font_exists_and_records_its_real_size():
    # The size is what the sync loop compares against the frame's listing to
    # decide a font is already there; a wrong one either re-pushes 700 KB
    # forever or skips a font the frame does not have.
    for font in committed_manifest()["fonts"]:
        path = os.path.join(FONTS_DIR, font["file"])
        assert os.path.isfile(path), f"{font['file']} is in the manifest but not in the folder"
        assert font["size"] == os.path.getsize(path), f"{font['file']} records the wrong size"


def test_every_font_in_the_folder_is_listed():
    listed = {font["file"] for font in committed_manifest()["fonts"]}
    on_disk = {name for name in os.listdir(FONTS_DIR) if name.lower().endswith(".ttf")}
    assert on_disk - listed == set(), "fonts on disk that the cloud would never offer"


def test_filenames_are_safe_to_put_in_a_url_and_on_a_card():
    # These names become both a URL path segment on the cloud and a filename
    # on a frame's SD card. The device sanitises what it stores; a name that
    # needed sanitising would mean the manifest and the card disagree, and the
    # sync loop would push the same font on every run.
    for font in committed_manifest()["fonts"]:
        assert font["file"] == os.path.basename(font["file"])
        for character in font["file"]:
            assert character.isalnum() or character in "._-", (
                f"{font['file']} has a character the device would rewrite"
            )
