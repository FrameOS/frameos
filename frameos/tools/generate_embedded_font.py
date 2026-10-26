#!/usr/bin/env python3
"""The default font every runtime compiles in, without the tables pixie never reads.

`assets/copied/fonts/Ubuntu-Regular.ttf` is the original, the one frames get
as an asset. `assets/compiled/fonts/Ubuntu-Regular.ttf` is made from it here
and compiled into the Pi runtime, the wasm preview and the ESP32 firmware
(`src/assets/fonts.nim`).

pixie draws outlines with its own rasterizer and reads `cmap`, `head`, `hhea`,
`maxp`, `hmtx`, `name`, `OS/2`, `loca`, `glyf`, `kern`, the pair positioning
lookups of `GPOS` and the `post` header. The original also carries TrueType
hinting (`fpgm`, `prep`, `cvt ` and the instructions inside every glyph),
`hdmx`, `VDMX`, `GSUB`, `gasp` and glyph names: half the file, and about
88 KB of every ESP32 image.

The Ubuntu Font Licence (clause 2c) names a modified copy "Ubuntu derivative
X", so the `name` table says "Ubuntu derivative FrameOS". FrameOS finds the
font by its file name, which stays.

`--check` compares the committed file with the original the way pixie reads
both: the same codepoints, outlines, advances, vertical metrics and kerning.

    python3 tools/generate_embedded_font.py          # write the compiled font
    python3 tools/generate_embedded_font.py --check  # exit 1 if it drifted
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

FRAMEOS_ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = FRAMEOS_ROOT / "assets" / "copied" / "fonts" / "Ubuntu-Regular.ttf"
COMPILED = FRAMEOS_ROOT / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.ttf"

DROPPED_TABLES = ["hdmx", "VDMX", "GSUB", "DSIG", "LTSH", "PCLT", "gasp"]
HINTING_TABLES = {"fpgm", "prep", "cvt ", "cvar", "hdmx", "VDMX", "LTSH"}

FAMILY = "Ubuntu derivative FrameOS"
POSTSCRIPT = "UbuntuderivativeFrameOS-Regular"


def renamed(record_id: int, text: str) -> str:
    if record_id == 1:
        return FAMILY
    if record_id == 3:
        return text.replace("DAMA;Ubuntu-Regular", f"FrameOS;{POSTSCRIPT}")
    if record_id == 4:
        return f"{FAMILY} Regular"
    if record_id == 6:
        return POSTSCRIPT
    return text


def build(original: Path) -> bytes:
    font = TTFont(original, recalcTimestamp=False)
    options = subset.Options()
    options.hinting = False
    options.glyph_names = False
    options.notdef_outline = True
    options.recalc_bounds = False
    options.recalc_timestamp = False
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.legacy_kern = True
    options.layout_features = ["kern"]
    options.prune_unicode_ranges = False
    options.drop_tables = DROPPED_TABLES
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=font.getBestCmap().keys())
    subsetter.subset(font)
    for record in font["name"].names:
        record.string = renamed(record.nameID, record.toUnicode())
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def outline(font: TTFont, glyph_name: str) -> tuple:
    glyf = font["glyf"]
    coords, end_points, flags = glyf[glyph_name].getCoordinates(glyf)
    on_curve = [flag & 1 for flag in flags]
    return (tuple(map(tuple, coords)), tuple(end_points), tuple(on_curve))


def kerning(font: TTFont) -> dict[tuple[int, int], int]:
    """The x advance pixie adds between two codepoints: the first pair
    positioning subtable, in lookup order, covering the left glyph with a
    nonzero entry for the pair (`getKerningAdjustment`)."""
    by_glyph: dict[str, list[int]] = {}
    for codepoint, glyph_name in font.getBestCmap().items():
        by_glyph.setdefault(glyph_name, []).append(codepoint)
    pairs: dict[tuple[int, int], int] = {}

    def put(left: int, right: int, value: int) -> None:
        if value and (left, right) not in pairs:
            pairs[(left, right)] = value

    if "GPOS" not in font:
        return pairs
    for lookup in font["GPOS"].table.LookupList.Lookup:
        if lookup.LookupType != 2:
            continue
        for table in lookup.SubTable:
            if not (getattr(table, "ValueFormat1", 0) & 0x4):
                continue
            coverage = table.Coverage.glyphs
            if table.Format == 1:
                for glyph_name, pair_set in zip(coverage, table.PairSet):
                    for record in pair_set.PairValueRecord:
                        value = record.Value1.XAdvance if record.Value1 else 0
                        for left in by_glyph.get(glyph_name, []):
                            for right in by_glyph.get(record.SecondGlyph, []):
                                put(left, right, value)
            elif table.Format == 2:
                class1 = table.ClassDef1.classDefs if table.ClassDef1 else {}
                class2 = table.ClassDef2.classDefs if table.ClassDef2 else {}
                right_by_class: dict[int, list[int]] = {}
                for glyph_name, cps in by_glyph.items():
                    right_by_class.setdefault(class2.get(glyph_name, 0), []).extend(cps)
                for glyph_name in coverage:
                    row = table.Class1Record[class1.get(glyph_name, 0)].Class2Record
                    for class_index, record in enumerate(row):
                        value = record.Value1.XAdvance if record.Value1 else 0
                        if not value:
                            continue
                        for left in by_glyph.get(glyph_name, []):
                            for right in right_by_class.get(class_index, []):
                                put(left, right, value)
    return pairs


def metrics(font: TTFont) -> tuple:
    head, hhea, os2 = font["head"], font["hhea"], font["OS/2"]
    return (
        head.unitsPerEm,
        hhea.ascent,
        hhea.descent,
        hhea.lineGap,
        os2.sTypoAscender,
        os2.sTypoDescender,
        os2.sTypoLineGap,
        os2.usWinAscent,
        os2.usWinDescent,
        os2.fsSelection,
    )


def differences(original_bytes: bytes, compiled_bytes: bytes) -> list[str]:
    original = TTFont(io.BytesIO(original_bytes))
    compiled = TTFont(io.BytesIO(compiled_bytes))
    problems: list[str] = []

    left_cmap, right_cmap = original.getBestCmap(), compiled.getBestCmap()
    if set(left_cmap) != set(right_cmap):
        problems.append(f"codepoints differ: {len(left_cmap)} in the original, {len(right_cmap)} compiled")
    left_hmtx, right_hmtx = original["hmtx"].metrics, compiled["hmtx"].metrics
    glyph_pairs = [(".notdef", ".notdef")] + [
        (left_cmap[cp], right_cmap[cp]) for cp in sorted(set(left_cmap) & set(right_cmap))
    ]
    for left_name, right_name in glyph_pairs:
        if outline(original, left_name) != outline(compiled, right_name):
            problems.append(f"outline of {left_name} differs")
        if left_hmtx[left_name][0] != right_hmtx[right_name][0]:
            problems.append(f"advance of {left_name} differs")
    if metrics(original) != metrics(compiled):
        problems.append("vertical metrics differ")
    left_kern, right_kern = kerning(original), kerning(compiled)
    if left_kern != right_kern:
        changed = sum(1 for pair in left_kern.keys() | right_kern.keys() if left_kern.get(pair) != right_kern.get(pair))
        problems.append(f"{changed} kerning pairs differ")

    names = {record.nameID: record.toUnicode() for record in compiled["name"].names}
    if names.get(1) != FAMILY or names.get(6) != POSTSCRIPT:
        problems.append(f"the name table must say {FAMILY!r} (Ubuntu Font Licence 2c)")
    hinting = sorted(HINTING_TABLES & set(compiled.keys()))
    if hinting:
        problems.append(f"hinting tables left in: {', '.join(hinting)}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="compare the committed font with the original")
    args = parser.parse_args()

    original_bytes = ORIGINAL.read_bytes()
    if args.check:
        problems = differences(original_bytes, COMPILED.read_bytes())
        for problem in problems:
            print(f"{COMPILED.relative_to(FRAMEOS_ROOT)}: {problem}", file=sys.stderr)
        if problems:
            print("Run python3 frameos/tools/generate_embedded_font.py", file=sys.stderr)
        return 1 if problems else 0

    compiled_bytes = build(ORIGINAL)
    problems = differences(original_bytes, compiled_bytes)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    COMPILED.write_bytes(compiled_bytes)
    print(f"{COMPILED.relative_to(FRAMEOS_ROOT)}: {len(original_bytes)} -> {len(compiled_bytes)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
