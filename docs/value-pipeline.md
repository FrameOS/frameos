# Value pipeline: capability-negotiated execution

Design + work tracker for replacing the interpreter's ad-hoc decode-target
fusion with a general capability-negotiation layer, so low-memory targets
(ESP32 today, Pico thin-client and armv6 tomorrow) stop accumulating
per-shape special cases. Written 2026-08-10 after an architecture review;
open items live at the bottom, delete them as they ship.

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

| Protocol | Meaning | Examples |
|---|---|---|
| `materialized` | whole value returned (today's floor, always supported) | everything |
| `intoTarget(fit)` | producer writes into a caller-supplied `Image` with cover/contain/stretch | the 8 current `decodeTargetProducers`, `render/calendar` |
| `forwardsTarget` | transformer passes the target request upstream and mutates in place | `opacity`, `color`, rotate-180/flip, gradient-under |
| `rowStream` | produces/consumes scanlines (phase 3) | streaming decoders → row ops → display driver |
| `byteIter` | consumes a string as a bounded-window iterator (phase 2) | `icalJson`, `xmlToJson`, `parseJson` (maybe) |

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
  generalization of today's `decodeTargetWidth` variant.
- **Semantics-changing shapes don't fuse.** contain+overwrite; any
  wired/inline input on placement-affecting fields that can't be resolved
  to a pure state read; blend modes beyond normal/overwrite.
- **Opaque nodes materialize** (JS, child scenes, split).
- **Tier selection** per principle 3, with byte-spool requiring a
  successful storage probe.

Adapters (`materialize`, `spoolToDisk`, `chunkToIter`) are planner-owned
shims, not editor nodes — but they carry node identity in debug output
and runtime checkpoints (`markRuntimeCheckpoint` already exists) so
memory attribution names them.

### What this deletes

The entire "Decode-into-canvas hint" block in `interpreter.nim`
(whitelist, full-frame-draw detection, cached-producer variant,
contain+overwrite carve-out) becomes: `render/image` declares it can
*provide* a target when its own draw is full-frame; producers declare
they *accept* one; `opacity` et al. declare they *forward* one. The
planner wires it. `takeDecodeTarget` in `utils/app_images.nim` becomes
the internal handshake of the `intoTarget` protocol rather than a
context-global side channel.

## Work plan

### Phase 0 — measure (do first, small)

- [ ] Debug mode logging, per node per render: byte size of the produced
      `Value` (`values.nim` `friendlyName` already sizes) + heap delta
      across execution (embedded: `heap_caps` internal/PSRAM; host: RSS).
      Hang it off the existing `markRuntimeCheckpoint` node:start/end.
- [ ] Run the real photo + calendar + agenda scenes on the 13.3E6 board;
      capture peak-memory-per-edge profiles into `docs/` or the issue.
- [ ] Decision gate: confirm (or refute) that decode/render image
      intermediates dominate byte-side blobs by ~an order of magnitude.
      This orders phases 2 vs 3; the plan below assumes images dominate.

### Phase 1 — target-passing everywhere (kills the whitelist)

No streaming machinery. Generalize the existing hint into declared
capabilities + planner; teach transformers to forward targets.

- [ ] `config.json` schema: optional `capabilities` on ports
      (`intoTarget`, `forwardsTarget`); loader plumbing in the
      interpreter's app metadata. No editor/frontend changes.
- [ ] Planner skeleton: per-scene-load edge planning, cached; rules for
      cache barrier, semantics-changing shapes, opaque nodes.
- [ ] Port the 8 `decodeTargetProducers` + `render/calendar` to declared
      `intoTarget`; port `render/image` to a declared target provider.
- [ ] `forwardsTarget` for pointwise transformers: `opacity`, `color`;
      audit `rotateImage` (180°/flips forward; 90° doesn't), `resizeImage`
      (a target request *replaces* the resize — it IS a resize),
      `zoomPan`, `gradient` (fills its own background → can accept a
      target like calendar does).
- [ ] Delete the interpreter whitelist block; `takeDecodeTarget` becomes
      protocol-internal.
- [ ] Differential harness: for a corpus of scene graphs (e2e scenes +
      generated permutations of producer × transformer × placement ×
      blend × cache), assert fused output == materialized output
      pixel-for-pixel, via a `FRAMEOS_DISABLE_FUSION`-style env switch.
      Runs in e2e and in the wasm harness (wasm build must keep working —
      it runs the same interpreter).
- [ ] Embedded regression pass on real hardware: the five gallery scenes,
      Immich, Google Photos, XKCD, calendar — the scenes the current
      whitelist was grown for, plus opacity-in-the-middle variants that
      are broken today.

### Phase 2 — byte-side tiering (independent of phase 1)

- [ ] `Value` string variant backed by a spool: in-memory below a
      threshold, SD/disk file above it (embedded: probe SD first — reuse
      `fos_assets_sd` plumbing; host: scratch dir). Iterator/window read
      API; transparent `asString()` fallback that materializes (tier
      floor) or errors past the byte limit.
- [ ] `downloadUrl` streams the response body into the spool instead of
      `boundedGetContent`'s whole-body buffer.
- [ ] `icalJson`: incremental line-window parser over the iterator
      (ICS is line-oriented + folded continuations — windowing is
      natural). Output stays small JSON; no downstream changes.
- [ ] Audit `xmlToJson` / `parseJson` / `prettyJson`: document as
      materialized (fine — their outputs, not inputs, are usually the
      small side) unless phase-0 data says otherwise.
- [ ] Planner rule: spool tier only when the in-memory tier would exceed
      budget AND storage probe succeeds; log the tier choice.

### Phase 3 — row streams for images (after phase 1, gated on data)

The prize: a 4000×3000 JPEG onto an 800×480 canvas in a few hundred KB.
Build only if phase-0/phase-1 data shows remaining chains that matter.

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
