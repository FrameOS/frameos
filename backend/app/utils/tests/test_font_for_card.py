from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

# An ESP32 reads every font on its SD card where it lies: a TrueType file of
# glyf outlines (pixie's fontformats/filefont.nim, docs/esp32-fonts.md).
# frameos/tools/font_for_card.py turns what is not one into one; FrameOS's own
# collection (what "Sync fonts" copies) already is, bar the emoji bitmaps.

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "frameos" / "tools" / "font_for_card.py"
CFF_FONT = REPO_ROOT / "frameos" / "pixie" / "tests" / "fonts" / "Inter-Bold.ttf"  # CFF inside
SHIPPED = REPO_ROOT / "frameos" / "assets" / "copied" / "fonts"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True)


def test_every_shipped_font_but_the_emoji_bitmaps_is_read_in_place():
    fonts = sorted(str(p) for p in SHIPPED.glob("*.ttf") if p.name != "NotoColorEmoji.ttf")
    assert len(fonts) >= 60
    result = run("--check", *fonts)
    assert result.returncode == 0, result.stdout + result.stderr
    assert run("--check", str(SHIPPED / "NotoColorEmoji.ttf")).returncode == 1


def test_a_cff_font_becomes_truetype_with_the_same_characters(tmp_path):
    assert run("--check", str(CFF_FONT)).returncode == 1
    result = run(str(CFF_FONT), "--out-dir", str(tmp_path))
    assert result.returncode == 0, result.stderr
    out = tmp_path / "Inter-Bold.ttf"
    assert out.exists()
    assert run("--check", str(out)).returncode == 0
    before = TTFont(str(CFF_FONT))
    after = TTFont(str(out))
    assert "glyf" in after and "CFF " not in after
    assert after.getBestCmap() == before.getBestCmap()
    assert after["maxp"].numGlyphs == before["maxp"].numGlyphs
    name = before.getBestCmap()[ord("A")]
    assert after["hmtx"][name][0] == before["hmtx"][name][0]


def test_a_subset_keeps_only_what_it_names(tmp_path):
    out = tmp_path / "Small.ttf"
    result = run(str(SHIPPED / "Galindo-Regular.ttf"), "--subset", "ascii", "--out", str(out))
    assert result.returncode == 0, result.stderr
    cmap = TTFont(str(out)).getBestCmap()
    assert set(cmap) <= set(range(0x20, 0x7F))
    assert ord("A") in cmap
