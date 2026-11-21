# Fonts on an ESP32: TrueType files read where they lie

An ESP32 frame draws with every font on its SD card, as many at once as a
scene names, and holds next to nothing for them. The card's fonts are plain
`.ttf` files in `{assets}/fonts` (what "Sync fonts" copies there on either
control plane, and any TrueType file a user adds), and the runtime reads each
**in place**: no conversion, no index beside it, no face parsed into RAM.

- pixie: `fontformats/filefont.nim` (the reader), `fonts.nim`
  (`openTypefaceFile`, a `Typeface` like any other).
- FrameOS: `utils/font.nim` `fileTypeface` (the faces by name, the SVG/JSX
  family resolver), `utils/memory.nim` `glyphCacheBudgetBytes` /
  `fontPageSlots`, set by `embedded/embedded_main.nim`.
- Tests: `src/frameos/utils/tests/test_file_font.nim` (every shipped font
  against pixie's whole parse), `pixie/tests/test_file_font.nim`,
  `test_glyph_cache_budget.nim`, `test_fonts_scene.nim`,
  `backend/app/utils/tests/test_font_for_card.py`.
- The sample: **Fonts** (`repo/scenes/samples/Fonts`, scene id `fonts`).

## What a face costs

Opening a face reads its table directory and a few header fields: the places
of `cmap`, `hmtx`, `loca`, `glyf`, the metrics, and an index of its GPOS pair
positioning subtables (8 bytes each: where, and the first and last glyph
their coverage holds). About 700 bytes a face on a 64-bit host (fields, path,
that index), half of that on the ESP32; 60 faces open, the shipped collection,
held 50 KB on the host with the page cache. After that every question is
answered from the file:

| Question | Where it is read |
| --- | --- |
| a rune's glyph | `cmap` format 12 (else 4), a binary search over its groups or segments |
| an advance | `hmtx`, by index |
| a glyph's box | `loca` twice and the glyf header's 8 bytes |
| an outline | its `glyf` record, read into a string while pixie parses it (`parseGlyphPath`, `parseCompositeGlyph`) and let go |
| kerning | the GPOS pair subtables in lookup order, by pixie's rule: coverage searched, then the pair set (format 1) or the two class definitions and the class record (format 2); the `kern` table's pairs in a font without GPOS |

The bytes come through a **page cache** on the render thread: `fileFontPages`
slots of 512 bytes (a card's sector), the least recently used going first,
and three small direct-mapped tables beside it that remember the answers a
typesetter asks again and again (a rune's glyph, a glyph's advance and box, a
pair's kerning; 16, 16 and 32 entries a page slot). The thread keeps one file
open between page reads and closes it after each render (`releaseFontFiles`),
so nothing holds a file on the card between renders (FatFs is mounted with 8
descriptors). The cache is made the first time a card font draws and let go
with the glyph cache when render memory runs short (`clearFontPages`).

| Board | Page slots | Pages | Tables | In all |
| --- | --- | --- | --- | --- |
| 8 MB PSRAM | 16 | 8 KB | 14 KB | 22.5 KB |
| 16 MB and more | 64 | 32 KB | 56 KB | 88 KB |

Measured on the host (`fileFontPageReads`, a paragraph of 150 characters at
20 px, a 16-slot cache):

| | First typeset + draw | Set and drawn again |
| --- | --- | --- |
| Ubuntu (9 kerning subtables) | 464 + 105 pages | 76 + 7 |
| … without the three tables | 819 + 90 | 816 + 65 |
| FiraGO (its kerning is in extension lookups, which pixie does not read) | 20 + 173 | 0 + 0 |

Without the tables a 16-page cache thrashed on Ubuntu's GPOS (every pair walks
its subtables' coverage) and on FiraGO's glyph headers (every glyph drawn asks
its box, a page each); with them a text drawn again reads next to nothing.
Bigger pages were worse for the same bytes (256 bytes: 2,048 reads a re-set;
128 bytes: 2,797), since the lookups are binary searches that land far apart.
Sixty faces each drawing a line need about 45 pages each the first time and
do not fit any cache of this size, so a scene that shows many faces shows a
page of them at a time (the Fonts sample does).

Nothing per glyph stays in memory outside the glyph cache (pixie's
`paths.nim`, docs/jsx-ui.md "The glyph cache"), which keeps coverage, not
outlines, for card faces as for the built-in one.

## Why the TrueType file and not an index

The built-in face is an indexed font (FOSF, `generate_indexed_font.py`,
docs/esp32-memory.md "The built-in face is read where it lies") because it
lives in flash, where its glyph blocks are deflated to save 66 KB of the
image. A card has gigabytes, so the only question was RAM, and the TrueType
file answers every lookup with the same number of binary searches a FOSF does:
the character map, the advances and the boxes are tables in the file already,
and kerning can be read in place from GPOS instead of pre-resolved. An index
beside each file would have needed a converter on both control planes (the
cloud has no fontTools) and a second file to keep in step with the first,
for no RAM saved: the three tables above are what make repeated reads cheap,
and they would be needed over an index too.

It sets and draws exactly as pixie's whole parse of the same file, for every
font FrameOS ships: metrics, the character map, advances, boxes, outlines
command for command, kerning, and the pixels of a typeset paragraph
(`test_file_font.nim`, 60 fonts). The rules are pixie's on purpose, so a Pi
(which parses fonts whole) and an ESP32 draw a scene alike: the last format
12 subtable of the Unicode or Windows platform (else the last format 4), GPOS
lookups of type 2 only (an extension lookup's kerning is not read by either:
FiraGO and parts of Cormorant Garamond draw unkerned everywhere), the first
subtable that covers the left glyph and has a nonzero entry wins.

What it does not read, and `frameos/tools/font_for_card.py` turns into what it
does:

- CFF outlines (an `.otf`, or a `.ttf` that is one inside): converted to
  TrueType quadratics (fontTools' cu2qu, within one font unit);
- collections (`.ttc`): one `.ttf` a face;
- WOFF / WOFF2: unwrapped;
- a variable font: drawn as its default instance as it is (pixie's whole
  parse does the same); `--axis wght=700` writes another instance;
- `--subset latin,greek` (or ranges) for a smaller file.

Colour bitmap fonts (Noto Color Emoji, `CBDT`) have no outlines: on an ESP32
they are refused and the text falls back to the built-in face, logged once
(`font:fallback`).

## Flash

On the ESP32-S3 image (EPD_7in5_V2, `ci_build_image.sh`, against main at
f257c8244 built the same way, 2026-11-20): **−32.7 KB** (3,207,904 →
3,175,200 bytes). Nothing on an ESP32 parses a font whole any more, so pixie's
OpenType parser leaves the image: −35.4 KB of its code (CFF charstrings, the
cmap, hmtx, name, OS/2, GPOS pair building, the colour and bitmap tables) and
−6.4 KB of its constants (CFF's standard strings). What came in:

| | Flash |
| --- | --- |
| `filefont.nim`, the reader | +7.6 KB (the open 1.4 KB, its own `parseCompositeGlyph` instance 1.0 KB, kerning and its index 1.7 KB, the cache and tables 1.4 KB) |
| `utils/font.nim`, the resolver now on the ESP32 (`svgFontFileFor`, the listing, `fileTypeface`) | +2.2 KB |
| `fonts.nim`, a `file` branch in each accessor | +0.5 KB |
| the budget functions | +0.1 KB |

Kept small (−2.6 KB of the image against the first cut): the faces by name
are a list and not an `OrderedTable`, the names refused a list and not a
`Table` (a table's code is about a kilobyte an instance), and the table tags
compile-time constants. `parseCompositeGlyph` is generic, so this is a second
instance of it beside the indexed font's (docs/esp32-image-size.md: not
folded yet, about 1 KB).

## The glyph cache on bigger boards

`glyphCacheBudgetBytes()` (utils/memory.nim): a 32nd of what the panel leaves
the scenes (`sceneMemoryBytes`), at least 64 KB, at most

| PSRAM | Ceiling | e.g. |
| --- | --- | --- |
| 8 MB | 128 KB (as before) | the E1004's 2.54 MB left: 78 KB |
| 16 MB (more than 12 MiB of heap) | 512 KB | a panel leaving 7 MB: 224 KB; one leaving 14 MB: 448 KB |
| 32 MB (more than 24 MiB) | 1 MB | |

Each face's glyphs are its own entries, so a scene of several faces fills it
faster than one of the built-in face; the pass-per-render rule
(`newGlyphCachePass`) is kept: a render that needs more than the budget keeps
what fits and draws the rest from masks it lets go.

## Getting fonts onto the card

Both control planes already copy FrameOS's collection (`assets/copied/fonts`,
the 61 files the editor's font list offers; a backend adds the fonts its
project uploaded) to `{assets}/fonts` on the card:
"Sync fonts" in the Assets panel, `POST /api/frames/{id}/assets/sync` (backend
`api_frame_assets_sync`, cloud `assets/sync/route.ts`), one font at a time
with progress, skipping what is there; the MCP tool is
`frame_assets_sync_fonts`. Nothing about it changed: the planes sync raw TTFs,
and the frame reads them as they are. A font uploaded to `fonts/` in the
Assets panel is a font of the frame the same way. The Files scene browses the
folder.

## How a scene names a card font

The same ways as on a Pi, now all honoured on an ESP32:

- the Text app's font field and `^(File.ttf)` in rich text: a file name
  (`getTypeface`);
- SVG `font-family` and the JSX layer's `font-[Family_Name]` (or
  `font-[File-Name.ttf]`): a family, matched loosely against the folder's
  files with weight and italic (`svgFontFileFor`; the folder is listed at
  most every 30 s, so a scene naming forty families lists it once).

A name the frame does not have draws in the built-in face. On a Pi the first
eight faces SVG and JSX name are parsed whole as before and the rest read in
place, so a scene that names every font (the Fonts sample) works there too;
the JSX layer now keeps up to 128 family names (it was 16).

## Not yet

- A face's missing glyphs do not fall back to the built-in face (a Pi does
  not either): Peralta's Greek draws nothing.
- Kerning in GPOS extension lookups (pixie's whole parse skips them too).
- The browser preview has no fonts but the built-in face.
- Measured on the host only: the first card read of a page on the device
  (SPI SD) and a render of the Fonts sample want the hardware bench on a
  board with a TF slot (a reTerminal E1001–E1004 or Sticky, the PhotoPainter,
  the 13.3E6 for 16 MB).
