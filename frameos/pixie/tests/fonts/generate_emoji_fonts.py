#!/usr/bin/env python3
"""Generates the tiny color emoji test fonts used by test_fonts.nim.

Each font maps U+1F600 (grinning face), U+2764 (heavy black heart),
U+2B50 (star), U+1F319 (crescent moon) and U+2600 (sun) and stores the
color glyphs in a different OpenType color format:

  EmojiColr.ttf - COLR/CPAL layered vector glyphs
  EmojiCbdt.ttf - CBDT/CBLC embedded PNG bitmaps (no glyf table, like
                  Noto Color Emoji)
  EmojiSbix.ttf - sbix embedded PNG bitmaps (like Apple Color Emoji)

tests/fonts/TwemojiMozilla-subset.ttf is a real-world COLRv0 color emoji
font (Twemoji Mozilla, CC-BY 4.0 Twitter emoji graphics). It is produced
from https://github.com/mozilla/twemoji-colr/releases (Twemoji.Mozilla.ttf,
v0.7.0) with:

  pyftsubset Twemoji.Mozilla.ttf \
    --output-file=tests/fonts/TwemojiMozilla-subset.ttf \
    --unicodes="1F600,1F602,2764,FE0F,1F44D,1F389,1F30D,1F355,1F680,2B50,\
1F319,2600,1F436,1F431,1F98A,1F354,26BD,1F3B8,1F4A1,2705,1F525" \
    --no-layout-closure

Requires: pip install fonttools pillow
"""

import math
import struct

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.sbixGlyph import Glyph as SbixGlyph
from fontTools.ttLib.tables.sbixStrike import Strike as SbixStrike
from fontTools.ttLib.tables.DefaultTable import DefaultTable
from PIL import Image, ImageDraw

UPM = 1000
ASCENT = 800
DESCENT = -200
PPEM = 64

EMOJI_NAMES = ["smiley", "heart", "star", "moon", "sun"]
CMAP = {
    0x1F600: "smiley",
    0x2764: "heart",
    0x2B50: "star",
    0x1F319: "moon",
    0x2600: "sun",
}


def circle(pen, cx, cy, r, clockwise=True):
    # A circle approximated with four TrueType quadratic arcs. Clockwise by
    # default like rect() and heart_shape(), so that overlapping contours
    # within a glyph add up instead of cancelling under non-zero filling.
    # A counterclockwise circle subtracts (cuts a hole) instead.
    pen.moveTo((cx + r, cy))
    if clockwise:
        pen.qCurveTo((cx + r, cy - r), (cx, cy - r))
        pen.qCurveTo((cx - r, cy - r), (cx - r, cy))
        pen.qCurveTo((cx - r, cy + r), (cx, cy + r))
        pen.qCurveTo((cx + r, cy + r), (cx + r, cy))
    else:
        pen.qCurveTo((cx + r, cy + r), (cx, cy + r))
        pen.qCurveTo((cx - r, cy + r), (cx - r, cy))
        pen.qCurveTo((cx - r, cy - r), (cx, cy - r))
        pen.qCurveTo((cx + r, cy - r), (cx + r, cy))
    pen.closePath()


def star_points(cx, cy, r):
    pts = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        rad = r if i % 2 == 0 else r * 0.4
        pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    return pts


def star_shape(pen, cx, cy, r):
    pts = [(round(x), round(y)) for x, y in reversed(star_points(cx, cy, r))]
    pen.moveTo(pts[0])
    for pt in pts[1:]:
        pen.lineTo(pt)
    pen.closePath()


def moon_shape(pen, cx, cy, r):
    # A crescent as a single contour: the left half of a circle closed with
    # an inward arc. Two overlapping circles cannot express a crescent under
    # non-zero winding (the cutter fills wherever it leaves the outer circle).
    top = (cx, cy + r)
    bottom = (cx, cy - r)
    pen.moveTo(top)
    pen.qCurveTo((cx - r, cy + r), (cx - r, cy))
    pen.qCurveTo((cx - r, cy - r), bottom)
    pen.qCurveTo((cx - r * 0.35, cy - r * 0.6), (cx - r * 0.35, cy))
    pen.qCurveTo((cx - r * 0.35, cy + r * 0.6), top)
    pen.closePath()


def sun_rays_shape(pen, cx, cy, r1, r2):
    # Eight triangular rays pointing outward.
    for i in range(8):
        a = i * math.pi / 4
        tip = (cx + r2 * math.cos(a), cy + r2 * math.sin(a))
        base1 = (cx + r1 * math.cos(a - 0.2), cy + r1 * math.sin(a - 0.2))
        base2 = (cx + r1 * math.cos(a + 0.2), cy + r1 * math.sin(a + 0.2))
        pen.moveTo((round(tip[0]), round(tip[1])))
        pen.lineTo((round(base1[0]), round(base1[1])))
        pen.lineTo((round(base2[0]), round(base2[1])))
        pen.closePath()


def rect(pen, x, y, w, h):
    pen.moveTo((x, y))
    pen.lineTo((x, y + h))
    pen.lineTo((x + w, y + h))
    pen.lineTo((x + w, y))
    pen.closePath()


def heart_shape(pen, cx, cy, s):
    # A simple heart from a triangle and two circles.
    pen.moveTo((cx - s, cy + s * 0.35))
    pen.lineTo((cx + s, cy + s * 0.35))
    pen.lineTo((cx, cy - s))
    pen.closePath()
    circle(pen, cx - s * 0.48, cy + s * 0.35, s * 0.52)
    circle(pen, cx + s * 0.48, cy + s * 0.35, s * 0.52)


def build_glyph(draw_func):
    pen = TTGlyphPen(None)
    draw_func(pen)
    return pen.glyph()


def empty_glyph():
    return TTGlyphPen(None).glyph()


def base_font(fb_glyphs):
    """Builds the common font scaffolding shared by all three test fonts."""
    glyph_order = [".notdef"] + list(fb_glyphs.keys())
    fb = FontBuilder(UPM)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap(CMAP)
    glyphs = {".notdef": empty_glyph()}
    glyphs.update(fb_glyphs)
    fb.setupGlyf(glyphs)
    metrics = {}
    for name in glyph_order:
        advance = UPM if name != ".notdef" else 500
        metrics[name] = (advance, 0)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT)
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=DESCENT,
                usWinAscent=ASCENT, usWinDescent=-DESCENT)
    fb.setupPost()
    return fb


def name_font(fb, family):
    fb.setupNameTable({"familyName": family, "styleName": "Regular"})


# ---------------------------------------------------------------- COLR/CPAL

def build_colr():
    s = 300  # smiley radius / heart size
    cx, cy = 500, 300

    glyphs = {
        # Fallback monochrome outlines for the base glyphs.
        "smiley": build_glyph(lambda p: circle(p, cx, cy, s)),
        "heart": build_glyph(lambda p: heart_shape(p, cx, cy, s * 0.8)),
        "star": build_glyph(lambda p: star_shape(p, cx, cy, s)),
        "moon": build_glyph(lambda p: moon_shape(p, cx, cy, s * 0.9)),
        "sun": build_glyph(lambda p: circle(p, cx, cy, s * 0.55)),
        # Color layers.
        "smiley_face": build_glyph(lambda p: circle(p, cx, cy, s)),
        "smiley_eyes": build_glyph(lambda p: (
            circle(p, cx - 120, cy + 90, 50), circle(p, cx + 120, cy + 90, 50))),
        "smiley_mouth": build_glyph(lambda p: rect(p, cx - 150, cy - 160, 300, 80)),
        "heart_fill": build_glyph(lambda p: heart_shape(p, cx, cy, s * 0.8)),
        "heart_accent": build_glyph(lambda p: rect(p, cx - 60, cy - 290, 120, 60)),
        "star_fill": build_glyph(lambda p: star_shape(p, cx, cy, s)),
        "moon_fill": build_glyph(lambda p: moon_shape(p, cx, cy, s * 0.9)),
        "sun_rays": build_glyph(lambda p: sun_rays_shape(p, cx, cy, s * 0.7, s)),
        "sun_disk": build_glyph(lambda p: circle(p, cx, cy, s * 0.55)),
    }

    fb = base_font(glyphs)
    name_font(fb, "Emoji Colr Test")

    fb.setupCOLR({
        "smiley": [("smiley_face", 0), ("smiley_eyes", 1), ("smiley_mouth", 2)],
        # The 0xFFFF palette index means "use the text color".
        "heart": [("heart_fill", 3), ("heart_accent", 0xFFFF)],
        "star": [("star_fill", 4)],
        "moon": [("moon_fill", 5)],
        "sun": [("sun_rays", 6), ("sun_disk", 0)],
    })
    fb.setupCPAL([[
        (1.00, 0.80, 0.10, 1.0),  # 0 yellow face
        (0.25, 0.18, 0.10, 1.0),  # 1 dark eyes
        (0.75, 0.15, 0.15, 1.0),  # 2 red mouth
        (0.90, 0.20, 0.35, 1.0),  # 3 heart pink
        (1.00, 0.72, 0.05, 1.0),  # 4 star gold
        (0.95, 0.90, 0.55, 1.0),  # 5 moon cream
        (0.98, 0.55, 0.10, 1.0),  # 6 sun ray orange
    ]])

    fb.save("tests/fonts/EmojiColr.ttf")


# ------------------------------------------------------------------ bitmaps

def smiley_png(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = size * 0.04
    d.ellipse([m, m, size - m, size - m], fill=(255, 204, 26, 255))
    r = size * 0.07
    for ex in (size * 0.32, size * 0.68):
        d.ellipse([ex - r, size * 0.34 - r, ex + r, size * 0.34 + r],
                  fill=(64, 46, 26, 255))
    d.arc([size * 0.25, size * 0.35, size * 0.75, size * 0.78],
          20, 160, fill=(64, 46, 26, 255), width=max(2, size // 16))
    return img


def heart_png(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size
    d.polygon([(s * 0.08, s * 0.38), (s * 0.92, s * 0.38), (s * 0.5, s * 0.95)],
              fill=(230, 50, 90, 255))
    d.ellipse([s * 0.04, s * 0.08, s * 0.5, s * 0.54], fill=(230, 50, 90, 255))
    d.ellipse([s * 0.5, s * 0.08, s * 0.96, s * 0.54], fill=(230, 50, 90, 255))
    return img


def star_png(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # star_points works in y-up coordinates, flip y for the bitmap.
    pts = [(x, size - y) for x, y in
           star_points(size / 2, size / 2, size * 0.48)]
    d.polygon(pts, fill=(255, 184, 13, 255))
    return img


def moon_png(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = size * 0.05
    d.ellipse([m, m, size - m, size - m], fill=(242, 230, 140, 255))
    # ImageDraw writes raw pixel values, so a transparent fill cuts a hole.
    o = size * 0.3
    d.ellipse([m + o, m - o * 0.4, size - m + o, size - m - o * 0.4],
              fill=(0, 0, 0, 0))
    return img


def sun_png(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size / 2
    for i in range(8):
        a = i * math.pi / 4
        tip = (c + size * 0.48 * math.cos(a), c + size * 0.48 * math.sin(a))
        base1 = (c + size * 0.3 * math.cos(a - 0.25),
                 c + size * 0.3 * math.sin(a - 0.25))
        base2 = (c + size * 0.3 * math.cos(a + 0.25),
                 c + size * 0.3 * math.sin(a + 0.25))
        d.polygon([tip, base1, base2], fill=(250, 140, 26, 255))
    r = size * 0.28
    d.ellipse([c - r, c - r, c + r, c + r], fill=(255, 204, 26, 255))
    return img


PNG_DRAWERS = {
    "smiley": smiley_png,
    "heart": heart_png,
    "star": star_png,
    "moon": moon_png,
    "sun": sun_png,
}


def png_bytes(img):
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def build_cbdt():
    glyphs = {name: empty_glyph() for name in EMOJI_NAMES}
    fb = base_font(glyphs)
    name_font(fb, "Emoji Cbdt Test")
    font = fb.font

    pngs = [png_bytes(PNG_DRAWERS[name](PPEM)) for name in EMOJI_NAMES]

    # CBDT: header, then per glyph image format 17 data
    # (small glyph metrics + png length + png data).
    bearing_y = int(PPEM * 0.85)
    cbdt = struct.pack(">HH", 3, 0)
    offsets = []  # relative to the start of the glyph data area
    pos = 0
    blocks = b""
    for png in pngs:
        offsets.append(pos)
        block = struct.pack(">BBbbB", PPEM, PPEM, 0, bearing_y, PPEM)
        block += struct.pack(">I", len(png)) + png
        blocks += block
        pos += len(block)
    offsets.append(pos)
    cbdt += blocks

    # CBLC: one strike covering glyphs 1..len(EMOJI_NAMES), index format 1,
    # image format 17.
    last_gid = len(EMOJI_NAMES)
    line_metrics = struct.pack(">bbBbbbbbbbbb",
                               bearing_y, bearing_y - PPEM, PPEM,
                               0, 1, 0, 0, 0, 0, 0, 0, 0)
    index_subtable = struct.pack(">HHI", 1, 17, 4)  # format 1, png, after header
    index_subtable += b"".join(struct.pack(">I", o) for o in offsets)
    subtable_array = struct.pack(">HHI", 1, last_gid, 8)  # after the array
    index_tables_size = len(subtable_array) + len(index_subtable)
    bitmap_size = struct.pack(">IIII", 56, index_tables_size, 1, 0)
    bitmap_size += line_metrics + line_metrics
    bitmap_size += struct.pack(">HHBBBb", 1, last_gid, PPEM, PPEM, 32, 1)
    assert len(bitmap_size) == 48
    cblc = struct.pack(">HHI", 3, 0, 1) + bitmap_size + subtable_array + index_subtable

    for tag, data in (("CBDT", cbdt), ("CBLC", cblc)):
        table = DefaultTable(tag)
        table.data = data
        font[tag] = table

    # Bitmap-only font: drop the outlines like real CBDT emoji fonts do.
    font.recalcBBoxes = False
    font["maxp"].tableVersion = 0x00005000
    del font["glyf"]
    del font["loca"]

    fb.save("tests/fonts/EmojiCbdt.ttf")


def build_sbix():
    glyphs = {name: empty_glyph() for name in EMOJI_NAMES}
    fb = base_font(glyphs)
    name_font(fb, "Emoji Sbix Test")
    font = fb.font

    sbix = newTable("sbix")
    sbix.version = 1
    sbix.flags = 1
    strike = SbixStrike(ppem=PPEM, resolution=72)
    descent_px = int(PPEM * 0.15)
    for name in EMOJI_NAMES:
        glyph = SbixGlyph(glyphName=name, graphicType="png ",
                          imageData=png_bytes(PNG_DRAWERS[name](PPEM)),
                          originOffsetX=0,
                          originOffsetY=-descent_px)
        strike.glyphs[name] = glyph
    sbix.strikes = {PPEM: strike}
    font["sbix"] = sbix

    fb.save("tests/fonts/EmojiSbix.ttf")


if __name__ == "__main__":
    build_colr()
    build_cbdt()
    build_sbix()
    print("Wrote tests/fonts/EmojiColr.ttf, EmojiCbdt.ttf, EmojiSbix.ttf")
