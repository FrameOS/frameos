# Progressive JPEG on low-memory ESP32 boards

Status: **implemented** (2026-10-14, FrameOS/pixie `jpeg-progressive-strips`).
The analysis this file used to hold (2026-08-26) is folded in below where it
still explains the design; the numbers are measured.

## What a frame does now

A progressive JPEG decodes on every board, 8 MB ones with a 13.3" canvas
included, at full resolution, and so does every other JPEG a frame draws into
its canvas. Two changes in the pixie fork's `jpeg.nim`:

1. **Strips.** A progressive JPEG's coefficients must stay resident until its
   last scan has refined them: 3 bytes per source pixel at 4:2:0, 5.8 MB for a
   13.3" panel. The decoder holds one *strip* of MCU rows at a time. Each pass
   over the file reads, from every scan, only its strip's blocks, bookmarks the
   bit reader and the run state (EOB run, DC predictors, restart countdown)
   where the next strip begins, and skips to the marker that ends the scan. The
   strip is as many rows as the budget holds beside the channel rings; with no
   budget it is every row, which is the decode every host always did, on the
   same code. There is no survey pass and no nonzero bitmap: strips are decoded
   in order, so a pass only ever parses blocks whose coefficients it holds.
2. **The sink.** A decode into a target used to finish every channel plane,
   target-sized (1.5 bytes per target pixel, 2.9 MB at 13.3"), then fill the
   target from them; on an 8 MB board the budget clamped that to a soft
   646×862 grid, for baseline photos too. The channels are now rings of rows,
   and after every MCU row the target lines whose samples every component has
   finished are drawn, with the same geometry and samples the whole fill used,
   so the pixels are the same. A progressive strip is inverse-transformed MCU
   row by MCU row across its components for the same reason.

What stays: a socket cannot rewind, so a progressive JPEG off the network that
the budget cannot hold whole still goes through the buffered body (the stream
decoder raises its old "cannot be decoded from a stream", frameos buffers, and
the buffered decode runs in strips). Spilled files and SD-card files stream it
directly, rewinding the file once per strip. A source that can serve baseline
JPEG or PNG still spares the 8 MB boards that body copy.

## Measured (frameos ESP32 memory simulation, 13.3" canvas)

imgix-style progressive JPEGs (libjpeg's 10-scan script, 4:2:0, q80) through
`data/downloadImage` → `render/image`:

| board | file | 1200×1600 | 1600×1200 | peak (device bytes) |
|---|---|---|---|---|
| 8 MB | 1200×1600, 318 KB | ok, 82 ms | ok, 85 ms | 4.55 of 6.08 MB |
| 8 MB | 1600×1200, 625 KB | ok, 103 ms | ok, 137 ms | 4.55 of 6.08 MB |
| 8 MB | 1920×2685, 1.2 MB | ok, 176 ms | ok, 166 ms | 4.54 of 6.08 MB |
| 16 MB | all three | ok | ok | 12.6 of 14.1 MB |

Before: every 8 MB case was refused by the plan check (the whole-image blocks),
and the 16 MB cases failed too. The 8 MB render is byte-identical to the
16 MB board's. Against the host's own decode: PSNR 51 dB (1200×1600), 43 dB
(1600×1200), where the clamped-grid renders measured 31 and 21 dB. Times are
the wasm runtime on a laptop; an S3 is slower, but the work is one entropy
decode plus a byte scan of the file per strip (100 strips of a 318 KB file
cost 101 ms in wasm).

Strip count on the 8 MB board: the budget after frameos's reserve is ~0.9 MB,
the rings and bands take ~0.1 MB, and a 1200-wide 4:2:0 MCU row of
coefficients is 57.6 KB, so a strip is ~14 rows and a 13.3" photo takes
7 passes. `setJpegStripMcuRows` caps it.

## The design, for whoever touches it next

### The non-obvious constraint

AC refinement scans (Ah ≠ 0) read one correction bit per *already-nonzero*
coefficient in the band, and EOB runs span blocks, so a block cannot be parsed
without its coefficients so far, and there is no random access into a scan
without restart markers (imgix emits none). First-pass scans and DC scans need
only the DC predictors and `eobRun`. Decoding strips *in order* sidesteps the
survey-bitmap design the first analysis called for: when pass *s* parses strip
*s* of scan *k*, every earlier block of that scan was parsed by an earlier
pass (which recorded where strip *s* starts), and no later block is parsed at
all (the pass byte-skips to the scan's end marker: the first 0xFF that is not
a stuffed 0xFF00, a restart marker or fill).

### Bookmarks

Per scan: byte position, the bit reader's buffer and count, `hitEnd`,
`eobRun`, `todoBeforeRestart`, the DC predictors. Captured after a strip's
last MCU (so after its `checkRestart`), restored after the next pass reads
that scan's SOS header. The Huffman tables are re-read on every pass because a
scan's tables are defined right before it.

### Memory

- Coefficients: one strip, a seq per block row (a 13.3" luma row is 19 KB,
  where a whole-image luma plane was one 3.8 MB allocation a fragmented heap
  could not make).
- Channels: rings of `ringRowsFor` rows (two bands' output and a little).
- Bands and accumulators as before.

### Correctness

The oracle is free: a strip decode must be bit-identical to the whole-image
decode, and the sink's output to the whole-plane fill. `tests/test_jpeg.nim`
in the fork pins both across every master, orientation, fit and size; in
frameos, `test_spilled_image_stream.nim` (a file source rewinds once per
strip; a source that cannot is refused catchably) and `test_decode_degrade.nim`
(`streamDecodeInto` with and without `seekable`).

### Not done

- Canvas-as-scratch for the coefficients (fewer passes). Not needed: a pass
  is cheap.
- The RGBX in-place IDCT for 16 MB boards. Not needed either.
- Reading a chunked PSRAM body as a seekable source: the buffered path still
  coalesces the chunks into one allocation before decoding (`decodeImageChunks`);
  a 1.2 MB body is a 1.2 MB block.

Related notes: `docs/esp32-memory.md`, `cloud/docs/esp32-large-image-spill.md`.
