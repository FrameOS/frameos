# Value pipeline: capability-negotiated execution

Design + work tracker for replacing the interpreter's ad-hoc decode-target
fusion with a general capability-negotiation layer, so low-memory targets
(ESP32 today, Pico thin-client and armv6 tomorrow) stop accumulating
per-shape special cases. Written 2026-08-10 after an architecture review;
open items live at the bottom, delete them as they ship.

**Status (2026-08-11):** phases 0, 1 and most of 2 have landed. The whitelist
is gone, apps declare capabilities in `config.json`, `frameos/planner.nim`
decides each image edge at scene load, and the byte side has a spool tier that
`icalJson` folds over without materializing. The hardware pass ran on a 7.3"
PhotoPainter — see "What the hardware said". Phases 3 and 4 are untouched, and
the measurement says phase 3 is where the remaining memory is.

## The problem, precisely

Scene graphs are already **pull-based** — `runNode(..., asDataNode = true)`
resolves inputs on demand (`frameos/src/frameos/interpreter.nim`). The
problem is that **every edge is a fully materialized `Value`**
(`frameos/src/frameos/types.nim`, tagged union of string / JsonNode /
Image): peak memory is the sum of all live values along the deepest active
path, each realized whole before its consumer starts.

The existing escape hatch is the decode-target hint
(`interpreter.nim` "Decode-into-canvas hint" block, ~100 lines). It fuses
exactly one graph shape — *whitelisted producer → `render/image` drawing
full-frame* — by pattern-matching in the scheduler:

- a hardcoded list of 8 producer keywords (`decodeTargetProducers`);
- only when the consumer's cache is off, offsets are 0/unset, blend is
  normal/overwrite, placement is cover/contain/stretch, and no input is
  wired or inline on `offsetX`/`offsetY`/`blendMode`/`inputImage`;
- a second variant (`decodeTargetWidth`/`Height`) because a cached
  producer must not be handed the live canvas;
- a carve-out inside that for `contain` + `overwrite` (letterbox margins
  differ between live-canvas and scratch paths).

Symptom of the wrong architecture: inserting `render/opacity` between a
producer and `render/image` both breaks the fusion *and* adds a full-frame
copy (`apps/render/opacity/app.nim` `get()` calls `.copy()`). Every new
app or graph shape means editing `interpreter.nim`.

Facts that scope the work:

- **ESP32 runs interpreted scenes only** (`_frame_deployer.py` ships
  `get_interpreted_scenes_json`; the embedded runtime has no compiled
  scenes). The interpreter is the only scheduler that matters for
  embedded. Compiled scenes (hosts) have **no fusion at all** in
  `backend/app/codegen/scene_nim.py`.
- Streaming decode **into a target** already exists in the pixie fork:
  `decodeJpegStreamScaledInto`, opaque-PNG streaming (embedded-only)
  — `frameos/src/frameos/utils/image.nim`. What's missing is composable
  row-wise operators between producer and canvas, not the decoders.
- Streaming decoders sample **nearest-neighbor**. Invisible on embedded
  (embedded `scaleAndDrawImage` already routes through
  `drawScaledNearest`), but on hosts it would visibly degrade scaled
  output and make interpreted scenes diverge from compiled ones — the
  reason PNG streaming is embedded-only today (comment in `image.nim`,
  `readImageIntoTarget`). Host-side fusion is therefore gated on a
  quality-preserving streaming scaler and is out of scope until then;
  hosts already bound decodes via `decodeImageWithDisplayBounds` budgets.
- Fusion has already changed output once: the XKCD contain/cover
  regression (documented in `utils/app_images.nim`,
  `downloadImageWithDataForContext`). Correctness tooling is not optional.
- The byte-side case (`downloadUrl` → `icalJson` → `eventsToAgenda`) is a
  **fold, not a stream-through**: only the *input* is multi-MB
  (`boundedGetContent` buffers whole bodies); `icalJson`'s output is
  small. It needs an incremental parser and a place other than RAM for
  the raw bytes — not a general stream protocol.

## Design

### Principles

1. **Invisible in the editor.** Users never see a stream port, a protocol
   picker, or an adapter node in the UI. The graph they draw is the graph
   they draw. Negotiation artifacts surface only in debug logs / runtime
   checkpoints. No frontend or scene-JSON schema changes.
2. **Adding an app never requires editing the scheduler.** Capabilities
   are declared by the app; the planner is generic. Unsupported
   combinations degrade to a lower tier, never to a special case.
3. **Tiered fallback, always terminating in today's behavior.** Every
   negotiation has a materialized floor. Preference order for images:
   fused-into-target > canvas-sized scratch > budgeted materialize. For
   bytes: in-memory > spool to SD/disk > bounded error. Spooling is a
   permitted tier but the planner prefers not to reach it (flash wear,
   latency, SD may be absent — probe first).
4. **Fused output == materialized output.** Anything that would change
   pixels (the contain+overwrite letterbox case, nearest vs smooth
   sampling on hosts) is either encoded as a planner rule or stays
   unfused. Enforced by a differential test harness, not by review.
5. **Correct first on embedded, then port wins back to hosts/compiled.**
   Interpreter changes reach cloud-managed frames for free (same
   runtime); compiled-scene codegen adopts the same negotiation at
   codegen time later, where the graph shape is static.

### Capability model

Each app declares, per image/string/json port, which protocols it
supports — in `config.json` next to the existing `output` types (schema
addition is backward-compatible; absent means `materialized`):

| Protocol | Declared on | Meaning | Examples |
|---|---|---|---|
| `materialized` | — | whole value returned (the floor, always supported) | everything |
| `intoTarget(fit)` | output port | producer writes into a caller-supplied `Image` with cover/contain/stretch | the 8 former `decodeTargetProducers`, `render/calendar` |
| `providesTarget` | input port | consumer offers its own target to whatever feeds this input | `render/image` |
| `forwardsTarget` | output port | transformer passes the target request upstream and mutates in place | `render/opacity` |
| `rowStream` | — | produces/consumes scanlines (phase 3) | streaming decoders → row ops → display driver |
| `byteIter` | — | consumes a string as a bounded-window iterator (phase 2) | `icalJson`, `xmlToJson`, `parseJson` (maybe) |

The declarations carry their own preconditions, so the planner stays generic
(`frameos/app_capabilities.nim` for the types,
`backend/app/codegen/apps_nim.py` for the emission):

- `fitFrom` / `fits` — which config field carries the fit, and which fits this
  end of the edge accepts.
- `requireStatic` — field → the values it must statically resolve to
  (`blendMode` ∈ {normal, overwrite}, `offsetX` = 0, …). A field wired to
  anything but a state node never resolves, and so never satisfies this.
- `requireUnset` — fields that must be neither configured nor wired, for the
  "draw on top of this image instead" inputs that change what a node does.
- `ownedTargetExcludes` — field/value combinations where an app-*owned* scratch
  would not produce the same pixels as a materialized value. The live-canvas
  tier is unaffected, because it carries no margins of its own.

Explicitly opaque (always materialized, no exceptions): JS/QuickJS code
nodes and inline expressions, child scenes, `render/split` cells (each
cell is its own subgraph with its own canvas region — revisit only if
data shows it matters).

### Planner

Runs in the interpreter when a scene loads (and on scene reload), **not
per render** — plans are cached per node, keyed by the graph shape, which
is static between deploys. Per-render dynamic facts (does the context
have an image, is a cache warm) stay cheap runtime checks against the
cached plan. Per-edge output: chosen protocol + any adapter.

Planner rules (each is one declarative check, replacing today's inline
pattern-match):

- **Cache is a materialization barrier.** A cached node can't own the
  live canvas and can't be a one-shot stream. But cache the
  *canvas-sized* render, not the native-resolution intermediate — the
  generalization of today's `decodeTargetWidth` variant. A placement wired
  from a state field can't feed a cached producer either: the cache would
  bake in a fit that changes per render and keep serving the stale one.
- **Semantics-changing shapes don't fuse.** contain+overwrite; any
  wired/inline input on placement-affecting fields that can't be resolved
  to a pure state read; blend modes beyond normal/overwrite; a
  *compositing* producer (a JS app draws source-over, it doesn't overwrite
  its fitted rect) under any consumer blend but plain normal
  (`compositingRequireStatic` in the capability schema).
- **Opaque nodes materialize** (JS, child scenes, split).
- **Tier selection** per principle 3, with byte-spool requiring a
  successful storage probe.
- **A forwarding hop forces the owned tier.** A transformer that mutates in
  place has to own what it mutates. Not the live canvas — the consumer is
  going to composite onto it, and everything outside the fitted rect belongs
  to whatever rendered before. Not a cached producer's value either, which is
  shared with every later render: applying opacity to it once looks right and
  twice looks wrong, which is exactly what the second frame of the
  differential harness checks.

Adapters (`materialize`, `spoolToDisk`, `chunkToIter`) are planner-owned
shims, not editor nodes — but they carry node identity in debug output
and runtime checkpoints (`markRuntimeCheckpoint` already exists) so
memory attribution names them.

### What this deleted

The entire "Decode-into-canvas hint" block in `interpreter.nim` — whitelist,
full-frame-draw detection, cached-producer variant, contain+overwrite
carve-out, ~120 lines — is gone. `render/image` declares in its `config.json`
that it can *provide* a target when its own draw is full-frame; producers
declare they *accept* one; `render/opacity` declares it *forwards* one. The
planner wires it, and what is left at the node is a plan lookup plus the facts
that genuinely vary per render. `takeDecodeTarget` in `utils/app_images.nim`
is now the internal handshake of the `intoTarget` protocol, with
`mayMutateImageInPlace` as the `forwardsTarget` half: it answers "yes" only
once the producer has actually taken the target, so a chain that failed to
fuse never has a transformer scribbling on a value it does not own.

### What the differential harness found

`test_interpreter_fusion_differential.nim` renders 360 graph shapes with the
planner on and off and compares the canvases. Two divergences are real, both
pre-existing, and neither is the planner's to fix:

- **Fit boundary.** A decoder writes decoded pixels straight over its target
  where a materialized draw composites them, and pixie's smooth draw leaves a
  soft antialiased border a decoder never produces. So the two disagree within
  a pixel or two of the fitted rect's edge. This is the same precondition
  already spelled out on `readImageIntoTarget` ("only equivalent to
  compositing when the source cannot be transparent"), now measured rather
  than assumed. The harness holds it still by running the corpus at canvas
  size (no fit, exact comparison over the whole frame — 339 of the 360 shapes)
  as well as scaled (exact comparison over the interior of the fitted rect).
- **Sampler.** Unchanged from the note above: streaming decoders sample
  nearest. Phase 3's problem.

### What the hardware said

Run on a 7.3" PhotoPainter (ESP32-S3, `EPD_7in3e` 800x480) on 2026-08-11, with
`set fusion 0|1` re-planning the live scene so the same scene renders both
ways, and the 4bpp panel preview pulled over the USB console for comparison.
A control (two renders, both fused) differs in **0 of 192,000** packed bytes,
so the pipeline is deterministic and any difference below is real.

| scene | tier | fit | fused | materialized | panel |
|---|---|---|---|---|---|
| Calendar (`render/calendar`) | liveCanvas | cover | 47.6s | 16.8s | **identical** |
| XKCD (`downloadImage`, split cell) | ownedScratch | contain | 21.4s | 48.9s | see below |
| SD card image (`localImage`) | liveCanvas | cover | 411ms in the producer, 912 B allocated | 2846ms, 508 KB allocated | not comparable |

Three things worth keeping:

1. **The XKCD regression is fixed, and provably so.** The profile logs the fit
   the producer was actually handed: `"fit": "contain"`. That single field is
   what would have caught the original bug on sight, where the frame's
   scaling mode said `cover` and the node had asked for `contain`.
2. **On this device fusion is not an optimisation, it is the difference
   between rendering and not.** With `set fusion 0` the XKCD scene does not
   render at all — it puts up an error frame reading *"PNG decode of 615x416
   needs 1069K of decode buffers, over the 752K memory budget"*. The
   materialized floor is a graceful failure here, not a slower success, which
   is exactly the pressure the tiering exists for. The 9,332 differing bytes
   on that row are a comic versus an error box.
3. **Calendar is the clean pixel-for-pixel result**: a full-frame generator
   writing straight into the live canvas, byte-identical to allocating its own
   canvas-sized image and drawing it. That is principle 4 holding on real
   hardware, through the real panel pipeline, including the dither.

The SD card row is not a fusion comparison: `data/localImage` was configured
with random image order, so the two renders picked different files. What it
does show is the shape of the win — the fused producer wrote into the canvas
for **912 bytes and 411 ms**, against **508 KB and 2.8 s** to decode natively
and scale afterwards. (It also turned up an unrelated pre-existing nuisance:
a junk `sys_decode.bmp` on the card that `localImage` cannot decode, which
renders an error frame whenever the rotation lands on it.)

Left open by the hardware pass: a genuine pixel A/B of a *downloaded photo*
scaled into a target, which needs a scene whose source does not change between
renders and whose materialized path still fits in the decode budget. The
gallery scenes pick randomly and XKCD's materialized path does not fit.

### Do the scenes we ship actually work in this system?

`test_repo_scenes_fusion.nim` answers that with data rather than opinion: it
loads every scene under `repo/scenes/samples`, runs the planner, and prints
every image edge with the tier it got or the reason it was refused. Run it with
`FRAMEOS_FUSION_INVENTORY=1`. The planner reports refusals (`FusionRefusal`)
instead of only deciding, so "why is this scene not fusing" stops being a
question you can only answer by reading the planner.

**26 scenes, 19 image edges, 17 fused.** The two refusals left are
`data/chromiumScreenshot` and `data/rstpSnapshot` — host-only apps, excluded
from embedded builds entirely, and host-side fusion is a standing non-goal
until a quality-preserving streaming scaler exists. Declaring a capability they
cannot honour would be exactly the bespoke hack this design exists to avoid, so
they stay refused and the inventory says why.

Getting from 14 to 17 took two general mechanisms and no special cases:

- **A `natural` fit.** A decoder has to be told cover/contain/stretch, so only
  those placements could offer it a target. A source that comes back at exactly
  the target size draws identically under *every* placement — `center`,
  `top-left` and `cover` all reduce to the same 1:1 draw — so for a producer
  that fills whatever it is handed, the placement stops mattering and only the
  offsets and the blend still do. That is what unblocked the three Weather
  edges, which use `placement: "center"`.
- **JS apps are natural-size producers, not opaque walls.** A JS app does not
  make its own pixels: it asks the runtime for an image whose default size is
  the context's (`imageFromSpec`) and draws into it with normal-blend
  operations. Handing it the target instead of a fresh canvas is `intoTarget`
  with a natural fit — not "streaming through JS", which stays a non-goal. It
  is offered rather than assumed, because the same entry point also returns
  decoded SVG, data URLs and explicitly-sized images; the runtime takes the
  target only in the branch where it would have allocated a target-sized
  canvas, and an unclaimed offer costs nothing because `takeDecodeTarget`
  allocates lazily.

Verified on hardware: the Weather scene renders **0 of 192,000 packed bytes
different** fused versus materialized, with both `render/image` nodes reporting
`liveCanvas … fit: center`.

**But Weather's memory did not drop, and it is worth being precise about why.**
`weatherPanel` builds SVG and returns it, so it rasterizes through
`decodeSvgWithFallback` into an image of its own and never reaches the branch
that would take the target. The offer is correct, harmless and free — it just
is not claimed. Making it claimable needs pixie to rasterize an SVG into a
caller-supplied image, which is the same class of change as the split-cell
image view: a fork change, and now the second piece of evidence pointing at
the same place.

### The pixie side: `renderInto`, and a trade we did not take

`newImage(svg)` allocates the image it rasterizes into, so a caller that
already owns a correctly sized buffer had to take a second full-size
allocation and then blend it away. The fork gained `renderInto(svg, target)`
(pixie `b31eefe`) — the same rasterization with the destination supplied.
`newImage` keeps its overwrite-first start, which is only an optimisation for
the fresh transparent image it just allocated; `renderInto` composites from the
first path, because its target may already have content and there the two
differ.

`renderSvgIntoTarget` in `utils/image.nim` plumbs it through, and the JS
runtime claims a target for an SVG panel the same way it does for a plain
canvas. **But only a target the chain owns** — and that gate is the interesting
part.

On a freshly allocated (transparent) target, rasterizing in place is
**bit-identical** to rendering standalone and drawing the result; pixie's test
pins that. On the **live canvas** the two are equal only in exact arithmetic:
compositing each path onto existing content rounds differently at every path
than compositing onto transparency does before one final blend. Associativity
of source-over says they agree; 8-bit quantization says not quite.

Measured on the frame, claiming the live canvas for Weather's SVG panels:

- content, layout and mean colour **identical**;
- **42% of pixels** moved between two adjacent palette entries — 98% of the
  differences were a single index pair swapping, i.e. the dither pattern
  changing phase, not the picture changing;
- saving would have been **614KB + 921KB** per render.

**Decision (2026-08-11): take the memory.** Reviewed side by side off the
frame, the difference is indistinguishable — 1.48MB of PSRAM and 5.2s per
render, on a frame with about 6.6MB free, against a rearrangement of dither
grain in two gradients. The SVG path now claims whatever target it is offered,
including the live canvas.

That deliberately spends some of principle 4, so the check that principle
protects had to become sharper rather than looser. Comparing raw bytes would
now fail on every run for a reason nobody cares about, and a test that always
fails protects nothing. The panel comparison instead classifies the difference:

- **Do the flips cancel?** Every `i -> j` should have a matching `j -> i`. A
  dither phase shift is symmetric by construction; an area that genuinely got
  lighter or darker is not.
- **Did the mean colour move?** Averaged over the changed pixels, a phase shift
  leaves it identical.

Both hold and it is grain; either fails and it is content, which is what a
wrong fit, a missed draw or an error frame all look like. Measured on Weather:
5,417 flips one way against 5,415 the other, mean colour `rgb(101,138,172)` in
both.

### `render/split` and the case for an image view

`render/split` gives each cell a `subImage` — a **copy** of that region of its
parent — lets the child render into it, and draws it back. One level is one
cell-sized buffer live at a time. Nesting stacks them: while an inner cell
renders, its parent's cell buffer is still live, and its parent's, up to the
canvas. `test_nested_split_memory.nim` pins both that a nested split renders
correctly and what it costs — at two levels the live set is **1.75x the
canvas**.

That is fine at 800x480 (672KB against a 384KB canvas). It is not fine on the
13.3E6, where the canvas alone is 7.7MB and the same shape needs about 13.5MB
of the 16MB PSRAM, next to everything else a render is holding.

A view fixes it outright and, unlike the SVG trade above, has almost no
fidelity question: a cell that borrows its parent's pixels is the same pixels
by construction, and the whole nested stack collapses to the canvas.

**Almost** — review found the one exception, and it is a real semantic change,
not grain. A child that draws with an *erasing* blend (`overwrite`, `mask`,
`inverse-mask`) over a source with transparency now writes that transparency
through to the canvas, where the copy path flattened it against the parent's
pixels on the draw back (the cell copy carried those pixels; the final
composite was a normal blend). The new behaviour is what the very same node
does **outside** a split — erasing blends have always punched through the live
canvas — so cells are now consistent with the top level instead of quietly
different. But a scene that relied on the old flattening (a transparent logo
overwrite-drawn inside a cell, expecting the background to survive) renders
differently, the display path flattens the punched alpha to black, and unlike
the fusion tiers this has no kill switch. If that scene turns up, the fix is a
planner-style rule for cells, not a revert.

**Done (2026-08-12).** pixie gained `view(image, x, y, w, h)`, `render/split`
uses it, and a cell now writes straight into the canvas with no copy out and no
draw back. Measured on the frame, the Weather scene (one split, two cells):

| | min free PSRAM | peak used |
|---|---|---|
| copies | 3,440,476 | 3,503,880 |
| views | **3,966,192** | **2,975,916** |

**516KB less peak PSRAM** on a single level. `test_nested_split_memory.nim`
reports the nested case going from **1.75x the canvas to 1.00x**, and pins the
write-through directly so a regression to copying fails there rather than only
showing up as memory.

The cost of the pointer indirection, which was the thing to check before
committing to this: **none measurable.** `tests/bench_view_cost.nim` in the
fork has fill, draws, per-pixel access and fillPath all within noise of the
buffer-owning build, while taking a quarter-canvas region goes from 0.032ms to
nothing at all. Views are free to make and free to use.

Five pre-existing bugs fell out of the conversion, all listed in the pixie
commit — the sharpest being `isOpaqueSse2` answering for the wrong range
whenever `start != 0`, and `applyOpacityNeon`'s scalar tail wrapping a
`uint8 * uint8` so that 240 at half opacity came out 0.

<details><summary>The original design note, kept for the reasoning</summary>

**Why it was not done sooner.** pixie's `Image` owns its buffer —
`data*: seq[ColorRGBX]`, with `dataIndex` as `width * y + x`. A view has to
share the parent's buffer, and a Nim `seq` cannot be aliased. The contained
shape looks like this:

```nim
Image* = ref object
  width*, height*: int
  buffer: ref seq[ColorRGBX]   # shared between an image and its views
  stride*: int                 # parent's width for a view, own width otherwise
  origin*: int                 # index of the view's top-left in the buffer

template data*(image: Image): var seq[ColorRGBX] = image.buffer[]
template dataIndex*(image: Image, x, y: int): int =
  image.origin + image.stride * y + x
```

Keeping `data` as a template means all 238 existing `.data[...]` sites compile
unchanged, and everything already routed through `dataIndex` or `unsafe[]`
becomes view-correct for free. What does **not** come for free is the ~25 flat
loops over `data.len` and the 7 `copyMem`/`addr data[...]` sites that assume
rows are contiguous across the whole buffer; each needs auditing, and a view
must be refused where it cannot hold.

It is a change to the core type of the library every frame renders through, and
the per-pixel indirection needs measuring before it ships.

In the event the shape that landed was slightly different and better: `data`
became a raw pointer rather than a `ref seq`, so there is no extra dereference
at all, and `forEachSpan` gave the flat operations one span for an owner —
which is why the benchmark came back flat.

</details>

### Transformer audit (phase 1)

- `render/opacity` — **forwards**, shipped. Skips its `.copy()` when cleared to
  mutate in place, which is what made the doc's motivating symptom (opacity
  between producer and `render/image`) cost a full-frame copy *and* the fusion.
- `data/rotateImage` — **no**. 90°/270° change the output's dimensions, so a
  canvas-sized target can never be forwarded through them; 180° and flips
  could, but the app always allocates a fresh image and would need a real
  in-place path first. Its output is still a native-resolution intermediate,
  so rotate scenes keep the full decode in memory — the largest remaining hole
  phase 1 does not close.
- `data/resizeImage` — **no**, and the design note above was too optimistic. A
  target request cannot simply *replace* the resize: the configured `WxH` crop
  followed by the consumer's fit is not the same picture as the consumer's fit
  applied directly, unless the aspect ratios happen to agree. The useful move
  here is the opposite direction — resize passing its own `WxH` *up* to the
  producer so the decode is bounded — which is a new protocol, not this one.
- `render/zoomPan` — **no**. Same shape as resize: its own crop.
- `render/gradient`, `render/color` — **not yet**, and for a reason worth
  writing down. Both fill their whole output, so they look like `intoTarget`
  producers alongside `render/calendar`. But they already allocate exactly one
  canvas-sized image, so the owned-scratch tier saves nothing; the only tier
  that pays is the live canvas, and writing straight onto the canvas is only
  equivalent to a normal-blend draw when the output is **opaque**. A
  semi-transparent `render/color` is a plausible scene ("tint the photo"), and
  fusing it would erase the photo instead. Doing this properly needs a
  capability the planner can evaluate — "this output is opaque, given these
  config fields" — which is a small schema addition, not a special case.
  `render/calendar` already leans on the same unstated assumption today.

## Work plan

### Phase 0 — measure (do first, small)

- [x] Debug mode logging, per node per render: byte size of the produced
      `Value` (`values.nim` `approxByteSize`) + heap delta across execution
      (embedded: PSRAM free, negated; Linux: RSS from `/proc/self/statm`;
      elsewhere reported as unknown rather than guessed). Hung off the
      existing `markRuntimeCheckpoint` node:start/done pair, and it names the
      fusion tier the planner picked for the node so memory attribution can
      tell a canvas written in place from one drawn onto. Event
      `interpreter:node:profile`; costs nothing unless `debug` is on
      (`test_interpreter_node_profile.nim` pins that).
- [x] Run the real scenes on hardware and capture peak-memory-per-edge
      profiles. Done 2026-08-11 on the 7.3" PhotoPainter (ESP32-S3,
      `EPD_7in3e` 800x480, 8MB flash layout). Console `set debug 1` turns the
      profile on; `set fusion 0|1` toggles the planner so a scene can be
      rendered both ways and the panels compared.
- [x] Decision gate: **images dominate, decisively.** Per-render peak value on
      the byte side vs the image side:

      | scene | peak image value | peak byte-side value | ratio |
      |---|---|---|---|
      | Weather (2 JS panels via `render/split`) | 921,600 | 19,845 (`weatherIcons` JSON) | 46x |
      | XKCD (RSS -> `downloadImage`) | 1,028,160 | 3,574 (`xmlToJson`) | 288x |
      | SD card image (`localImage`) | 1,536,000 | 11 | — |

      So phase 3 (row streams) is worth more than phase 2 (byte-side tiering)
      on this hardware, as the plan assumed. Phase 2 is still worth doing —
      `icalJson`'s *input* is the multi-MB side and none of these scenes
      exercise it — but it is not what decides whether a photo scene renders.

### Phase 1 — target-passing everywhere (kills the whitelist)

No streaming machinery. Generalize the existing hint into declared
capabilities + planner; teach transformers to forward targets.

- [x] `config.json` schema: optional `capabilities` on ports
      (`intoTarget`, `forwardsTarget` on outputs, `providesTarget` on inputs),
      emitted as typed `AppCapabilities` literals into `src/apps/apps.nim` by
      `apps_nim.py`. Apps that declare nothing do not appear in the registry at
      all. No editor changes; `frontend/src/types.tsx` documents the schema.
- [x] Planner (`frameos/planner.nim`): per-scene-load edge planning, cached on
      the scene; rules for cache barrier, semantics-changing shapes, opaque
      nodes (including dynamic JS apps, which the interpreter flags), tier
      selection, and the forwarding-hop rule. `FRAMEOS_DISABLE_FUSION` (or
      `imageFusionEnabled` in-process) falls the whole thing back to the
      materialized floor.
- [x] Port the 8 `decodeTargetProducers` + `render/calendar` to declared
      `intoTarget`; port `render/image` to a declared target provider.
- [x] `forwardsTarget` for `render/opacity`; the rest audited above, with
      reasons. `resizeImage` and `gradient`/`color` turned out not to be the
      easy wins the design assumed.
- [x] Delete the interpreter whitelist block; `takeDecodeTarget` is now
      protocol-internal.
- [x] Differential harness
      (`src/frameos/tests/test_interpreter_fusion_differential.nim`): 360
      generated permutations of producer × transformer × placement × blend ×
      cache × source-size, each rendered twice per mode, asserting fused output
      == materialized output and that the planner's decision matches the rules
      restated independently in the test. Mutation-checked: relaxing the
      cached-producer forwarding rule fails on both the decision and the
      pixels.
- [ ] Wire the harness into the wasm build too (it runs the same interpreter),
      and add an e2e pass over the shipped scene corpus rather than only
      generated graphs.
- [x] Embedded regression pass on real hardware (2026-08-11, 7.3"
      PhotoPainter). See "What the hardware said" below.
- [ ] Opacity-in-the-middle on hardware. The host differential covers it over
      360 shapes and `test_interpreter_decode_target.nim` pins the hint
      forwarding, but no scene on the device has a transformer in the chain —
      it needs a scene uploaded for the purpose.

### Phase 2 — byte-side tiering (independent of phase 1)

- [x] `Value` gains an `fkSpool` variant backed by `frameos/spool.nim`:
      in-memory below a threshold, a file above it, `windows`/`lines`
      iteration that never holds more than a window, and `materialize` as the
      floor — which raises past a byte limit rather than attempting an
      allocation that would take the device down. `asString()` materializes,
      so every existing consumer is unchanged; `asSpool()` works on a plain
      string too, so a new consumer never has to branch on the tier.
      The backing file's lifetime is the value's: a `=destroy` hook removes it,
      rather than relying on a sweep.
- [x] `byteIter` on a config.json field, plumbed through
      `app_loader_nim.py`: a string field so declared is generated as a
      `Spool` and set with `asSpool()`. The editor still sees a plain string —
      capabilities stay a runtime contract (principle 1).
- [x] `icalJson` folds over the spool a line at a time, folded continuations
      and all. `test_spooled_ical.nim` pins that a file-backed feed parses to
      exactly what the in-memory one does across window boundaries, and that
      the "you passed a URL" check stays a prefix test rather than becoming
      the thing that materializes a 4MB body.
- [x] Planner/tier rule + logging: the threshold comes from live memory
      (`availableRenderBytes() div 4`, clamped), a failed storage probe
      **degrades to memory instead of raising** — a frame with no SD card must
      not start failing downloads that used to work — and both `downloadUrl`
      and the node profile report the tier actually reached, not the one
      asked for.
- [x] `downloadUrl` no longer buffers the whole body at all.
      `boundedGetSpool` in `utils/http_client.nim` closes it on every target:
      hosts stream the 2xx body off the socket into the `SpoolWriter` chunk by
      chunk (`HttpBodySink` threaded through `singleBoundedRequest`; redirect
      hops and error bodies still materialize, they are about to become a
      Location read or an error message); embedded **adopts the spill file
      `boundedRequestBuffer` already produced** as the spool's backing file —
      the download that used to be refused outright ("too large to load into
      memory") now costs a window to consume — and windows PSRAM-chunked
      bodies into the writer past the threshold. Peak memory on the edge is
      the window, not the download. Pinned by six cases in
      `test_http_client.nim`, including that a redirect hop's own body never
      reaches the spool and that an aborted stream leaves no file behind.
- [ ] Audit `xmlToJson` / `parseJson` / `prettyJson`. Left materialized on
      purpose for now: phase-0 measured their inputs at 2.5–20 KB on real
      scenes, three orders of magnitude below the image side, so there is
      nothing to buy yet.
- [ ] Exercise the byte side on hardware. None of the nine scenes on the
      bench frame feeds a large document through `downloadUrl` → `icalJson`,
      so the tier has host tests only.

### Phase 3 — row streams for images (after phase 1, gated on data)

The prize: a 4000×3000 JPEG onto an 800×480 canvas in a few hundred KB.
Build only if phase-0/phase-1 data shows remaining chains that matter.

**Gate result (2026-08-11, 7.3" PhotoPainter): not yet — and the measurement
says the next win is a different mechanism.** After phases 0–1 plus the
cached-producer fix below, the per-render profile on every scene the frame
carries shows the image edges already costing either nothing (the producer
writes into the live canvas) or one canvas-sized value that a row stream could
not remove:

| remaining cost | scene | bytes | can a row stream help? |
|---|---|---|---|
| JS panel output inside a split cell | Weather | 921,600 + 614,400 | **No** — JS is opaque by design (non-goals) |
| `render/split` cell buffers | Weather, XKCD | same values | **No** — needs an image *view*, not a stream |
| producer → canvas | Calendar, XKCD, SD card | ~0 | already fused |

So the chains row streams were designed for — uncached producer → pointwise
transformer → canvas — **do not occur in any shipped scene**. Building the
protocol now would be machinery with no consumer.

What would reopen it: a scene with a transformer mid-chain (the shape phase 1
made work but nothing ships yet), or a panel where the canvas alone is the
problem — on the 13.3E6 the canvas is 7.7MB, where one avoided intermediate
matters far more than at 800x480.

**The larger remaining win is elsewhere.** `render/split` gives each cell a
`subImage` **copy** of its region and draws it back (`apps/render/split/app.nim`
says why: "pixie has no image view"). On the Weather scene those copies are the
two largest values in the whole render. A windowed `Image` view in the pixie
fork would remove them outright, and would help every split scene rather than
the transformer chains nobody has drawn. That is a cross-repo change and a
bigger piece than row streams, but it is where the bytes actually are.

#### What did land instead (measured, shipped)

A cached producer used to force the owned-scratch tier so its cache could never
end up holding the live canvas. But `withCache` on embedded **refuses to store
frame-sized images** (over 1MB), so above that size the cache stores nothing,
nothing aliases the canvas, and the scratch was a whole canvas of PSRAM bought
to protect an entry that is never written. The plan now records *why* it chose
the owned tier, and the runtime upgrades back to the live canvas when the cache
will refuse the value. Every shipped photo scene caches its producer, so this
is the common path — on XKCD it is 1MB of PSRAM per render on a frame with
about 6MB free.

A scratch chosen because a *transformer* mutates it in place is never upgraded:
that one is not about the cache. `test_interpreter_decode_target.nim` pins the
distinction.

- [ ] Row-stream protocol: producer emits scanlines of the *target*
      resolution (decoders already scale-on-decode); consumers are the
      canvas draw and pointwise ops (`opacity`, `color`, row-aligned
      blends).
- [ ] Fallback points materialize automatically: rotate-90 (transpose),
      text measurement, split, JS — planner inserts the materialize
      adapter, visible in checkpoints.
- [ ] Embedded-only until a quality-preserving streaming scaler exists;
      hosts keep the materialized/budgeted tier (nearest-sampling
      divergence rule, see `image.nim` `readImageIntoTarget` comment).

### Phase 4 — parity wins (after phase 1 proves out)

- [ ] Compiled scenes: emit the same negotiation at codegen time in
      `scene_nim.py` (static graph → static plan; no runtime planner
      needed). Closes the interpreted/compiled behavior gap on hosts.
- [ ] Cloud: nothing to do at the control-plane level (interpreted
      scenes ship the runtime's planner), but verify cloud-deployed
      scenes.json on an ESP32 exercises the new path in the WS test rig.
- [ ] Revisit Pico thin-client: the row-stream protocol is the natural
      wire format for host-rendered → device-pushed scanlines; check
      whether `embedded/pico` can consume it instead of its own format.

## Non-goals

- Streaming through JS/QuickJS code nodes. Opaque forever until proven
  necessary.
- Editor-visible pipeline configuration of any kind.
- Host-side streaming decode before a quality-preserving scaler exists.
- Image proxies. (Standing hard rule — the fix is always on-device.)
