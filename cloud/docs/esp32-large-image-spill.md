# ESP32 large-image spill-to-storage

Status: shipped and bench-validated. The firmware wiring landed (spill dir
in `main.c`, SD `.cache` preferred, `/state` fallback, boot sweep, the
`set spill_force <bytes>` test knob), and the 13.3E6 forced-spill bench ran
2026-08-13: a 4.4 MB baseline JPEG spilled to SD in ~24 s and streamed
through the windowed decoder with a ~5.2 MB PSRAM floor. The bench also
exposed that the decode-budget arithmetic — not memory — was the limiting
factor (min(largest-block, headroom)/2 refused a 1.87 MB plan a fragmented
heap easily held); the budget is now headroom-based, into-target decodes get
the full headroom, and budget refusals degrade to a reduced-resolution
decode instead of surfacing as error frames (`decodeIntoTargetWithDegrade`).
Remaining nice-to-haves are in `docs/todo.md` (proactive Content-Length
trigger, URL+ETag decode cache).

## The failure this fixes

Bench measurement (PhotoPainter 7.3, 2026-08-03): the frameOSGallery scene
downloading a ~3MB JPEG hit `BODY_OOM` in `fos_nim_http` chunked buffering
(`embedded/esp32/components/frameos_nim/frameos_nim_glue.c`). At failure,
free PSRAM was ~894KB against the 768KB `FOS_NIM_HTTP_PSRAM_RESERVE` — with
12 interpreted scenes resident, a multi-MB body plus the reserve no longer
fits. The chunk allocator already shrinks its ask down to
`FOS_NIM_HTTP_CHUNK_MIN_BYTES` (64KB), but 64KB + the 768KB reserve was
still more than the heap could give contiguously, so the download died.

Hard rule (repo owner): **no image proxies, no host-side resizing.** Frames
render independently from the original source; the fix is on-device — spill
the bytes to storage and stream the decode from there.

## Data flow today (esp32, gallery scene)

1. `frameos/src/apps/data/frameOSGallery/app.nim` `get()` →
   `downloadImageForTarget(url, maxBytes, target, fit)` with
   `target = context.contextImage()` (the render canvas, panel-sized — this
   is where the decoded RGBA size comes from) and
   `fit = scaledDecodeFitForFrame(frameConfig)`.
2. `frameos/src/frameos/utils/app_images.nim` → `downloadImageInto` →
   (embedded) `downloadImageFromBuffer` in `frameos/src/frameos/utils/image.nim`.
3. `downloadImageFromResolvedBuffer` calls `boundedRequestBuffer`
   (`frameos/src/frameos/utils/http_client.nim`, `-d:frameosEmbedded`
   branch), which calls the C glue's `fos_nim_http_request_chunked*`.
4. The C glue buffers the body in fixed-size PSRAM chunks (512KB, halving
   to 64KB under pressure, always keeping `FOS_NIM_HTTP_PSRAM_RESERVE`
   free). Chunks come back to Nim as `BoundedHttpBufferResponse.chunks`.
5. Decode:
   - **PNG, multi-chunk:** `decodeImageChunks` feeds the chunks straight to
     `decodePngScaledInto(segments, target, fit)` as `InflateSegment`s —
     no contiguous copy ever exists (streamed inflate + in-place unfilter).
   - **JPEG, multi-chunk:** `decodeImageChunks` *coalesces the chunks into
     one contiguous Nim string* (a second full-body allocation while the
     chunks are still alive), then `decodeJpegScaledInto(data, target, fit)`.
   - **Single chunk:** `decodeImageWithFallback(pointer, len, target, fit)`
     decodes in place (windowed JPEG/PNG scaled decoders).

So a 3MB JPEG needs ≥3MB of chunks — and transiently ~6MB when chunked —
before the (otherwise memory-frugal) windowed decoder even starts. With 12
scenes resident there is no 3MB left, and the download itself dies first.

## Design: spill to storage

### Trigger

Keep the existing ladder exactly as-is (512KB chunks halving to 64KB above
the reserve). Only when **even the smallest chunk cannot be allocated
without breaching the reserve** — today's `BODY_OOM` — does the request
switch to spill mode. Memory-comfortable downloads never touch storage.

An optional refinement (not prototyped): spill immediately when
`Content-Length` is known and exceeds `free_psram - reserve`, saving the
pointless buildup/teardown of chunks. The alloc-failure trigger is
sufficient and simpler.

### C glue (`frameos_nim_glue.c`) — implemented

- `fos_nim_http_set_spill_dir(dir, max_spill_bytes)` registers the spill
  directory + an extra per-body cap. **Boot default is unset, so the whole
  feature is inert** — behavior is bit-for-bit today's until the firmware
  wires it (see below). This runtime gate was chosen over an `#ifdef`
  default-off so the required verification build actually compiles the new
  code.
- `fos_nim_http_request_chunked_spill(...)` = old function + two out-params
  (`char **out_spill_path`, `size_t *out_spill_len`). The old
  `fos_nim_http_request_chunked` delegates with `NULL, NULL` (never spills),
  so `fos_nim_http_request` (JS `fetchText`, logs, etc.) is untouched.
- On trigger, `http_spill_remaining()`:
  1. opens `<dir>/http-spill-<seq>.tmp`,
  2. writes the already-buffered chunks in order, freeing each after write
     (PSRAM is released *during* the spill, not after),
  3. streams the remaining body through a 16KB internal-RAM-first window,
  4. enforces `min(max_bytes, max_spill_bytes)`,
  5. on success returns a malloc'd path + total; the chunk array returned to
     Nim is the standard single-empty-chunk placeholder,
  6. on any failure (open/write/short disk/read error) unlinks the partial
     file and returns a 599 error chunk (`spilling HTTP response to storage
     failed…` / `response exceeded…`), same shape as every other transport
     error.

### Nim http_client (embedded branch) — implemented

- `BoundedHttpBufferResponse.spillPath` (+ `bodyLen` = file size, `body`
  left nil, chunks = the empty placeholder).
- `freeHttpBufferResponse` deletes the temp file — spilled bodies are
  strictly single-use.
- `boundedRequest` (the copy-to-string path used for JSON/text) refuses a
  spilled body with a clear `IOError`: copying it into a Nim string would
  recreate the OOM. Text endpoints use small `maxBytes` and effectively
  never spill; only buffer-aware consumers handle spills.

### Image decode entry (`image.nim`, embedded) — implemented

`downloadImageFromResolvedBuffer` routes `spillPath` to
`decodeSpilledImageInto(path, totalLen, target, fit)`:

- **JPEG** (the gallery case): `decodeJpegStreamScaledInto(fileJpegSource(file),
  totalLen, target, fit)` — the same windowed file-streaming decoder the Pi
  host path uses in `readImageIntoTarget`. Peak RAM = decoder window + a few
  rows; the compressed body stays on disk. Interplay with existing budgets is
  unchanged: pixie's decode budget (`refreshDecodeBudget` /
  `availableRenderBytes`) still bounds the decoder's own working set, and the
  target is the pre-existing canvas, so no new full-frame allocation appears.
- **Progressive JPEG**: pixie's streaming decoder raises; we deliberately do
  *not* fall back to a buffered read (that is the allocation that just
  failed). The scene renders its error frame.
- **PNG and everything else**: clear `PixieError` for now. Streamed PNG
  decode needs its `InflateSegment`s resident, so a spilled PNG would need a
  file-backed `BitStreamReader` source in the pixie fork (follow-up below).
  Note the in-RAM chunked PNG path already covers PNGs that fit in PSRAM.

### Firmware wiring — done

Wired in `embedded/esp32/main/main.c` after storage init, as designed:

- SD mounted (`fos_assets_sd_mounted()`): `mkdir <assets_path>/.cache`, sweep
  leftover `http-spill-*` files, then
  `fos_nim_http_set_spill_dir("<assets_path>/.cache", 0)` (no extra cap; the
  request's own `maxBytes` — default 10MB — still applies).
- No SD: `esp_spiffs_info("state", …)`; free space minus a 512KB margin,
  capped at 8MB, becomes the spill cap if it is ≥256KB
  (`fos_nim_http_set_spill_dir("/state", cap)`); else spill stays disabled
  and the boot log says so. `/state` also holds the scene
  store — the cap must never let a spill starve a scene update, hence the
  margin and the low ceiling. (Since 2026.8.13 that store is one file per
  scene plus `scene-index.json` rather than a single `scenes.json`; the
  reasoning is unchanged, but a scene update now writes several files, so the
  margin covers a set of writes rather than one.) Note SPIFFS writes are slow;
  acceptable for a once-per-refresh e-ink frame.
- `frameos_nim_stub.c` already carries the no-op `fos_nim_http_set_spill_dir`
  (stub builds have no Nim and no HTTP glue).
- Boot sweep in both cases (crash during spill leaves a `.tmp` behind).

### Failure modes

| Case | Behavior |
| --- | --- |
| Spill never wired / dir unset | Exactly today's BODY_OOM error frame. |
| No SD, tiny SPIFFS, body > cap | 599 `response exceeded N bytes`; error frame. |
| Disk full mid-spill | Partial file unlinked; 599 spill-failed; error frame. |
| Progressive JPEG spilled | PixieError surfaced; error frame. |
| PNG/WEBP/GIF spilled | PixieError "no file-backed streaming decoder"; error frame. |
| Crash mid-spill | Orphan `.tmp`; removed by boot sweep. |
| Text/JSON request spilled | IOError from `boundedRequest`; app logs it. |

SD-card wear: spills happen only under memory pressure and are bounded by
render cadence (e-ink refreshes are minutes apart); no wear concern.
Concurrency: renders are single-tasked in this firmware; `s_http_spill_seq`
needs no lock (revisit if HTTP ever leaves the render task).

### Rough change size per layer

| Layer | Size | State |
| --- | --- | --- |
| C glue (`frameos_nim_glue.c` + `frameos_nim.h`) | ~170 lines | done |
| Nim `http_client.nim` embedded branch | ~45 lines | done |
| Nim `image.nim` decode entry | ~35 lines | done |
| Firmware wiring (`main.c` + stub + sweep) | ~40 lines | done |
| pixie fork: file-backed PNG inflate source | ~150 lines | follow-up, only if spilled PNGs show up in practice |

### Follow-ups

- Superseded for images, 2026-08-26 (#398): any download with a decode
  target now decodes straight off the socket (`image:streamed` in the log),
  so gallery images never reach the spill. The spill still serves bodies
  without a target and non-image responses. On the 8 MB layout the `/state`
  cap is a few hundred KB, which is what the old
  `response exceeded 6291456 bytes` message was really reporting — the glue
  now prints the effective cap and directory.
- Consider the proactive Content-Length trigger.
- pixie fork: `InflateSegment`-from-file source so spilled PNGs stream too.
- Optional: reuse the spill file as a decode cache keyed by URL+ETag (the
  gallery serves a fresh image per fetch, so value is low today).
