#!/usr/bin/env python3
"""Write the font catalogue the cloud serves, from the fonts the repo ships.

FrameOS Cloud has no font store — no `Assets` table, no project uploads — so
the only fonts it can offer are the ones checked into
`frameos/assets/copied/fonts`. Reading them at request time would mean parsing
61 TTF name tables on a Node server that has no fontTools, so the metadata is
generated here (by the same code the self-hosted backend's /api/fonts answers
with) and committed as JSON.

The bytes are NOT in this manifest: `copy-font-assets.mjs` copies the .ttf
files into the cloud app's public/ at build time. This file carries what the
font picker needs to label them, plus the size the sync loop uses to skip a
font already on a frame.

    python backend/scripts/generate_font_manifest.py

Run it after adding or removing a font; `test_font_manifest.py` fails if the
committed copy no longer matches the folder.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models.fonts import gather_all_fonts_info  # noqa: E402

FONTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "frameos", "assets", "copied", "fonts")
MANIFEST_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "cloud",
    "apps",
    "auth-web",
    "src",
    "generated",
    "fonts.json",
)


def build_manifest(fonts_dir: str = FONTS_DIR) -> dict:
    """The catalogue, sorted by filename so the file has a stable diff."""
    fonts = []
    for info in gather_all_fonts_info(fonts_dir):
        entry = dict(info)
        path = os.path.join(fonts_dir, entry["file"])
        entry["size"] = os.path.getsize(path)
        fonts.append(entry)
    fonts.sort(key=lambda font: font["file"])
    return {
        "fonts": fonts,
        # A reader that finds neither bytes nor this count has a stale copy.
        "total_bytes": sum(font["size"] for font in fonts),
    }


def main() -> int:
    manifest = build_manifest()
    with open(MANIFEST_PATH, "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(
        f"Wrote {len(manifest['fonts'])} fonts "
        f"({manifest['total_bytes'] / 1_000_000:.1f} MB) to {os.path.normpath(MANIFEST_PATH)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
