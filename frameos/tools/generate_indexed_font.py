#!/usr/bin/env python3
"""The default font as every runtime reads it: where it lies, a glyph at a time.

`assets/compiled/fonts/Ubuntu-Regular.ttf` (made by generate_embedded_font.py)
was compiled in gzipped, and every runtime inflated it whole and parsed it:
162 KB held for the life of the process and a 424 KB peak at the first text
(docs/esp32-memory.md). `assets/compiled/fonts/Ubuntu-Regular.fosf`, made here
from it, is compiled in as it is (`src/assets/fonts.nim`) and read in place by
pixie (`fontformats/indexedfont.nim`): the tables a typesetter reads every
character are small and stay uncompressed, so a lookup is a binary search over
the image's own bytes; the glyph outlines, the bulk, are deflated in blocks of
about 2 KB, and a glyph that is not in the glyph cache inflates its block.

Layout (little-endian, every section 4-byte aligned):

    header      64 bytes: "FOSF", version, metrics, counts, section offsets
    cmap        runs of codepoints mapped to consecutive glyphs:
                u32 first codepoint, u16 count, u16 first glyph
    glyphs      8 bytes a glyph: u16 advance, u16 offset in its block,
                i8 x min, y min, x max, y max in units of `boxUnit` font units
                (rounded outwards; x min -128: no box, outline the glyph)
    blocks      8 bytes a block, and one more at the end: u16 first glyph,
                u16 raw length, u32 offset of its bytes
    block data  the TrueType glyf records of the glyphs, in glyph order,
                deflated a block at a time (raw deflate), except a block that
                holds a glyph of printable ASCII, which is stored as it is
                and read in place: a block whose stored length is its raw
                length is not deflated
    kerning     pixie's pair positioning in lookup order, read in place
                (`getKerningAdjustment`): 24 bytes a subtable, its left
                glyphs, its right classes or pairs, its rows and entries
    values      the kerning values, i16, that entries name by index

`--check` builds the file again and compares, then reads the committed file
back and compares it with the TTF the way pixie reads that: the same
codepoints and glyphs, advances, outlines, metrics and kerning pairs, every
box holding its glyph.

    python3 tools/generate_indexed_font.py          # write the indexed font
    python3 tools/generate_indexed_font.py --check  # exit 1 if it drifted
"""

from __future__ import annotations

import argparse
import bisect
import struct
import sys
import zlib
from pathlib import Path

from fontTools.ttLib import TTFont

FRAMEOS_ROOT = Path(__file__).resolve().parents[1]
SOURCE = FRAMEOS_ROOT / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.ttf"
OUTPUT = FRAMEOS_ROOT / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.fosf"

MAGIC = b"FOSF"
VERSION = 1
HEADER = 64
BLOCK_BYTES = 2048
KERN_TABLE = 24


def align(data: bytearray) -> None:
    while len(data) % 4:
        data.append(0)


def glyf_records(font: TTFont, data: bytes) -> list[bytes]:
    """Each glyph's glyf record as the file holds it (what pixie parses)."""
    entry = font.reader.tables["glyf"]
    glyf = data[entry.offset : entry.offset + entry.length]
    loca = font["loca"].locations
    return [glyf[loca[i] : loca[i + 1]] for i in range(len(loca) - 1)]


def cmap_runs(font: TTFont, gid: dict[str, int]) -> list[tuple[int, int, int]]:
    runs: list[list[int]] = []
    for codepoint, name in sorted(font.getBestCmap().items()):
        glyph = gid[name]
        if runs and codepoint == runs[-1][0] + runs[-1][1] and glyph == runs[-1][2] + runs[-1][1] \
                and runs[-1][1] < 0xFFFF:
            runs[-1][1] += 1
        else:
            runs.append([codepoint, 1, glyph])
    return [tuple(run) for run in runs]


def box_unit(units_per_em: int) -> int:
    return max(1, units_per_em // 64)


def glyph_box(record: bytes, unit: int) -> tuple[int, int, int, int]:
    if len(record) < 10:
        return (0, 0, 0, 0)
    x_min, y_min, x_max, y_max = struct.unpack(">hhhh", record[2:10])
    box = (x_min // unit, y_min // unit, -(-x_max // unit), -(-y_max // unit))
    if any(v < -127 or v > 127 for v in box):
        return (-128, 0, 0, 0)
    return box


def kerning_tables(font: TTFont, gid: dict[str, int]):
    """pixie's pair positioning subtables, in its order and with its rules:
    lookups of type 2 with an x advance, only nonzero entries, and only the
    subtables that kept any (opentype.nim `parseLookup`)."""
    tables = []
    if "GPOS" not in font:
        return tables
    for lookup in font["GPOS"].table.LookupList.Lookup:
        if lookup.LookupType != 2:
            continue
        for table in lookup.SubTable:
            if not (getattr(table, "ValueFormat1", 0) & 0x4):
                continue
            coverage = [gid[name] for name in table.Coverage.glyphs]
            if table.Format == 1:
                lefts = []
                for glyph, pair_set in zip(coverage, table.PairSet):
                    pairs = {}
                    for record in pair_set.PairValueRecord:
                        value = record.Value1.XAdvance if record.Value1 else 0
                        if value and gid[record.SecondGlyph] not in pairs:
                            pairs[gid[record.SecondGlyph]] = value
                    lefts.append((glyph, sorted(pairs.items())))
                lefts.sort()
                if any(pairs for _, pairs in lefts):
                    tables.append(("pairs", lefts))
            elif table.Format == 2:
                class1 = table.ClassDef1.classDefs if table.ClassDef1 else {}
                class2 = table.ClassDef2.classDefs if table.ClassDef2 else {}
                left = sorted((glyph, class1.get(font.getGlyphOrder()[glyph], 0)) for glyph in coverage)
                right = sorted((gid[name], cls) for name, cls in class2.items() if cls)
                rows = []
                for record in table.Class1Record:
                    row = []
                    for cls, entry in enumerate(record.Class2Record):
                        value = entry.Value1.XAdvance if entry.Value1 else 0
                        if value:
                            row.append((cls, value))
                    rows.append(row)
                if any(rows):
                    tables.append(("classes", left, right, rows))
    return tables


def ranges(items: list[tuple[int, int]]) -> list[tuple[int, int, int]]:
    """(glyph, value) sorted by glyph -> (first, last, value) runs."""
    out: list[list[int]] = []
    for glyph, value in items:
        if out and glyph == out[-1][1] + 1 and value == out[-1][2]:
            out[-1][1] = glyph
        else:
            out.append([glyph, glyph, value])
    return [tuple(r) for r in out]


def build(source: Path) -> bytes:
    data = source.read_bytes()
    font = TTFont(source, recalcTimestamp=False)
    order = font.getGlyphOrder()
    gid = {name: i for i, name in enumerate(order)}
    head, hhea, os2, post = font["head"], font["hhea"], font["OS/2"], font["post"]
    upm = head.unitsPerEm
    unit = box_unit(upm)
    records = glyf_records(font, data)
    metrics = font["hmtx"].metrics
    advances = [metrics[name][0] for name in order]
    runs = cmap_runs(font, gid)

    # Blocks: glyphs in order, a block closed before it would pass BLOCK_BYTES.
    blocks: list[tuple[int, bytes]] = []
    offsets = [0] * len(order)
    first, raw = 0, bytearray()
    for glyph, record in enumerate(records):
        if raw and len(raw) + len(record) > BLOCK_BYTES:
            blocks.append((first, bytes(raw)))
            first, raw = glyph, bytearray()
        offsets[glyph] = len(raw)
        raw += record
    blocks.append((first, bytes(raw)))
    if any(len(raw) > 0xFFFF for _, raw in blocks):
        raise SystemExit("a glyph larger than a block's u16 length")

    # Kerning.
    tables = kerning_tables(font, gid)
    values: list[int] = []
    value_index: dict[int, int] = {}

    def vindex(value: int) -> int:
        if value not in value_index:
            value_index[value] = len(values)
            values.append(value)
        return value_index[value]

    out = bytearray(HEADER)
    cmap_at = len(out)
    for codepoint, count, glyph in runs:
        out += struct.pack("<IHH", codepoint, count, glyph)
    align(out)
    glyphs_at = len(out)
    for glyph in range(len(order)):
        out += struct.pack("<HHbbbb", advances[glyph], offsets[glyph], *glyph_box(records[glyph], unit))
    align(out)
    blocks_at = len(out)
    # Printable ASCII is most of what frames draw: the blocks holding it stay
    # as they are (read in place, nothing inflated, nothing kept in RAM) for
    # a few KB of flash.
    hot = {gid[name] for codepoint, name in font.getBestCmap().items() if 0x20 <= codepoint <= 0x7E}
    deflated = []
    for b, (first, raw) in enumerate(blocks):
        last = blocks[b + 1][0] if b + 1 < len(blocks) else len(order)
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = compressor.compress(raw) + compressor.flush()
        if len(packed) >= len(raw) or any(first <= glyph < last for glyph in hot):
            packed = raw
        deflated.append(packed)
    at = 0
    for (first, raw), packed in zip(blocks, deflated):
        out += struct.pack("<HHI", first, len(raw), at)
        at += len(packed)
    out += struct.pack("<HHI", len(order), 0, at)
    block_data_at = len(out)
    for packed in deflated:
        out += packed
    align(out)

    kern_at = len(out)
    headers_at = kern_at
    out += bytes(KERN_TABLE * len(tables))
    for t, table in enumerate(tables):
        align(out)
        if table[0] == "pairs":
            lefts = table[1]
            left_at = len(out)
            first_pair = 0
            for glyph, pairs in lefts:
                out += struct.pack("<HHHH", glyph, first_pair, len(pairs), 0)
                first_pair += len(pairs)
            second_at = len(out)
            for _, pairs in lefts:
                for right, value in pairs:
                    out += struct.pack("<HH", right, vindex(value))
            struct.pack_into("<BBHIHHIII", out, headers_at + t * KERN_TABLE, 1, 0, len(lefts), left_at,
                             first_pair, 0, second_at, 0, 0)
        else:
            _, left, right, rows = table
            left_ranges = ranges(left)
            right_ranges = ranges(right)
            if len(rows) > 0xFFFF or any(cls > 255 for row in rows for cls, _ in row):
                raise SystemExit("a kerning class past 255")
            left_at = len(out)
            for r in left_ranges:
                out += struct.pack("<HHH", *r)
            align(out)
            second_at = len(out)
            for r in right_ranges:
                out += struct.pack("<HHH", *r)
            align(out)
            rows_at = len(out)
            entry = 0
            for row in rows:
                out += struct.pack("<HH", entry, len(row))
                entry += len(row)
            entries_at = len(out)
            for row in rows:
                for cls, value in row:
                    out += struct.pack("<BB", cls, vindex(value))
            struct.pack_into("<BBHIHHIII", out, headers_at + t * KERN_TABLE, 2, 0, len(left_ranges), left_at,
                             len(right_ranges), len(rows), second_at, rows_at, entries_at)
    if len(values) > 256:
        raise SystemExit("more than 256 kerning values: entries name them by a byte")
    align(out)
    values_at = len(out)
    for value in values:
        out += struct.pack("<h", value)
    align(out)

    struct.pack_into(
        "<4sHHHhhhhhhhhHHHHHIIIIIII", out, 0,
        MAGIC, VERSION, unit, upm,
        hhea.ascent, hhea.descent, hhea.lineGap, getattr(os2, "sCapHeight", 0),
        post.underlinePosition, post.underlineThickness, os2.yStrikeoutPosition, os2.yStrikeoutSize,
        len(order), len(runs), len(blocks), len(tables), len(values),
        cmap_at, glyphs_at, blocks_at, block_data_at, kern_at, values_at, len(out),
    )
    return bytes(out)


# -------- Reading it back, for --check: what pixie's reader does, in Python.

class Indexed:
    def __init__(self, data: bytes):
        self.data = data
        (magic, version, self.unit, self.upm, self.ascender, self.descender, self.line_gap,
         self.cap_height, self.underline_position, self.underline_thickness, self.strikeout_position,
         self.strikeout_size, self.num_glyphs, self.num_runs, self.num_blocks, self.num_tables,
         self.num_values, self.cmap_at, self.glyphs_at, self.blocks_at, self.block_data_at,
         self.kern_at, self.values_at, self.length) = struct.unpack_from("<4sHHHhhhhhhhhHHHHHIIIIIII", data, 0)
        assert magic == MAGIC and version == VERSION and self.length == len(data)
        self.runs = [struct.unpack_from("<IHH", data, self.cmap_at + 8 * i) for i in range(self.num_runs)]
        self.blocks = [struct.unpack_from("<HHI", data, self.blocks_at + 8 * i) for i in range(self.num_blocks + 1)]
        self.values = [struct.unpack_from("<h", data, self.values_at + 2 * i)[0] for i in range(self.num_values)]
        self.mapped = {first + i: glyph + i for first, count, glyph in self.runs for i in range(count)}

    def glyph_of(self, codepoint: int) -> int:
        return self.mapped.get(codepoint, -1)

    def record(self, glyph: int) -> tuple[int, int, tuple]:
        advance, offset, *box = struct.unpack_from("<HHbbbb", self.data, self.glyphs_at + 8 * glyph)
        return advance, offset, tuple(box)

    def glyf(self, glyph: int) -> bytes:
        b = max(i for i in range(self.num_blocks) if self.blocks[i][0] <= glyph)
        first, raw_len, at = self.blocks[b]
        packed = self.data[self.block_data_at + at : self.block_data_at + self.blocks[b + 1][2]]
        raw = packed if len(packed) == raw_len else zlib.decompress(packed, -15)
        assert len(raw) == raw_len
        start = self.record(glyph)[1]
        end = self.record(glyph + 1)[1] if glyph + 1 < self.blocks[b + 1][0] else raw_len
        return raw[start:end]

    def tables(self):
        if hasattr(self, "_tables"):
            return self._tables
        self._tables = []
        for t in range(self.num_tables):
            (fmt, _, left_count, left_at, second_count, row_count, second_at, rows_at,
             entries_at) = struct.unpack_from("<BBHIHHIII", self.data, self.kern_at + KERN_TABLE * t)
            if fmt == 1:
                lefts = {}
                for i in range(left_count):
                    glyph, first, count, _ = struct.unpack_from("<HHHH", self.data, left_at + 8 * i)
                    lefts[glyph] = {r: self.values[v] for r, v in (struct.unpack_from("<HH", self.data, second_at + 4 * j)
                                                                   for j in range(first, first + count))}
                self._tables.append((1, lefts))
            else:
                left = [struct.unpack_from("<HHH", self.data, left_at + 6 * i) for i in range(left_count)]
                right = [struct.unpack_from("<HHH", self.data, second_at + 6 * i) for i in range(second_count)]
                rows = []
                for c in range(row_count):
                    first, count = struct.unpack_from("<HH", self.data, rows_at + 4 * c)
                    rows.append({cls: self.values[v] for cls, v in (struct.unpack_from("<BB", self.data, entries_at + 2 * j)
                                                                    for j in range(first, first + count))})
                self._tables.append((2, left, right, rows))
        return self._tables

    @staticmethod
    def in_ranges(ranges, glyph):
        i = bisect.bisect_right(ranges, (glyph, 0xFFFF, 0xFFFF)) - 1
        if i >= 0 and ranges[i][0] <= glyph <= ranges[i][1]:
            return ranges[i][2]
        return None

    def kerning(self, left: int, right: int) -> int:
        for table in self.tables():
            if table[0] == 1:
                pairs = table[1].get(left)
                if pairs is not None and right in pairs:
                    return pairs[right]
            else:
                cls1 = self.in_ranges(table[1], left)
                if cls1 is None:
                    continue
                cls2 = self.in_ranges(table[2], right) or 0
                if cls2 in table[3][cls1]:
                    return table[3][cls1][cls2]
        return 0


def check(source: Path, output: Path) -> list[str]:
    problems: list[str] = []
    if not output.exists():
        return [f"{output} is missing: run tools/generate_indexed_font.py"]
    committed = output.read_bytes()
    if build(source) != committed:
        problems.append(f"{output.name} is stale: run tools/generate_indexed_font.py")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from generate_embedded_font import kerning as ttf_kerning  # noqa: E402

    font = TTFont(source)
    data = source.read_bytes()
    order = font.getGlyphOrder()
    gid = {name: i for i, name in enumerate(order)}
    indexed = Indexed(committed)
    hhea, os2, post = font["hhea"], font["OS/2"], font["post"]
    if (indexed.upm, indexed.ascender, indexed.descender, indexed.line_gap, indexed.cap_height,
            indexed.underline_position, indexed.underline_thickness, indexed.strikeout_position,
            indexed.strikeout_size) != (font["head"].unitsPerEm, hhea.ascent, hhea.descent, hhea.lineGap,
                                        os2.sCapHeight, post.underlinePosition, post.underlineThickness,
                                        os2.yStrikeoutPosition, os2.yStrikeoutSize):
        problems.append("metrics differ")
    cmap = font.getBestCmap()
    for codepoint, name in cmap.items():
        if indexed.glyph_of(codepoint) != gid[name]:
            problems.append(f"U+{codepoint:04X} maps to another glyph")
    for codepoint in indexed.mapped:
        if codepoint not in cmap:
            problems.append(f"U+{codepoint:04X} is mapped and should not be")
            break
    records = glyf_records(font, data)
    metrics = font["hmtx"].metrics
    for glyph, name in enumerate(order):
        advance, _, box = indexed.record(glyph)
        if advance != metrics[name][0]:
            problems.append(f"{name}: advance differs")
        if indexed.glyf(glyph) != records[glyph]:
            problems.append(f"{name}: outline differs")
        if len(records[glyph]) >= 10 and box[0] != -128:
            x_min, y_min, x_max, y_max = struct.unpack(">hhhh", records[glyph][2:10])
            u = indexed.unit
            if not (box[0] * u <= x_min and box[1] * u <= y_min and box[2] * u >= x_max and box[3] * u >= y_max):
                problems.append(f"{name}: box does not hold the glyph")
    expected = ttf_kerning(font)
    by_glyph = {}
    for codepoint, name in cmap.items():
        by_glyph.setdefault(gid[name], []).append(codepoint)
    seen = 0
    for (left, right), value in expected.items():
        got = indexed.kerning(gid[cmap[left]], gid[cmap[right]])
        if got != value:
            problems.append(f"kerning U+{left:04X} U+{right:04X}: {got} != {value}")
            if len(problems) > 20:
                break
        seen += 1
    # And no pair kerned that pixie does not kern (a sample: every pair of
    # the printable ASCII and Latin-1 letters).
    sample = [c for c in list(range(0x20, 0x7F)) + list(range(0xC0, 0x180)) if c in cmap]
    for left in sample:
        for right in sample:
            if (left, right) not in expected and indexed.kerning(gid[cmap[left]], gid[cmap[right]]) != 0:
                problems.append(f"kerning U+{left:04X} U+{right:04X} where pixie has none")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="exit 1 if the committed file drifted")
    args = parser.parse_args()
    if args.check:
        problems = check(SOURCE, OUTPUT)
        for problem in problems[:40]:
            print(problem, file=sys.stderr)
        return 1 if problems else 0
    OUTPUT.write_bytes(build(SOURCE))
    print(f"{OUTPUT.relative_to(FRAMEOS_ROOT)}: {OUTPUT.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
