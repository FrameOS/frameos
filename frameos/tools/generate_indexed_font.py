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
    glyphs      7 bytes a glyph: u24 holding the advance (its low 12 bits)
                and the glyph's offset in its block (the high 12), then
                i8 x min, y min, x max, y max in units of `boxUnit` font units
                (rounded outwards; x min -128: no box, outline the glyph)
    blocks      8 bytes a block, and one more at the end: u16 first glyph,
                u16 raw length, u16 stored length, u16 offset of its bytes
    block data  the TrueType glyf records of the glyphs, in glyph order,
                without the record's own box (its 8 bytes after the contour
                count, which nothing reads: the glyph table has the box). A
                block that holds a glyph of printable ASCII is stored as it
                is and read in place; those come first, and together they
                are the preset dictionary every other block was deflated
                against (raw deflate, its window starting with the header's
                `dictionary` bytes of block data). A block whose stored length
                is its raw length is not deflated.
    kerning     pixie's pair positioning, read in place
                (`getKerningAdjustment`: the first subtable in lookup order
                that covers the left glyph and has a nonzero entry): a
                28-byte head, then the glyph pairs (the left glyphs, u16 glyph
                and u16 first pair, and one more at the end; the pairs, u16
                right glyph and u8 value), and the class subtables merged
                into one table: per glyph a row (as a left glyph) and a column
                (as a right one), runs of glyphs with u16 first glyph, u8 row,
                u8 column; per row its first entry (u16, one more at the end);
                the entries, u8 column and u8 value, sorted by column
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
VERSION = 3
HEADER = 64
BLOCK_BYTES = 2048
GLYPH_BYTES = 7
KERN_HEAD = 28


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


def stored_records(records: list[bytes]) -> list[bytes]:
    """The records as the blocks hold them: the contour count, then what
    follows the record's box (the outline reader skips the box)."""
    return [record[:2] + record[10:] if len(record) >= 10 else record for record in records]


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


def deflate(raw: bytes, dictionary: bytes) -> bytes:
    if dictionary:
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15, 8, zlib.Z_DEFAULT_STRATEGY, dictionary)
    else:
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    return compressor.compress(raw) + compressor.flush()


def inflate(packed: bytes, dictionary: bytes) -> bytes:
    if dictionary:
        return zlib.decompressobj(-15, dictionary).decompress(packed)
    return zlib.decompress(packed, -15)


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


def merged_kerning(tables, num_glyphs: int):
    """The subtables as two: every glyph pair subtable merged into one (the
    first in lookup order that has a pair wins, as when they are asked in
    turn), and every class subtable merged into one table of rows and columns.

    A glyph's row is what it is as a left glyph in all the class subtables
    (which cover it, in which class), its column what it is as a right glyph
    (its class in each); a cell is the value of the first class subtable that
    covers the left glyph with a nonzero entry for the pair, which is the
    answer pixie's walk gives once the glyph pairs had none. Rows and columns
    that hold the same values are one."""
    kinds = [t[0] for t in tables]
    if "pairs" in kinds and "classes" in kinds and \
            kinds.index("classes") < len(kinds) - 1 - kinds[::-1].index("pairs"):
        raise SystemExit("a glyph pair subtable after a class subtable: the merged tables would change the order")
    pairs: dict[int, dict[int, int]] = {}
    for table in tables:
        if table[0] == "pairs":
            for glyph, glyph_pairs in table[1]:
                into = pairs.setdefault(glyph, {})
                for right, value in glyph_pairs:
                    into.setdefault(right, value)
    class_tables = [t for t in tables if t[0] == "classes"]
    left_maps = [dict(t[1]) for t in class_tables]
    right_maps = [dict(t[2]) for t in class_tables]
    row_maps = [[dict(row) for row in t[3]] for t in class_tables]
    left_keys = [tuple(m.get(glyph) for m in left_maps) for glyph in range(num_glyphs)]
    right_keys = [tuple(m.get(glyph, 0) for m in right_maps) for glyph in range(num_glyphs)]
    distinct_left = sorted(set(left_keys), key=left_keys.index)
    distinct_right = sorted(set(right_keys), key=right_keys.index)

    def cell(left_key, right_key) -> int:
        for t, (cls1, cls2) in enumerate(zip(left_key, right_key)):
            if cls1 is None:
                continue
            value = row_maps[t][cls1].get(cls2, 0)
            if value:
                return value
        return 0

    # Columns that hold the same values in every row are one column.
    column_of_key: dict[tuple, int] = {}
    columns: dict[tuple, int] = {}
    for right_key in distinct_right:
        values = tuple(cell(left_key, right_key) for left_key in distinct_left)
        column_of_key[right_key] = columns.setdefault(values, len(columns))
    # Rows, over those columns; rows that hold the same entries are one row.
    column_keys: dict[int, tuple] = {}
    for right_key, column in column_of_key.items():
        column_keys.setdefault(column, right_key)
    row_of_key: dict[tuple, int] = {}
    rows: dict[tuple, int] = {}
    for left_key in distinct_left:
        entries = tuple((column, cell(left_key, column_keys[column]))
                        for column in range(len(column_keys)) if cell(left_key, column_keys[column]))
        row_of_key[left_key] = rows.setdefault(entries, len(rows))
    if len(rows) > 256 or len(column_keys) > 256:
        raise SystemExit("more than 256 kerning rows or columns: runs name them by a byte")
    runs: list[tuple[int, int, int]] = []
    for glyph in range(num_glyphs):
        cell_ids = (row_of_key[left_keys[glyph]], column_of_key[right_keys[glyph]])
        if not runs or runs[-1][1:] != cell_ids:
            runs.append((glyph, *cell_ids))
    return pairs, runs, list(rows)


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
    for glyph, record in enumerate(stored_records(records)):
        if raw and len(raw) + len(record) > BLOCK_BYTES:
            blocks.append((first, bytes(raw)))
            first, raw = glyph, bytearray()
        offsets[glyph] = len(raw)
        raw += record
    blocks.append((first, bytes(raw)))
    if any(len(raw) > 0xFFFF for _, raw in blocks):
        raise SystemExit("a glyph larger than a block's u16 length")
    if any(offset > 0xFFF for offset in offsets) or any(advance > 0xFFF for advance in advances):
        raise SystemExit("an advance or an offset in a block past 12 bits")

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
        out += struct.pack("<HBbbbb", advances[glyph] | (offsets[glyph] & 0xF) << 12, offsets[glyph] >> 4,
                           *glyph_box(records[glyph], unit))
    align(out)
    blocks_at = len(out)
    # Printable ASCII is most of what frames draw: the blocks holding it stay
    # as they are (read in place, nothing inflated, nothing kept in RAM) for
    # a few KB of flash, and every other block is deflated against them, a
    # preset dictionary the image holds anyway.
    hot = {gid[name] for codepoint, name in font.getBestCmap().items() if 0x20 <= codepoint <= 0x7E}
    is_hot = []
    for b, (first, raw) in enumerate(blocks):
        last = blocks[b + 1][0] if b + 1 < len(blocks) else len(order)
        is_hot.append(any(first <= glyph < last for glyph in hot))
    dictionary = b"".join(raw for (_, raw), h in zip(blocks, is_hot) if h)
    stored: list[bytes] = []
    for (first, raw), h in zip(blocks, is_hot):
        packed = raw if h else deflate(raw, dictionary)
        stored.append(raw if len(packed) >= len(raw) else packed)
    # The dictionary first, then the rest in block order.
    placed = [b for b in range(len(blocks)) if is_hot[b]] + [b for b in range(len(blocks)) if not is_hot[b]]
    at_of = {}
    at = 0
    for b in placed:
        at_of[b] = at
        at += len(stored[b])
    if at > 0xFFFF or len(dictionary) > 0xFFFF:
        raise SystemExit("block data past a u16 offset")
    for b, (first, raw) in enumerate(blocks):
        out += struct.pack("<HHHH", first, len(raw), len(stored[b]), at_of[b])
    out += struct.pack("<HHHH", len(order), 0, 0, at)
    block_data_at = len(out)
    for b in placed:
        out += stored[b]
    align(out)

    # Kerning.
    pairs, kern_runs, rows = merged_kerning(kerning_tables(font, gid), len(order))
    kern_at = len(out)
    out += bytes(KERN_HEAD)
    pair_lefts_at = len(out)
    first_pair = 0
    for glyph in sorted(pairs):
        out += struct.pack("<HH", glyph, first_pair)
        first_pair += len(pairs[glyph])
    out += struct.pack("<HH", 0xFFFF, first_pair)
    pairs_at = len(out)
    for glyph in sorted(pairs):
        for right, value in sorted(pairs[glyph].items()):
            out += struct.pack("<HB", right, vindex(value))
    runs_at = len(out)
    for run in kern_runs:
        out += struct.pack("<HBB", *run)
    rows_at = len(out)
    entry = 0
    for row in rows:
        out += struct.pack("<H", entry)
        entry += len(row)
    out += struct.pack("<H", entry)
    entries_at = len(out)
    for row in rows:
        for column, value in row:
            out += struct.pack("<BB", column, vindex(value))
    struct.pack_into("<HHHHIIIII", out, kern_at, len(pairs), len(kern_runs), len(rows), 0,
                     pair_lefts_at, pairs_at, runs_at, rows_at, entries_at)
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
        len(order), len(runs), len(blocks), len(dictionary), len(values),
        cmap_at, glyphs_at, blocks_at, block_data_at, kern_at, values_at, len(out),
    )
    return bytes(out)


# -------- Reading it back, for --check: what pixie's reader does, in Python.

class Indexed:
    def __init__(self, data: bytes):
        self.data = data
        (magic, version, self.unit, self.upm, self.ascender, self.descender, self.line_gap,
         self.cap_height, self.underline_position, self.underline_thickness, self.strikeout_position,
         self.strikeout_size, self.num_glyphs, self.num_runs, self.num_blocks, self.dictionary_len,
         self.num_values, self.cmap_at, self.glyphs_at, self.blocks_at, self.block_data_at,
         self.kern_at, self.values_at, self.length) = struct.unpack_from("<4sHHHhhhhhhhhHHHHHIIIIIII", data, 0)
        assert magic == MAGIC and version == VERSION and self.length == len(data)
        self.runs = [struct.unpack_from("<IHH", data, self.cmap_at + 8 * i) for i in range(self.num_runs)]
        self.blocks = [struct.unpack_from("<HHHH", data, self.blocks_at + 8 * i) for i in range(self.num_blocks + 1)]
        self.values = [struct.unpack_from("<h", data, self.values_at + 2 * i)[0] for i in range(self.num_values)]
        self.mapped = {first + i: glyph + i for first, count, glyph in self.runs for i in range(count)}
        self.dictionary = data[self.block_data_at : self.block_data_at + self.dictionary_len]
        (self.pair_lefts, self.kern_runs, self.rows, _, self.pair_lefts_at, self.pairs_at, self.runs_at,
         self.rows_at, self.entries_at) = struct.unpack_from("<HHHHIIIII", data, self.kern_at)
        self.lefts = [self.u16(self.pair_lefts_at + 4 * i) for i in range(self.pair_lefts)]
        self.starts = [self.u16(self.runs_at + 4 * i) for i in range(self.kern_runs)]

    def glyph_of(self, codepoint: int) -> int:
        return self.mapped.get(codepoint, -1)

    def record(self, glyph: int) -> tuple[int, int, tuple]:
        word, high, *box = struct.unpack_from("<HBbbbb", self.data, self.glyphs_at + GLYPH_BYTES * glyph)
        return word & 0xFFF, (word >> 12) | (high << 4), tuple(box)

    def glyf(self, glyph: int) -> bytes:
        b = max(i for i in range(self.num_blocks) if self.blocks[i][0] <= glyph)
        first, raw_len, stored_len, at = self.blocks[b]
        packed = self.data[self.block_data_at + at : self.block_data_at + at + stored_len]
        raw = packed if stored_len == raw_len else inflate(packed, self.dictionary)
        assert len(raw) == raw_len
        start = self.record(glyph)[1]
        end = self.record(glyph + 1)[1] if glyph + 1 < self.blocks[b + 1][0] else raw_len
        return raw[start:end]

    def u16(self, at: int) -> int:
        return struct.unpack_from("<H", self.data, at)[0]

    def kerning(self, left: int, right: int) -> int:
        # The glyph pairs.
        i = bisect.bisect_left(self.lefts, left)
        if i < len(self.lefts) and self.lefts[i] == left:
            first = self.u16(self.pair_lefts_at + 4 * i + 2)
            stop = self.u16(self.pair_lefts_at + 4 * i + 6)
            for p in range(first, stop):
                if self.u16(self.pairs_at + 3 * p) == right:
                    return self.values[self.data[self.pairs_at + 3 * p + 2]]
        # The class subtables, merged.
        row = self.data[self.runs_at + 4 * (bisect.bisect_right(self.starts, left) - 1) + 2]
        column = self.data[self.runs_at + 4 * (bisect.bisect_right(self.starts, right) - 1) + 3]
        for e in range(self.u16(self.rows_at + 2 * row), self.u16(self.rows_at + 2 * row + 2)):
            if self.data[self.entries_at + 2 * e] == column:
                return self.values[self.data[self.entries_at + 2 * e + 1]]
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
    stored = stored_records(records)
    metrics = font["hmtx"].metrics
    for glyph, name in enumerate(order):
        advance, _, box = indexed.record(glyph)
        if advance != metrics[name][0]:
            problems.append(f"{name}: advance differs")
        if indexed.glyf(glyph) != stored[glyph]:
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
