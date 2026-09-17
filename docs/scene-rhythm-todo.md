# Scene rhythm — every embedded scene ticks on its own schedule

*Written 2026-09-18. Read cold: each section says what exists before what is
missing. When an item ships, delete it. Repo-wide odds and ends live in
`docs/todo.md`; this file carries only the scene-scheduling work.*

The goal: a scene embedded in another scene renders when **it** is due, not
when its parent is. A split of two Unsplash photos (every ten minutes) and a
clock (every 0.2 s) shows a clock that ticks and photos that do not move —
without anyone setting an interval on the split, without refetching a photo
per tick, and **without a second copy of any pixels**: this has to work on a
reTerminal E1004 (8 MB PSRAM, 1600×1200 RGB565 canvas, no room for a second
buffer).

It is generic. The unit of scheduling is the **scene node** — any scene
embedded in any scene, at any depth, inside a `render/split` or not. Splits
only matter because they hand each child a rectangle.

## What happens today (and why the clock does not tick)

- **One loop, one timer.** `RunnerThread` (`frameos/runner.nim`) and the
  ESP32's `renderCurrentScene` (`embedded/embedded_runtime.nim`) run the top
  scene's `render` event, then sleep `nextSleep` if anything set it, else the
  **top** scene's `refreshInterval`.
- **A child's `refreshInterval` is never read.** Scene nodes are run by the
  interpreter inside the parent's pass (`interpreter.nim`, `of "scene":` →
  `exportedChild.runEvent(childScene, context)`). Only the top scene's
  interval reaches the loop.
- **`nextSleep` is one float, last writer wins.** `logic/nextSleepDuration`
  writes `context.nextSleep`; `render/split` and `data/newImage` copy a cell's
  value back up to the parent context. The stock "Unsplash image" scene ends
  in `nextSleepDuration ← secondsBetweenImages` (600), so in a split it
  overrides everything and the frame sleeps ten minutes. The clock wins only
  if it happens to run last *and* sets a sleep of its own.
- **A working fast tick would be wrong anyway.** Every pass re-runs every
  cell. The stock Unsplash scene has the cache on `data/unsplash` *disabled* —
  it relies on the ten-minute sleep not to refetch — so five passes a second
  would be five API calls a second.
- **Editing a split drops its settings.** `buildSplitScene`
  (`frontend/src/scenes/frame/frameLogic.ts`) writes `settings` as exactly
  `backgroundColor`, `execution`, `splitScreenLayout`; "Edit split → Save"
  silently resets a hand-set `refreshInterval` (and anything else) to default.

None of this was designed; it is what fell out of "a scene node runs the
child's event". There is no behaviour here worth preserving for its own sake,
so **no opt-in flag**: child rhythm is simply how scene nodes work.

## What already exists (build on it, don't rebuild it)

- **The ESP32 canvas persists between renders.** `renderCanvas()` hands back
  the same image over the block reserved at boot; last pass's pixels are
  still in it when the next pass starts.
- **Cells are views, not copies.** `render/split` gives each child
  `image.view(x, y, w, h)`; the child draws straight into the canvas. Views of
  views flatten onto the owner, and a view knows where it is: `origin` +
  `stride` give its absolute rectangle (`pixie/common.nim`).
- **Every scene opaquely repaints its own image first.** `runEventInner`'s
  `of "render":` does `context.image.fill(scene.backgroundColor)` — for a
  child that image is its cell. So a child's render is always a complete,
  opaque repaint of its rectangle; whatever the parent drew underneath
  beforehand is irrelevant.
- **One instance per scene node.** `sceneNodes[nodeId]` — two cells showing
  the same scene id have separate state, so they can carry separate due times.
- **The ESP32 packers do not write the canvas** (dither streams with error
  rows), so the canvas is still the scene's picture after the panel update.

Together: if nothing wipes the canvas, a child that is not due can simply
**not run**, and its pixels stay where they are. No buffer.

## The design

### 1. Due times on scene nodes

- Each scene-node invocation gets a **fresh** `nextSleep` (−1), not the
  parent's. After it returns: `dueAt = now + (nextSleep ≥ 0 ? nextSleep :
  child.refreshInterval)`. `logic/nextSleepDuration` inside a child therefore
  means "this child next runs in N seconds" — scenes that pace themselves
  keep working, scoped to themselves. `render/split` and `data/newImage` keep
  copying `nextSleep` between contexts of the *same* scene; the scene node is
  the boundary, so nothing a child sets reaches its parent.
- The top scene keeps today's rule. A generated split has nothing of its own
  to draw, so its own interval is **never, unless forced** — it follows its
  children (editor: hide the interval for split scenes, or show it as "auto").
- The loop sleeps until `min(top scene due, every descendant's dueAt)`,
  recursively through nested splits and nested scene nodes. Everything that
  reads the next wake (`setNextRenderSeconds`, the status screen, the ESP32
  `sleep` forecast / `next_wake_at`, driver retry) gets that minimum.
- What marks things due early: a `render` dispatched from inside a child
  marks **that child**; `setSceneState` on a child marks that child; "render
  now", scene activation, deploy/upload, boot and wake from deep sleep mark
  **everything**.

### 2. Partial passes: run only what is due, draw over

When the wake is for descendants only (the top scene itself is not due), do
not run the parent at all. For each due scene node, build a view of the
persistent canvas at the rectangle that node was last handed, and run the
child's `render` into it. Nodes that are not due are not executed: no fetch,
no decode, no JS runtime spun up. Then push the canvas to the driver as usual.

Per-node bookkeeping is a rectangle, a due time and a sequence number — tens
of bytes. No pixels are retained anywhere.

Nested due nodes are invoked **directly**, not through their ancestors: the
recorded rectangle is absolute, so an ancestor that is not due does not run.

### 3. Staying correct for arbitrary graphs: the overpaint rule

A partial pass for node S is right only if nothing painted over S's rectangle
*after* S in the last full pass. (Anything painted *before* S is hidden by S's
opaque fill — that is what makes this tractable.) The runtime works it out
itself instead of trusting graph shape:

- During every **full** pass keep a paint log: one small record per executed
  render-type node — sequence number, absolute rectangle of the image it was
  handed, and which scene node (if any) it ran inside. A node handed the
  whole canvas is assumed to touch all of it. Containers that only delegate
  (`render/split`) are not paint ops.
- After the pass, S is **overpainted** if a later record outside S intersects
  S's rectangle. Overpainted nodes never get partial passes: when one is due,
  the whole top scene re-renders (today's behaviour, at the right time).
- Runner overlays (control-code QR, cloud link code, local-access code) are
  paint ops over their rectangles while active.

Worked cases: a generated split with a background scene + `render/opacity`
paints its cells last → cells qualify. A full-canvas child with a text overlay
drawn after it → overpainted → full passes. A split inside a split → inner
cells qualify, their rectangles are absolute.

This is deliberately conservative: partial only when provably safe, otherwise
exactly what happens today.

### 4. The Pi / HDMI / wasm path

`renderSceneImage` allocates a new image per pass, draws the overlays onto
it, and flips it **in place** before `rotateDegrees`. For partial passes the
runner needs a persistent *pre-overlay, pre-flip* scene canvas, with overlays
and flip applied to the copy that goes out (`setLastImage` already copies).
These devices have the memory; the point is one mechanism on every target,
not a second one for the Pi. The wasm preview runs the same interpreter and
should get the same behaviour so the editor shows what the frame does.

## Where it cannot be seamless (say so, don't hide it)

- **Deep sleep loses the canvas** (PSRAM is powered down). On a battery E1004
  every wake is a full pass and every child runs; per-child due times still
  decide *when* to wake. Not refetching a photo that is not due would need
  its last download read back from flash — the existing "save assets" option
  is the obvious hook. Separate item, needs its own design and a flash-wear
  look.
- **A full pass wipes everything and re-runs every child** (due background
  scene, forced render, boot, size change). Children's due times reset then.
  Invisible for generated splits once their own interval is "never".
- **Parent → child inputs** (scene-node config fed from the parent's code
  nodes) are only recomputed when the parent runs.
- **Compiled (legacy) scenes** get no partial passes; scene nodes pointing at
  them run as today. Interpreted is the default and the only path worth the
  work.
- **Panels that cannot show it.** 0.2 s means nothing on Spectra 6 or on a
  deep-sleep frame. Decide whether a per-device-class floor on the effective
  interval belongs here or stays the user's problem (open question below).

## Work items

Roughly in order; each is shippable on its own.

- [ ] **`buildSplitScene` keeps existing settings.** Merge the edited scene's
  current `settings` under the three generated keys. One-liner plus a
  shared-spa test. Independent of everything else — do it first.
- [ ] **Fresh `nextSleep` per scene node + `dueAt` on the child instance**
  (`interpreter.nim`): the scene node is the boundary, the child's value
  never reaches the parent context. Unit tests: two children with
  different sleeps; a child with none falls back to its `refreshInterval`.
- [ ] **Loop wakes at the minimum due time** — `runner.nim` and
  `embedded_runtime.nim` (`sceneNextSleepSeconds` / `sceneRefreshSeconds`),
  including the ESP32 sleep forecast. At this point every wake is still a
  full pass: the clock ticks, but every cell re-runs per tick. Ship only
  together with the next two, or behind the partial-pass work.
- [ ] **Paint log + overpaint analysis.** Absolute rectangle from
  `origin`/`stride` (needs a small pixie accessor on the FrameOS fork — PRs go
  to `FrameOS/pixie` only). Bounded size: cap the log, and treat "log
  overflowed" as "everything overpainted".
- [ ] **Partial passes on ESP32.** Direct invocation of due scene nodes into
  views of the persistent canvas. Verify with the memory probe that a partial
  pass allocates nothing canvas-sized; bench on the E1004 and the 13.3E6.
- [ ] **Persistent scene canvas on the Pi runner**, overlays and flip on the
  output copy; then partial passes there and in the wasm preview.
- [ ] **Targeted due-marking for events**: `render` dispatched inside a child,
  `setSceneState` addressed to a child, vs. everything-due for activation /
  deploy / "render now".
- [ ] **Editor:** split scenes show their interval as "auto"; the split
  drawer can show each cell's rhythm (from the child's interval / its
  `secondsBetween…` field) so the result is predictable before deploying.
- [ ] **Logging:** the "rendering fast, pausing logs" guard keys off the top
  scene's interval; with per-child rhythm it should key off the actual wake
  cadence, and `render:scene` should say which nodes a partial pass ran.
- [ ] **Docs:** `docs/value-pipeline.md` gains the paint-log / overpaint
  section; the scene-node docs explain rhythm and the deep-sleep caveat.

## Open questions

- A floor on the effective wake interval per device class (e-ink, deep-sleep
  battery frames) — enforce, warn in the editor, or leave alone?
- Deep-sleep frames: is "reuse the last saved asset when the child is not
  due" worth doing, and does it belong in the data apps' cache layer instead?
- Should a full pass really reset not-due children's due times, or keep them
  so a forced render does not shift a ten-minute photo onto a new phase?
