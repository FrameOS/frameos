from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# The fonts a frame gets by itself (the Fonts sample's "Get fonts",
# docs/esp32-fonts.md): repo/fonts/catalog.txt, made by
# frameos/tools/generate_font_catalog.py. The frame reads it from GitHub and
# downloads every file it names straight from there, so what it names must
# parse, be TrueType files on https, and be FrameOS's own files where it says
# so. No network here: the tool checked each file when it wrote the catalog.

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "frameos" / "tools" / "generate_font_catalog.py"
CATALOG = REPO_ROOT / "repo" / "fonts" / "catalog.txt"
SHIPPED = REPO_ROOT / "frameos" / "assets" / "copied" / "fonts"

sys.path.insert(0, str(TOOL.parent))
from generate_font_catalog import FRAMEOS_BASE, parse  # noqa: E402


def test_the_catalog_parses_and_names_each_file_once():
    result = subprocess.run([sys.executable, str(TOOL), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_kind_has_families_and_each_family_a_regular():
    families = parse(CATALOG.read_text())
    assert len(families) >= 150
    kinds = {f["category"] for f in families}
    assert {"Sans Serif", "Serif", "Display", "Handwriting", "Monospace"} <= kinds
    for family in families:
        assert family["files"][0]["style"] == "Regular", family["name"]
        assert all(f["url"].startswith(("https://fonts.gstatic.com/s/", FRAMEOS_BASE)) for f in family["files"])


def test_frameos_own_fonts_are_the_shipped_files_by_name_and_size():
    own = [f for family in parse(CATALOG.read_text()) for f in family["files"] if f["url"].startswith(FRAMEOS_BASE)]
    assert own
    for f in own:
        shipped = SHIPPED / f["file"]
        assert shipped.exists(), f["file"]
        assert f["url"] == FRAMEOS_BASE + f["file"]
        assert shipped.stat().st_size == f["bytes"], f["file"]


def test_a_google_family_frameos_ships_keeps_its_file_names():
    by_name = {family["name"]: family for family in parse(CATALOG.read_text())}
    names = {f["style"]: f["file"] for f in by_name["Ubuntu"]["files"]}
    assert names["Regular"] == "Ubuntu-Regular.ttf"
    assert names["BoldItalic"] == "Ubuntu-BoldItalic.ttf"
    assert all((SHIPPED / file).exists() for file in names.values())
