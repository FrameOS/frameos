#!/usr/bin/env python3
"""A font as an ESP32 reads it off its SD card: a TrueType file, nothing else.

An ESP32 frame reads every font in `{assets}/fonts` where it lies, a page at
a time (pixie's `fontformats/filefont.nim`, docs/esp32-fonts.md): a `.ttf`
of TrueType (`glyf`) outlines with a Unicode character map. That is what
FrameOS's own collection is and what "Sync fonts" puts on the card, and most
fonts are; this tool turns the rest into one:

- an OpenType font of PostScript outlines (`.otf`, CFF, or a `.ttf` that is
  one inside): its curves converted to TrueType quadratics (cu2qu, within
  `--max-error` font units, 1 by default: a thousandth of an em);
- a variable font: an instance (`--axis wght=700`; the default instance
  otherwise, which is what pixie draws of it anyway);
- a collection (`.ttc` / `.otc`): one file a face;
- WOFF / WOFF2 (WOFF2 needs the `brotli` module): unwrapped;
- with `--subset` (`latin`, `latin-ext`, `greek`, `cyrillic`, `ascii` or
  ranges like `U+0020-007E,U+00A0-00FF`): only those characters, a smaller
  file for a small card.

Each face is written as `<Family>-<Style>.ttf` from its name table (the name
a scene's `font-[Family]` or SVG `font-family` finds it by,
`utils/font.nim` `svgFontFileFor`), or `--out` for a single face, and read
back as the frame will: TrueType outlines, a format 4 or 12 character map,
16-bit glyph ids. Bitmap-only colour fonts (Noto Color Emoji) have no
outlines to convert and are refused.

    python3 tools/font_for_card.py MyFont.otf                 # -> ./MyFont-Regular.ttf
    python3 tools/font_for_card.py Inter.ttc --out-dir card/fonts
    python3 tools/font_for_card.py Roboto[wdth,wght].ttf --axis wght=300
    python3 tools/font_for_card.py Big.ttf --subset latin,greek --out Small.ttf
    python3 tools/font_for_card.py --check fonts/*.ttf        # exit 1 if one is not readable
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont, newTable

SUBSETS = {
    "ascii": [(0x20, 0x7E)],
    "latin": [(0x20, 0x7E), (0xA0, 0xFF), (0x131, 0x131), (0x152, 0x153), (0x2C6, 0x2C6),
              (0x2DA, 0x2DA), (0x2DC, 0x2DC), (0x2000, 0x206F), (0x20AC, 0x20AC), (0x2122, 0x2122),
              (0x2212, 0x2212), (0xFB01, 0xFB02)],
    "latin-ext": [(0x100, 0x24F), (0x1E00, 0x1EFF), (0x20A0, 0x20CF)],
    "greek": [(0x370, 0x3FF), (0x1F00, 0x1FFF)],
    "cyrillic": [(0x400, 0x52F), (0x1C80, 0x1C8F), (0x2DE0, 0x2DFF), (0xA640, 0xA69F)],
}


def problem(font: TTFont) -> str | None:
    """Why the frame cannot read this face in place, or None."""
    if "glyf" not in font or "loca" not in font:
        return "no TrueType outlines"
    tables = font["cmap"].tables if "cmap" in font else []
    if not any(t.platformID in (0, 3) and t.format in (4, 12) for t in tables):
        return "no Unicode character map of format 4 or 12"
    for table in ("head", "hhea", "maxp", "hmtx"):
        if table not in font:
            return f"no {table} table"
    return None


def to_truetype(font: TTFont, max_error: float) -> None:
    """CFF outlines to TrueType quadratics, in place (fontTools' otf2ttf)."""
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    glyph_order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, max_error, reverse_direction=True))
        glyphs[name] = pen.glyph()
    font["loca"] = newTable("loca")
    glyf = font["glyf"] = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyf.glyphs = glyphs
    for tag in ("CFF ", "CFF2", "VORG"):
        if tag in font:
            del font[tag]
    glyf.compile(font)
    hmtx = font["hmtx"]
    for name, glyph in glyphs.items():
        advance, _ = hmtx.metrics[name]
        hmtx.metrics[name] = (advance, getattr(glyph, "xMin", 0))
    maxp = font["maxp"] = newTable("maxp")
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    for field in ("maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
                  "maxStackElements", "maxSizeOfInstructions", "maxComponentElements"):
        setattr(maxp, field, 0)
    maxp.compile(font)
    post = font["post"]
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = glyph_order
    try:
        post.compile(font)
    except OverflowError:
        post.formatType = 3.0
    font.sfntVersion = "\x00\x01\x00\x00"


def instance(font: TTFont, axes: dict[str, float]) -> TTFont:
    from fontTools.varLib import instancer

    limits = {axis.axisTag: axes.get(axis.axisTag, axis.defaultValue) for axis in font["fvar"].axes}
    return instancer.instantiateVariableFont(font, limits, updateFontNames=True)


def subset(font: TTFont, spec: str) -> None:
    from fontTools import subset as ftsubset

    unicodes: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if part in SUBSETS:
            for first, last in SUBSETS[part]:
                unicodes.update(range(first, last + 1))
            continue
        m = re.fullmatch(r"(?:U\+)?([0-9A-Fa-f]+)(?:-(?:U\+)?([0-9A-Fa-f]+))?", part)
        if not m:
            raise SystemExit(f"--subset: not a range or a set: {part}")
        first = int(m.group(1), 16)
        last = int(m.group(2), 16) if m.group(2) else first
        unicodes.update(range(first, last + 1))
    options = ftsubset.Options()
    options.layout_features = ["kern"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    subsetter = ftsubset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)


def file_name(font: TTFont) -> str:
    names = font["name"]
    family = names.getDebugName(16) or names.getDebugName(1) or "Font"
    style = names.getDebugName(17) or names.getDebugName(2) or "Regular"
    clean = lambda s: re.sub(r"[^A-Za-z0-9]+", "", s)  # noqa: E731
    return f"{clean(family) or 'Font'}-{clean(style) or 'Regular'}.ttf"


def faces(path: Path) -> list[TTFont]:
    head = path.read_bytes()[:4]
    if head in (b"ttcf",):
        return list(TTCollection(str(path)).fonts)
    return [TTFont(str(path))]


def convert(path: Path, args: argparse.Namespace) -> list[Path]:
    written = []
    found = faces(path)
    if args.out and len(found) > 1:
        raise SystemExit(f"{path}: a collection of {len(found)} faces: use --out-dir")
    for font in found:
        font.flavor = None  # WOFF/WOFF2 unwrapped
        if "fvar" in font:
            font = instance(font, args.axis)
        if "glyf" not in font and ("CFF " in font or "CFF2" in font):
            to_truetype(font, args.max_error)
        if args.subset:
            subset(font, args.subset)
        why = problem(font)
        if why:
            raise SystemExit(f"{path}: {why} (bitmap-only colour fonts cannot be converted)")
        out = Path(args.out) if args.out else Path(args.out_dir) / file_name(font)
        out.parent.mkdir(parents=True, exist_ok=True)
        font.save(str(out))
        back = TTFont(str(out))
        why = problem(back)
        if why:
            raise SystemExit(f"{out}: written, but {why}")
        written.append(out)
        print(f"{path} -> {out} ({out.stat().st_size} bytes, {back['maxp'].numGlyphs} glyphs)")
    return written


def parse_axes(values: list[str]) -> dict[str, float]:
    axes = {}
    for value in values:
        tag, _, number = value.partition("=")
        if not number:
            raise SystemExit(f"--axis: expected TAG=VALUE, got {value}")
        axes[tag] = float(number)
    return axes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("fonts", nargs="+", type=Path)
    parser.add_argument("--out", help="the file to write (one face)")
    parser.add_argument("--out-dir", default=".", help="where to write <Family>-<Style>.ttf (default: here)")
    parser.add_argument("--axis", action="append", default=[], help="a variable font's instance, TAG=VALUE")
    parser.add_argument("--subset", help="characters to keep: latin, latin-ext, greek, cyrillic, ascii, U+XXXX-YYYY")
    parser.add_argument("--max-error", type=float, default=1.0, help="cu2qu's error in font units (default 1)")
    parser.add_argument("--check", action="store_true", help="only say whether each font is read in place")
    args = parser.parse_args(argv)
    args.axis = parse_axes(args.axis)
    if args.check:
        bad = 0
        for path in args.fonts:
            for font in faces(path):
                why = problem(font) if font.reader.sfntVersion != "OTTO" else "CFF outlines"
                if why:
                    bad += 1
                    print(f"{path}: {why}: convert it with this tool")
                else:
                    print(f"{path}: read in place")
        return 1 if bad else 0
    for path in args.fonts:
        convert(path, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
