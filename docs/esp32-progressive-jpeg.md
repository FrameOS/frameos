# Progressive JPEG on low-memory ESP32 boards — design analysis

Status: **analysis only, nothing implemented** (2026-08-26). Written so the work
can be picked up later without redoing the arithmetic.

## TL;DR

Progressive JPEG on the 8 MB boards (E1004, 13.3E6-class, 1200×1600 RGB565
canvas, ~0.9 MB into-target decode budget) is **not fundamentally impossible**.
Today's refusal is a property of pixie's decoder design — a source-sized
coefficient store for the whole image plus target-sized channel masks — not of
the format.

- A **strip re-walk** decode (decode the image in horizontal strips, re-walk the
  entropy data once per strip, keep only one strip's coefficients) reaches full
  resolution inside the existing budget.
- Using the **canvas as scratch space** for the coefficients of rows not yet
  rendered turns ~10 passes into ~4 on the E1004. It cannot replace the
  coefficient store outright on 565 boards (2 B/px available vs 3 B/px needed).
- On **RGBX-canvas boards** (4 B/px) the coefficients fit *inside* the canvas and
  can be IDCT'd in place.
- Cheap fallbacks exist without any of the above: DC-only (90 KB) and
  quarter-res (720 KB) rungs.
- Until then: prefer PNG / baseline JPEG URLs (`embeddedSizedRemoteImageUrl`
  already asks Unsplash for `fm=png`).

## Reference input

A real Unsplash `fm=jpg` at 1200×1600 (`?w=1200&h=1600&fit=crop&fm=jpg&q=80`,
non-browser UA):

- 228 277 bytes, SOF2, 4:2:0 (Y 2×2, Cb 1×1, Cr 1×1), **no DRI / restart
  markers**, `accept-ranges: bytes`.
- libjpeg's standard `jpeg_simple_progression` 10-scan script:

| # | comps | Ss–Se | Ah→Al | bytes |
|---|---|---|---|---|
| 1 | Y,Cb,Cr | 0–0 | 0→1 (DC first) | 20 521 |
| 2 | Y | 1–5 | 0→2 | 24 808 |
| 3 | Cr | 1–63 | 0→1 | 2 218 |
| 4 | Cb | 1–63 | 0→1 | 1 871 |
| 5 | Y | 6–63 | 0→2 | 18 848 |
| 6 | Y | 1–63 | 2→1 (refine) | 44 597 |
| 7 | Y,Cb,Cr | 0–0 | 1→0 (DC refine) | 5 642 |
| 8 | Cr | 1–63 | 1→0 (refine) | 6 334 |
| 9 | Cb | 1–63 | 1→0 (refine) | 5 161 |
| 10 | Y | 1–63 | 1→0 (refine) | 94 375 |

Refinement scans (6–10) hold 68% of the bytes; the DC scans are the first ~9%.

## What is required vs what pixie does today

Blocks at 1200×1600 4:2:0: 150×200 = 30 000 Y + 2 × 7 500 chroma = **45 000**.

- **Inherent:** every block's 64 × int16 coefficients must survive across all
  scans → 45 000 × 128 B = **5.76 MB** (3 B per *source* pixel at 4:2:0,
  4 B at 4:2:2, 6 B at 4:4:4). Reduced-resolution output does not shrink this
  unless you also drop coefficients (see rungs below): storage ∝ output pixels ×
  bytes/px, whichever way you cut it.
- **pixie today** (`../pixie/src/pixie/fileformats/jpeg.nim`):
  - `decodeSOF2` refuses any streamed source ("progressive JPEG cannot be
    decoded from a stream", `:826-829`); the buffered path allocates
    `component.blocks` source-sized (`:805-812`).
  - On top, target-sized channel masks (`useScaledChannels`, 1.5 B/px at
    4:2:0 → 2.88 MB) → plan = **8.6 MB** vs a ~0.9 MB budget. Plan check at
    `:776-800`, estimate in `jpegDecodeIntermediateBytes` (`:2431-2461`).
  - `decodeIntoTargetWithDegrade` (`frameos/src/frameos/utils/image.nim`) cannot
    help: its /2 and /4 rungs only shrink the masks; the block store stays
    source-sized at every rung. Progressive is unreachable on 8 MB boards at
    *any* resolution. (The "half-res retry wanted a 1.9 MB block" OOM seen on
    the E1004 was the temp image — even with that block the plan is refused.)
  - Also refused on 16 MB boards with a 7.7 MB RGBX canvas out (~5 MB budget).

## Canvas as coefficient store (direct version)

| Canvas | B/px available | needed 4:2:0 / 4:2:2 / 4:4:4 |
|---|---|---|
| RGB565 (E1004, 8 MB boards) | 2 | 3 / 4 / 6 — **does not fit** |
| RGBX (canvas ≤ PSRAM/2 boards) | 4 | fits 4:2:0 and 4:2:2; 4:4:4 only by keeping the low 4×4 of each chroma block (→ 3 B/px; invisible after Spectra-6 dithering) |

Why the 565 case can't be squeezed:

- 8-bit coefficients are unsafe: quantized values reach 11+ bits when quant
  table entries are 1–2 (q ≥ 95).
- Dropping chroma AC above 4×4 at 4:2:0 gives 2 + 0.125 + 0.125 = 2.25 B/px —
  still over 2.
- Y DC-only is not "full resolution" any more.

In-place IDCT on RGBX boards works if coefficients are laid out **per MCU row,
interleaved** (Y | Cb | Cr for one MCU row = 48·W bytes, vs 64·W bytes of RGBX
pixels per MCU row) and the IDCT walks **bottom-up** with a one-MCU-row staging
buffer (~57 KB at W=1200). Overlap check: pixel MCU row r occupies
[64W·r, 64W·(r+1)); coefficient MCU row r′ occupies [48W·r′, 48W·(r′+1)); they
overlap only for r′ ∈ ((4/3)r − 1, (4/3)(r+1)), i.e. r′ ≥ r for every r ≥ 0 —
already-consumed rows only. (With a plain Y-plane / chroma-plane layout the
bottom-up walk clobbers unconsumed chroma for R/2 ≤ r < 2R/3 — don't do that.)

Reading pixels *back* out of the canvas does not help: refinement scans need
the exact quantized integers, which are gone after IDCT + 565 packing. The
canvas's value is as free space for rows not yet rendered, not as data.

## Strip re-walk (the design that works on every board)

Decode the image in S horizontal strips; re-walk the entropy data once per
strip; only the current strip holds coefficients; each finished strip is
written straight into its canvas rows.

### The non-obvious constraint

AC refinement scans (Ah ≠ 0, `decodeProgressiveContinuationBlock` else-branch)
read one correction bit per *already-nonzero* coefficient in the band, and EOB
runs span blocks. So a block cannot be skipped without knowing its nonzero
pattern, and there is no random access into a scan without restart markers
(imgix emits none). First-pass scans (Ah = 0) and DC scans need only the DC
predictors and `eobRun`.

### Passes

- **Pass 0 — survey.** Full entropy parse of all scans keeping, per block, only a
  64-bit nonzero bitmap (8 B/block → **360 KB** here, 1/16 of the coefficient
  store; 0.19 B per source pixel in general), updated as each scan makes
  coefficients nonzero. At every strip boundary inside every scan record a
  bookmark: absolute bit-reader position (byte offset + bits consumed), `eobRun`,
  the three DC predictors, `todoBeforeRestart` if DRI is present. 10 scans ×
  ~10 strips × ~24 B — negligible. Strip 0 can be decoded fully during this
  pass if memory allows (bitmap 360 KB + strip buffer).
- **Passes 1..S−1.** Per scan: seek to the bookmark, decode only this strip's
  blocks into a K-MCU-row coefficient buffer (K × 48·W bytes = K × 57.6 KB at
  W=1200), skip the rest of the scan. After the last scan: dequantize + IDCT +
  chroma upsample + colour convert + 565 pack/dither into the canvas rows.
  Free the bitmap after pass 0.
- **Heap-only memory:** bitmap 360 KB + strip buffer + ~40 KB Huffman/quant/
  window. With ~0.9 MB: K ≈ 8–12 → **9–13 passes**.

### Canvas as scratch (the useful form of the idea)

Coefficients for strip s can live in canvas rows *below* s. On a 565 canvas
pixels (32·W per MCU row) are smaller than coefficients (48·W), so a top-down
in-place walk with the staging row is safe: pixel row r clobbers coefficient
rows r′ < (2/3)(r+1) ≤ r, all consumed. Only the last strip has no free rows
below it and needs heap. Worked example for the E1004 (canvas 3.84 MB, budget
~0.9 MB):

- S = 4, strip = 1.44 MB of coefficients.
- Strips 0–2: coefficients in the strip's own rows + the rows below (in-place,
  top-down).
- Strip 3 (last quarter): own rows hold 0.96 MB in place + 0.48 MB heap;
  + 0.36 MB bitmap (pass 0 only, so not concurrent with strip 3 unless strip 0
  is decoded in pass 0) → heap peak ≈ 0.85 MB. Fits.
- With `fitContain` the letterbox rows used as scratch need their solid
  background re-applied afterwards (callers pre-fill it; see `fillImage`
  comment at `jpeg.nim:1875-1878`).

### Source access for passes ≥ 1

- The file is already fully in PSRAM when the stream path refuses (buffered
  fallback; 228 KB here — the OOM is the coefficient store, not the file).
- Larger files: the flash spill dir is wired in `embedded/esp32/main/main.c`
  (`fos_nim_http_set_spill_dir`, 6 MB cap; see
  `cloud/docs/esp32-large-image-spill.md`). Deterministic, no ETag race.
- HTTP Range would also work (Unsplash sends `accept-ranges: bytes`) — one
  request per pass from the earliest bookmark with read-and-discard between
  strips — but the server may hand back a different rendition; check
  `Content-Length`/`ETag` if ever used. Not the first choice.
- pixie's streaming source cannot seek backwards today (`ensureBytesSlow`
  slides forward only); a seekable source proc is needed.
- Restart markers, when present, make bookmarks trivial but change nothing
  else. Do not design around them.

### Work and correctness

- Entropy work ≈ 2× a normal decode (pass 0 + the sum of strip passes), IDCT
  once. Not measured on hardware. For scale: the E1004 gallery PNG path renders
  in ~25 s; a 30 s panel refresh follows anyway.
- Oracle is free: strip decode must be **bit-identical** to the existing
  buffered full decode on host. Pin it in a test the way
  `test_spilled_image_stream.nim` pins the streamed formats.

### Where the code lands

pixie fork (`FrameOS/pixie`, branch `embedded`; PRs go to the fork only, never
upstream), `jpeg.nim` (2 462 lines today):

1. bitmap-only refinement parser (parse, update the 64-bit map, don't store);
2. seekable source proc + bookmark capture/restore (bit reader, `eobRun`, DC
   predictors, restart countdown);
3. strip-window block storage instead of `component.blocks[row][column]`
   for the whole image;
4. an **MCU-row → target sink**: dequant + IDCT + upsample + colour convert +
   565 pack per MCU row, applying the `scaledFitRects` crop/fit math directly
   (bypassing the channel masks and `fillImage`).

frameos `utils/image.nim`: route progressive through this path with a seekable
source (PSRAM buffer or spill file) instead of "stream refuses → buffered →
OOM"; keep the degrade ladder as the outer loop.

Rough size: 1.5–2.5k lines with tests.

## Cheaper intermediates (no strips, no seeking)

| Rung | What | Memory (1200×1600 4:2:0) | Output |
|---|---|---|---|
| DC-only | Parse only Ss=0 scans (first ~9% of the file), byte-skip every AC scan by scanning for the next non-RST marker. No bitmap needed. | 2 B/block = **90 KB** | 150×200, nearest-upscaled — blurry, but never an error frame |
| Quarter-res | Keep the 2×2 low-frequency coefficients per block; scans whose band lies entirely above the kept set are byte-skipped, overlapping bands are parsed — which needs the nonzero bitmap | 8 B/block + bitmap = **720 KB** | 300×400 (same as the existing /4 rung) |
| Half-res | 4×4 per block | 32 B/block = 1.44 MB + bitmap | over budget on 8 MB boards |

Why "keep only some coefficients" still needs the bitmap: a refinement scan's
parsing depends on the nonzero state of *every* coefficient in its band,
including the ones you are discarding. Bands entirely outside the kept set can
be skipped without parsing because each scan's EOB-run and refinement state is
confined to its own band.

## Side finding: baseline JPEG is soft on the E1004 today

The streaming baseline path still builds target-sized channel masks (2.88 MB
at 1200×1600). The budget clamp (`jpeg.nim:620-648`) then shrinks the sampling
grid by √(924/2880) ≈ 0.57 → ~680×900, and the contiguous-block clamp (1.92 MB
luma mask vs a ~1.7 MB largest block) bites too. `fillImage` nearest-upscales
that into the canvas. The MCU-row → canvas sink from step 4 above is exactly
what fixes this, so building it once pays for both formats — and it is the
sensible first PR of the series.

## Recommendation

- Unsplash-only need: `fm=png` (shipped) is enough.
- Arbitrary user URLs (imgix / Cloudinary `auto` outputs return progressive to
  non-browser UAs): do it in this order —
  1. MCU-row → canvas sink for baseline (fixes the soft-baseline finding);
  2. DC-only rung as the floor of the degrade ladder;
  3. strip re-walk with heap strips;
  4. canvas-as-scratch to cut the pass count;
  5. RGBX in-place variant only if a 16 MB board actually asks for it.

Related notes: `docs/esp32-memory.md`, `cloud/docs/esp32-large-image-spill.md`.
