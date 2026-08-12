# Value pipeline: capability-negotiated execution

How FrameOS decides, per edge of a scene graph, whether a value has to exist
whole in memory — and what happens when it doesn't have to. Written 2026-08-10
as a design + work tracker; **shipped 2026-08-12** (image side, byte side, and
compiled-scene parity, all hardware-verified on a 7.3" PhotoPainter). This is
now the design record: what the system is, what the measurements said, the
judgment calls with their reasoning, and the short list of what remains.

## The problem it replaced

Scene graphs are pull-based — `runNode(..., asDataNode = true)` resolves
inputs on demand — but every edge was a fully materialized `Value`
(string / JsonNode / Image), so peak memory was the sum of everything live
along the deepest active path, each realized whole before its consumer
started.

The escape hatch was a ~120-line "decode-into-canvas hint" block in
`interpreter.nim`: a hardcoded whitelist of 8 producer keywords, a
full-frame-draw pattern match, a second variant for cached producers, and a
carve-out inside that for contain+overwrite. It fused exactly one graph shape,
and every new app or shape meant editing the scheduler. The motivating
symptom: inserting `render/opacity` between a producer and `render/image`
both broke the fusion *and* added a full-frame copy. On the byte side,
`downloadUrl → icalJson` buffered multi-MB feeds whole to extract a handful
of events.

That block is gone. Apps declare capabilities; a generic planner decides.

## Design

### Principles

1. **Invisible in the editor.** Users never see a stream port, a protocol
   picker, or an adapter node. The graph they draw is the graph they draw.
   Negotiation artifacts surface only in debug logs and runtime checkpoints.
   No frontend or scene-JSON schema changes.
2. **Adding an app never requires editing the scheduler.** Capabilities are
   declared by the app; the planner is generic. Unsupported combinations
   degrade to a lower tier, never to a special case.
3. **Tiered fallback, always terminating in yesterday's behavior.** Every
   negotiation has a materialized floor. Images: fused-into-target >
   canvas-sized scratch > budgeted materialize. Bytes: in-memory > spool to
   SD/disk > bounded error. The node cache mirrors it for what it *holds*:
   in-memory > spool to SD/disk > store nothing. A failed storage probe
   degrades to memory rather than raising — a frame with no SD card must not
   start failing downloads that used to work.
4. **Fused output == materialized output.** Anything that would change pixels
   is either encoded as a planner rule or stays unfused — enforced by
   differential harnesses, not by review. Where a measured trade deliberately
   spends this principle (see "the SVG decision"), the check gets sharper,
   not looser.
5. **Correct first on embedded, then port wins back.** ESP32 runs interpreted
   scenes only, so the interpreter was the proving ground; compiled scenes
   adopted the same negotiation at codegen time once the rules had survived
   hardware.

### Capability model

Each app declares, per port, which protocols it supports — in `config.json`
next to the existing `output` types. Absent means `materialized`, the floor
every edge always supports. The typed registry is generated into
`src/apps/apps.nim` by `apps_nim.py`; `frontend/src/types.tsx` documents the
schema; `frameos/app_capabilities.nim` holds the types.

| Protocol | Declared on | Meaning | Used by |
|---|---|---|---|
| `materialized` | — | whole value returned (the floor) | everything |
| `intoTarget(fit)` | output port | producer writes into a caller-supplied `Image` with the requested fit | the 8 former whitelist producers, `render/calendar`, `render/gradient`, `render/color` |
| `providesTarget` | input port | consumer offers a target to whatever feeds this input | `render/image` |
| `forwardsTarget` | output port | transformer passes the target request upstream and mutates in place | `render/opacity`, `data/rotateImage` at 180° |
| `byteIter` | input port | consumes a string as a bounded-window `Spool` | `icalJson` |
| `forwardsBounds` | output port | passes the consumer's useful-resolution bounds upstream, transformed (swap for 90/270 rotations, replace for resizes) | `data/rotateImage`, `data/resizeImage` |
| `rowStream` | — | reserved for phase 3 (gated; see "What remains") | — |

The declarations carry their own preconditions, so the planner stays generic:

- `fitFrom` / `fits` — which config field carries the fit, and which fits
  this end of the edge accepts. The special fit `natural` marks a producer
  whose output is target-sized under *every* placement (generators, JS apps),
  so `center`/`top-left` reduce to the same 1:1 draw and stop blocking.
- `requireStatic` — field → the values it must statically resolve to
  (`blendMode` ∈ {normal, overwrite}, `offsetX` = 0, …). A field wired to
  anything but a state node never resolves, and so never satisfies this.
- `compositingRequireStatic` — extra constraints when the terminal producer
  *composites* into the target (a JS app draws source-over) instead of
  overwriting every fitted pixel: `render/image` requires plain `normal`
  blend there, because an erasing blend of a possibly-transparent
  materialized image is not the same picture as a composite.
- `requireUnset` — fields that must be neither configured nor wired, for the
  "draw on top of this image instead" inputs that change what a node does.
- `requireOpaqueColor` — fields whose statically-resolved color must provably
  parse fully opaque. The "output is opaque given these fields" promise that
  lets a generator (`render/gradient`, `render/color`) fill its target in
  place: opaque paint makes a set and a composite the same picture. Anything
  else — semi-transparent, wired, unparseable — stays on the floor, because
  "tint the photo" must never erase the photo.
- `ownedTargetExcludes` — field/value combinations where an app-*owned*
  scratch would not produce the same pixels as a materialized value
  (contain+overwrite: the scratch's transparent letterbox margins would be
  carried over the canvas). The live-canvas tier is unaffected — it has no
  margins of its own.

Explicitly opaque (always materialized): code nodes and inline expressions,
child scenes, `render/split` cells. Dynamic JS *apps* are not opaque — they
are natural-fit producers (see below).

### Planner

`frameos/planner.nim` runs when a scene loads, not per render: the graph is
static between deploys, so the plan is too. Per-render facts (is there a
canvas, what does a state-wired fit say right now, will the cache refuse the
value) stay cheap runtime checks against the cached plan. The planner reports
**refusals** (`FusionRefusal`) instead of only deciding, so "why is this
scene not fusing" is a log line, not an archaeology project.

The rules, each one declarative check:

- **Cache is a materialization barrier.** A cached node can't own the live
  canvas and can't sit mid-chain in a one-shot handoff. A cached terminal
  producer still must not decode at native resolution — it gets a
  canvas-*sized* target it allocates itself, which its cache may safely own.
  A placement wired from a state field can't feed a cached producer either:
  the cache would bake in a fit that changes per render and keep serving the
  stale one (natural producers are exempt — they have no fit to bake).
- **Semantics-changing shapes don't fuse.** contain+overwrite over a scratch;
  wired/inline inputs on placement-affecting fields that aren't a pure state
  read; blends beyond normal/overwrite; a compositing producer under any
  consumer blend but plain normal.
- **Opaque nodes materialize** (code nodes, child scenes, split cells).
- **A forwarding hop forces the owned tier.** A transformer that mutates in
  place has to own what it mutates: not the live canvas (the consumer will
  composite onto it, and everything outside the fitted rect belongs to
  whatever rendered before), and not a cached producer's value (shared with
  every later render — opacity applied once looks right and twice looks
  wrong, which is exactly what the differential's second frame checks).
- **The embedded cache upgrade.** A cached producer forces the owned tier so
  its cache never holds the canvas — but embedded `withCache` refuses to
  hold frame-sized images in *memory*, so above that size the entry either
  spills to storage (see "the image cache disk tier") or is not stored at
  all. The scratch is only worth its PSRAM in the first case: when there is
  no storage, or no headroom to carry a scratch next to the canvas
  (`availableRenderBytes < 2×scratch` — the 13.3E6, whose canvas is 7.7MB),
  the runtime upgrades back to the live canvas and the cache stores nothing,
  yesterday's behavior exactly. The plan records *why* it chose the owned
  tier so the runtime can make that call per render. A scratch owed to a
  *transformer* is never upgraded; `test_interpreter_decode_target.nim` pins
  the distinction.

### The handshake, and claimed vs. applied

`takeDecodeTarget` in `utils/app_images.nim` is the producer's half of
`intoTarget`: the offer is **addressed** (only the node the planner named may
take it) and **one-shot** (taken targets are cleared, so a sibling edge can't
inherit one). `mayMutateImageInPlace` is the `forwardsTarget` half: it says
yes only after the producer actually took the target, so a chain that failed
to fuse never has a transformer scribbling on a value it doesn't own — and a
producer that takes the target and then *raises* withdraws the clearance, so
the embedded error path can't hand the live canvas to a transformer to fade.

The node profile reports both `applied` (the offer was made this pass) and
`claimed` (the planned producer actually took it), because the two are not
the same thing and the difference once hid a bug for the whole branch: an
unclaimed offer is free by design, so `wikicommons` showed "fused:
liveCanvas" in every inventory while allocating its own 1.7MB target on
embedded — invisible until a fragmented heap came up 1,668 bytes short. The
plan is not the claim; now one log field says which you have.

## What shipped

### The image side

- The whitelist block is deleted; the 8 producers + `render/calendar` declare
  `intoTarget`, `render/image` declares `providesTarget`, and the planner
  wires every edge. Two tiers above the floor: the live canvas (uncached
  producer decodes straight into it) and a canvas-sized owned scratch
  (cached producers, forwarding chains).
- **Transformers forward.** `render/opacity` skips its full-frame `.copy()`
  when cleared to mutate in place — the motivating symptom, fixed by the
  general mechanism. `data/rotateImage` forwards at 180° (the
  dimension-preserving rotation), where two in-place flips *are* the
  rotation; 90°/270° change the output's dimensions and stay on the
  allocating path.
- **JS apps are natural-size producers, not opaque walls.** A JS app asks the
  runtime for an image whose default size is the context's and draws into it;
  handing it the target instead is `intoTarget` with a natural fit. It is
  offered, never assumed — the runtime peeks at the offered size and takes
  the target only in the branch where it would have allocated one of exactly
  that size, and a plain-canvas spec with a semi-transparent `color` fill
  refuses the live canvas (a fill is a set, not a composite).
- **SVG rasterizes into the offered target** (`renderInto` in the pixie fork,
  `renderSvgIntoTarget` in `utils/image.nim`) — including the live canvas.
  That was a measured decision; see below.
- **`render/split` cells are views, not copies.** The pixie fork gained
  `view(image, x, y, w, h)`; a cell writes straight into the canvas with no
  copy out and no draw back, and a nested split collapses from 1.75× the
  canvas to 1.00×. Measured on the Weather scene: **516KB less peak PSRAM**
  on a single level. The pointer indirection benchmarked at zero
  (`tests/bench_view_cost.nim` in the fork), and five pre-existing pixie bugs
  fell out of the conversion — the sharpest being `isOpaqueSse2` answering
  for the wrong range whenever `start != 0`.

### The byte side

- `Value` gained `fkSpool`, backed by `frameos/spool.nim`: in memory below a
  live-memory-derived threshold, file-backed above it with one window
  resident, `materialize` as the floor (which raises past a byte limit
  rather than attempting the allocation that takes the device down).
  `asString()` materializes, so every existing consumer is unchanged;
  `asSpool()` works on a plain string too, so a new consumer never branches
  on the tier. Spill files are process-uniquely named and owned by the value
  (`=destroy` removes them); cache keys hash a spooled body windowed instead
  of materializing it.
- Apps opt in with `byteIter` on a config.json field; the loader hands them a
  `Spool`. The editor still sees a plain string — capabilities are a runtime
  contract (principle 1).
- **The body never exists whole anywhere.** `boundedGetSpool` streams host
  downloads off the socket into the spool writer chunk by chunk; on embedded
  it **adopts the spill file `boundedRequestBuffer` already produced** as the
  spool's backing file (the download that used to be refused with "too large
  to load into memory" now costs a window to consume) and windows
  PSRAM-chunked bodies past the threshold. Redirect hops and error bodies
  still materialize — they are about to become a Location read or an error
  message.
- **The fold honours the asymmetry twice.** `icalJson` folds the spool a line
  at a time (CRLF, LF and bare CR alike), and applies its export window
  *during* the fold: one-off events outside it are dropped as they are
  parsed, while recurring masters and RECURRENCE-ID overrides are kept
  regardless of their own dates. A multi-year subscribed feed keeps the
  window's events resident, not its history — the first hardware run proved
  the raw bytes could cross the edge for 8KB while ~3.5MB of parsed VEvents
  OOM-aborted the render anyway.
- Deliberately **not** built, with the reasoning recorded: folding the ICS as
  the socket delivers it, with no spool file. The parse never needs the file,
  but the file is not there for the parse — it makes the edge a re-readable
  `Value` (cacheable, two consumers, `asString` still works) and decouples
  transport speed from parse speed. Its memory cost over a socket fold is
  zero: one window either way. The single case where a socket fold buys
  memory is a frame with **no writable storage**, where the over-threshold
  body today degrades back to being held whole. That frame appearing is the
  trigger to build it.

### The image cache disk tier (2026-08-12, post-ship follow-up)

The byte spool's question, asked for pixels: does a cached image have to be
*in memory* to be cached? On embedded the answer used to be a forced trade —
`withCache` refused frame-sized images, so every shipped photo scene's
4-hour cache stored nothing and the producer re-downloaded on every render.
The cache's duration setting silently meant nothing above 1MB.

`Value` gained `fkImageSpool`: an image whose pixels sit in a spill file as
raw premultiplied RGBX rows (`ImageSpool` in `frameos/spool.nim`, pixel IO in
`utils/image.nim`). `withCache` stores one when the fresh image is over the
in-memory limit, and a hit materializes it back — the same swept `.cache`
directory, naming scheme and ownership rules as the byte spool (`=destroy`
removes the file; a replaced entry deletes its predecessor's).

Three rules make it correct rather than merely plausible:

- **Only pixels the producer alone wrote are spilled.** An owned scratch or a
  self-allocated image is exactly the value a memory cache would have held,
  so the file is pixel-exact *by construction* — principle 4 with nothing to
  verify. The live canvas is never spilled: a contain fit leaves margins
  holding whatever rendered before the producer that pass, and a compositing
  producer (JS, SVG) blends over the same, so a canvas snapshot would replay
  a stale background over later renders. `withCache` refuses by buffer
  identity, which also catches error frames painted into the canvas.
- **A hit that cannot be served is a miss.** File swept, card pulled,
  truncated write, or no memory to read it back into (the floor read checks
  `availableRenderBytes` before allocating) — the entry is dropped, its file
  with it, and the producer recomputes. Every failure lands on yesterday's
  behavior; nothing raises.
- **The disk tier is why the scratch exists.** The offer-time upgrade (see
  the planner rules) now keeps the owned scratch when storage and headroom
  are there, so the miss decodes into a scratch the cache can actually keep —
  and upgrades to the live canvas when they are not. One failed spill write
  latches the tier off until scenes reload, so a full card is probed once,
  not per render.

What a hit costs: one canvas-sized allocation for the length of the consumer's
draw (freed with the render), against a re-download, a decode and its
intermediates. What a miss adds: one sequential file write of `w×h×4` bytes.
Streaming a hit straight into the offered target — window-resident, no
transient allocation — is deliberately not built; its trigger is written
under "What remains".

Pinned by `test_image_spool.nim` (roundtrip byte-exactness for owners *and*
strided views — a split cell's canvas is a view — ownership, truncation, the
budget refusal) and `test_interpreter_cache_spool.nim` (the producer paints a
different colour per call, so "served from disk" and "recomputed" are
distinguishable in the canvas itself; plus the swept-file miss, the
no-headroom upgrade, and the under-limit memory path staying untouched).
Not yet hardware-verified — the checklist is in "What remains".

### requestedBounds (2026-08-12, post-ship follow-up)

The last ungated item, shipped. An image edge the fusion planner leaves
materialized — a 90/270 rotation mid-chain, a resize, a refused blend —
still carries the consumer's useful resolution *up*, so the terminal
producer decodes bounded instead of at native resolution. A rotate-90 scene
used to decode a 4000×3000 source whole (48MB of RGBA on a Pi, a budget
refusal on an ESP32) to feed an 800×480 canvas; it now decodes at the
canvas's cover scale.

The protocol mirrors the decode target deliberately: bounds ride the
context, addressed to the planner-named producer, one-shot, free if
unclaimed, reported claimed-vs-applied in the node profile. What differs is
the contract's strength, and the design question the doc recorded resolves
exactly here: a bounded decode **resamples where the floor decodes native**,
so bounded output is *equivalent, not byte-identical* — accepted on all
platforms (2026-08-12 decision) now that the scaled decoders box-filter.
Consequences of that weaker contract:

- **Bounds are an upper limit with cover semantics** — enough pixels for any
  placement into the box, aspect preserved, never upscaled — so the
  consumer's blend and offsets don't matter, only inputs that change what
  the node draws (`requireUnset`).
- **Geometry is static or absent.** `forwardsBounds` hops either swap
  (90/270), keep (0/180), or replace (a resize's own dimensions); an
  arbitrary angle or a wired field refuses the plan. A missing bound is the
  floor; a wrong bound would be a bug.
- **Its own kill switch** (`FRAMEOS_DISABLE_BOUNDS`), separate from fusion's,
  because the pixel-exact differentials run with bounds off — the bounded
  behavior gets a classified comparison instead (geometry and mean color
  against the native decode, `test_interpreter_decode_bounds.nim`).
- Natural producers have nothing to bound; fused edges already have a
  target, which is stronger. Interpreted-only, like forwarding chains.

Pinned by eight planner-rule cases and the end-to-end interpreter test;
`data/rotateImage` and `data/resizeImage` declare, no app code changed —
producers pick bounds up through the shared download funnel.

### Compiled scenes (parity)

`scene_nim.py` applies the planner's rules at codegen, where the graph is
static (`plan_decode_target` / `wrap_with_decode_target`), and emits the same
hint block around the producer call that the interpreter builds at scene
load: live canvas for an uncached producer, owned scratch for a cached one,
and the same refusals for erasing blends, wired placements, cached consumers
and the contain+overwrite scratch shape. Apps consume the offer through the
identical `takeDecodeTarget` handshake, so nothing app-side changed. Scoped
deliberately to direct producer → consumer edges with fully static configs;
forwarding chains, JS producers and state-wired fits stay interpreted-only —
no shipped scene compiles those shapes. Declared natural-fit producers
(gradient/color) do compile, with the opaque check held narrower than the
interpreter's: hex-only, which is all a compiled config can hold anyway.
Spool ports convert at the compiled boundary (`materialize` / wrap), keeping
compiled output typed as before.

The cloud path needed nothing, as predicted: interpreted scenes ship the
runtime's planner, and the bench frame's nine scenes — prod-cloud-deployed
scenes.json — all rendered through it on the ESP32.

## Evidence

### The differential harnesses

- `test_interpreter_fusion_differential.nim`: 360 generated permutations of
  producer × transformer × placement × blend × cache × source-size, each
  rendered twice per mode, asserting fused == materialized pixels *and* that
  the planner's decision matches the rules restated independently in the
  test. Mutation-checked: relaxing the cached-producer forwarding rule fails
  on both the decision and the pixels. Its two measured, pre-existing
  divergences: the fit-boundary (a decoder overwrites where a materialized
  draw composites, so the two disagree within a pixel of the fitted rect's
  edge — held still by comparing exactly at canvas size and over the fitted
  interior when scaled) and the sampling of streaming decoders — nearest
  when this was written; a box filter since 2026-08-12 (below), which keeps
  the same property: exact at canvas size, resampled when scaled.
- `test_repo_scenes_differential.nim`: the same A/B over every offline-safe
  shipped sample scene — **9 scenes pixel-exact**, with a bracketed
  self-determinism probe so a clock or a random picker (Ken Burns) is
  skipped by name, never silently. `tools/wasm_differential.py` runs the
  identical comparison through the emscripten build the browser preview and
  thin-client path use: **9 scenes byte-identical** there too. Both count
  fused edges, so a capability regression that silently unfuses everything
  fails loudly instead of comparing two materialized floors.
- `test_repo_scenes_fusion.nim`: the inventory. **26 scenes, 19 image edges,
  17 fused** (run with `FRAMEOS_FUSION_INVENTORY=1` for the table). The two
  refusals are `chromiumScreenshot` and `rstpSnapshot` — host-only apps that
  could not honour a declaration, which is exactly the bespoke hack this
  design exists to avoid.
- Planner rules are unit-pinned in `test_planner_rules.nim`; the byte side's
  whole graph in `test_byte_tier_scene.nim` (a 2.4MB ICS over real HTTP
  under an ESP32-sized budget); the spool tiers, the keep-window and the
  streaming client in `test_spool.nim`, `test_spooled_ical.nim`,
  `test_http_client.nim`.

### What the hardware said (7.3" PhotoPainter, EPD_7in3e 800×480)

`set fusion 0|1` re-plans the live scene; `usb_api image` pulls the packed
4bpp panel preview. A control — two fused renders — differs in **0 of
192,000 packed bytes**, so the pipeline is deterministic and every
difference below is real.

| result | numbers |
|---|---|
| Calendar, fused vs materialized | **identical** panels; principle 4 through the real dither |
| Weather (2 JS panels, split, SVG) | **identical** panels; both edges `liveCanvas, fit: center` |
| XKCD (cached producer, contain, split cell) | fused renders; materialized shows the budget error frame — *fusion is the difference between rendering and not* |
| SD card image producer | fused: **912 B / 411 ms**; materialized: 508 KB / 2.8 s |
| Byte tier (3.24MB / 11,000-event ICS, forced spill) | spool **adopted the C spill file**; the edge held **8,192 bytes**; 35KB of events out; calendar on the panel |
| Opacity mid-chain (uploaded scene) | fused + claimed + in-place; **byte-identical across reboots and repeats**; ~10KB heap vs 2.4MB materialized |
| All 9 shipped scenes | render clean on the final firmware |

Two lessons from the passes that changed the code:

- **The floor resamples.** On the device, the materialized floor
  budget-scales its decodes (an 800×480 source decoded at 703×421), so
  byte-parity against the floor is unattainable for any non-tiny source —
  the divergence *is* the cost fusion removes. Where an A/B cannot be exact,
  it is classified instead: do the palette flips cancel, and did the mean
  colour move? Grain passes both; a wrong fit, a missed draw or an error
  frame fails one.
- **The plan is not the claim.** See "claimed vs. applied" above; the
  all-scenes sweep is also what found the unbudgeted SVG rasterization
  (a demo-card `placeholder.svg` declaring 1024×1024 — SVG now gets the same
  display/budget bounds as every raster format) and the JPEG decode plan
  gaps in the fork (upsample peak and output image now counted, so
  over-budget decodes refuse catchably instead of OOM-aborting the render).

### The SVG decision: take the memory

On a freshly allocated (transparent) target, rasterizing an SVG in place is
bit-identical to rendering standalone and drawing the result — pixie's test
pins that. On the **live canvas** the two are equal only in exact arithmetic:
source-over is associative, 8-bit quantization is not. Measured on the frame
for Weather's SVG panels: content, layout and mean colour identical; 42% of
pixels moved between two adjacent palette entries, 98% of them a single
index pair swapping — the dither pattern changing phase; and the saving was
**614KB + 921KB and 5.2s per render** on a frame with ~6.6MB free.

Decision (2026-08-11): take the memory. The SVG path claims whatever target
it is offered, including the live canvas. This deliberately spends some of
principle 4, so the check became sharper rather than looser: the panel
comparison classifies grain vs content (flip symmetry + mean colour), rather
than failing on every run for a reason nobody cares about. Measured: 5,417
flips one way, 5,415 the other, mean colour `rgb(101,138,172)` in both.

### The split-view caveat, written down

A cell that borrows its parent's pixels is the same pixels by construction —
with one bounded exception. A child drawing with an *erasing* blend
(`overwrite`, `mask`, `inverse-mask`) over a transparent source now writes
that transparency through to the canvas, where the copy path flattened it on
the normal-blend draw back. The new behaviour matches what the same node does
*outside* a split, so cells are consistent with the top level instead of
quietly different — but it is a behaviour change with no kill switch, and the
display path flattens punched alpha to black. If a scene that relied on the
old flattening turns up, the fix is a planner-style rule for cells, not a
revert.

<details><summary>The original image-view design note, kept for the reasoning</summary>

pixie's `Image` owned its buffer — `data*: seq[ColorRGBX]` — and a Nim `seq`
cannot be aliased. The contained design was a `ref seq` buffer with
`stride`/`origin`, keeping `data` a template so all 238 existing `.data[...]`
sites compiled unchanged, with the ~25 flat loops and 7 `copyMem` sites
audited by hand. What landed was slightly different and better: `data` became
a raw pointer (no extra dereference at all) and `forEachSpan` gave flat
operations one span for an owner — which is why the benchmark came back flat.

</details>

### Transformer audit

- `render/opacity` — **forwards**, shipped.
- `data/rotateImage` — **forwards at 180°**, shipped (two in-place flips).
  90°/270° change the output's dimensions and keep the native-resolution
  intermediate — see "What remains".
- `data/resizeImage`, `render/zoomPan` — **no**: their configured crop
  followed by the consumer's fit is not the consumer's fit applied directly.
  The useful move is the opposite direction — passing bounds *up* so the
  decode is bounded — which is the `requestedBounds` idea below.
- `render/gradient`, `render/color` — **shipped 2026-08-12** as the first
  *declared* natural-fit producers, via the "output is opaque given these
  fields" capability the audit called for: `requireOpaqueColor` on
  `intoTarget`. An opaque fill overwrites every pixel of its target, so a
  set and a composite are the same picture and the generator may paint the
  live canvas in place — under *every* static placement, since its output is
  target-sized. Only a value that provably parses opaque fuses; a
  semi-transparent color ("tint the photo" — `rgba(...)`, since 8-digit hex
  does not parse), a wired color, or an unparseable one stays on the floor,
  where render/image composites it. Compiled scenes apply the same rule with
  a narrower check (hex-only; configs there can only hold opaque 6-digit hex
  anyway, so the compiled hazard is exclusively a wired color). Pinned by
  `test_planner_rules.nim` (decisions), `test_opaque_fill_fusion.nim`
  (fused == floor pixels, and the semi-transparent floor still tints), and
  `test_scene_nim.py` (compiled parity).

## What remains

Everything here is gated or deliberately deferred, with its trigger written
down.

- **Phase 3: row streams.** The prize is a 4000×3000 JPEG onto an 800×480
  canvas in a few hundred KB of row buffers. The gate was checked twice and
  says no: after phases 0–1, every image edge on the bench frame costs
  either nothing (fused into the canvas) or one canvas-sized value a row
  stream could not remove, and the chains row streams were designed for —
  uncached producer → pointwise transformer → canvas — occur in no shipped
  scene. **Reopens when**: a transformer-mid-chain scene ships (the shape
  now works, fused, without streams), or a panel where the canvas alone is
  the problem — on the 13.3E6 the canvas is 7.7MB. If built: producer emits
  scanlines at target resolution, consumers are the canvas draw and
  pointwise ops, fallback points materialize automatically. The
  quality-preserving streaming scaler this was gated on **exists as of
  2026-08-12**: pixie's scaled decodes box-average each target pixel's exact
  source footprint (JPEG through banded accumulators, WebP over its resident
  buffers), byte-identical at 1:1 and on upscales, and the sample walk no
  longer wobbles through image coordinates. Built because Wikimedia started
  serving 960px thumbs for 800px requests, which turned the wikicommons
  scene's designed 1:1 decode into a 5/6 nearest downscale — visibly ragged
  through the panel dither, before/after verified on the 7.3" PhotoPainter.
- **Pico thin-client wire format** — behind phase 3; its row-stream protocol
  would be the natural wire format for host-rendered scanlines.
- **`requestedBounds` — shipped 2026-08-12** (see "What shipped"). The
  design question it carried was answered "everywhere": bounded output is
  equivalent rather than byte-identical on hosts too, acceptable once the
  scaled decoders box-filter. What remains of it: `render/zoomPan` declares
  no bounds (its useful input resolution scales with the zoom factor —
  needs a multiplier field in the schema if a scene ever needs it), and
  compiled scenes stay on the floor like every dynamic shape.
- **`xmlToJson` / `parseJson` / `prettyJson` stay materialized on purpose**:
  phase 0 measured their inputs at 2.5–20KB on real scenes, three orders of
  magnitude below the image side. Nothing to buy yet.
- **The socket-fold** for byte inputs — trigger: a frame with no writable
  storage (reasoning under "The byte side").
- **The image cache disk tier on hardware — checklist run 2026-08-12**, and
  it earned its keep by finding three things rather than confirming one.
  (1) The tier was refusing *silently*: nothing said why a scene
  re-downloaded every render — spill decisions are log lines now, reasons
  and numbers included, which is how the rest was found. (2) The headroom
  predicate asked its coexistence question against `availableRenderBytes` —
  the largest-contiguous-block answer — and the bench frame runs fragmented
  enough (~1.7MB blocks inside 5MB free) that no spill it could afford ever
  passed; the check now splits into contiguous-for-the-scratch plus
  total-free-for-the-headroom. (3) The shipped corpus barely exercises the
  tier at all: the Wikimedia sample's producer declares
  `cache.enabled: false`, and XKCD's split-cell scratch lands 14KB *under*
  the 1MB in-memory limit — the memory tier legitimately holds it. A
  dedicated over-limit cached scene verified the spill path end to end on
  the frame. Still open: the mid-life card-pull degradation is host-pinned
  only (the USB asset API refuses writes to dot-paths by design, so the
  file cannot be deleted remotely), and the 13.3E6's upgrade-to-live-canvas
  is arithmetic (7.7MB scratch against ~5MB headroom), not yet observed.
- **Streaming a spooled cache hit into the offered target.** A hit today
  costs one transient canvas-sized allocation; reading the file row-by-row
  into the offer would make it window-resident. Deliberately not built: the
  transient is freed within the render and is far below the miss path's
  decode peaks, and writing into the *live canvas* form of the offer is only
  correct for full-overwrite fits — the same fit-rect reasoning that keeps
  canvas snapshots out of the cache. Trigger: a panel where the transient
  alone breaks the render (a 13.3E6-class canvas after its upgrade predicate
  is met some other way), and then only for the owned-scratch offer form
  unless the fit question is settled.
- **The split erasing-blend caveat** — watch item, not work: fix is a
  planner-style rule for cells if a relying scene appears.

## Non-goals

- Streaming through JS/QuickJS code nodes. Opaque forever until proven
  necessary.
- Editor-visible pipeline configuration of any kind.
- Host-side streaming decode. (Its old precondition — a quality-preserving
  scaler — exists since 2026-08-12; what still gates it is a shipped scene
  that needs it.)
- Image proxies. (Standing hard rule — the fix is always on-device.)
