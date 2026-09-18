# Scene rhythm — every embedded scene renders when it is due

A scene embedded in another scene renders when **it** is due, not when its
parent is. A split of two Unsplash photos (every ten minutes) and a clock
(five times a second) shows a clock that ticks and photos that do not move —
without anyone setting an interval on the split, without refetching a photo per
tick, and without a second copy of the picture.

The unit of scheduling is the **scene node**: any scene embedded in any scene,
at any depth, inside a `render/split` or not. Splits only matter because they
hand each child a rectangle.

The code is `frameos/src/frameos/scene_rhythm.nim` (bookkeeping, tiers) and
`renderRhythmPass` in `interpreter.nim` (the one entry point of every host:
`runner.nim`, `embedded_runtime.nim`, `wasm_main.nim`). Compiled (legacy)
scenes are untouched: they render whole, on the top scene's interval.

## Due times

- Each scene-node run gets a **fresh** `nextSleep`. Afterwards the child
  instance is due at `now + nextSleep` if it set one, else at
  `start + its refreshInterval`. `logic/nextSleepDuration` inside a child means
  "this child next runs in N seconds"; nothing a child sets reaches its parent.
- The top scene keeps its own rule (its `nextSleep`, else its interval) — except
  a scene the split drawer generated (`settings.splitScreenLayout`): it draws
  nothing of its own, so it is **never due by itself** and follows its children.
  The editor shows its interval as "Auto".
- The loop sleeps until the minimum over the top scene and every active
  descendant. Everything that reads the next wake — `setNextRenderSeconds`, the
  ESP32 sleep forecast / `next_wake_at` — gets that minimum.
- Due times are monotonic seconds. They never ride the wall clock, which NTP
  moves by decades on a frame's first sync.

## Passes

`renderRhythmPass(top, canvas, force)` decides, runs, and leaves the due times.

| Pass | When | What runs |
| --- | --- | --- |
| **partial** | only descendants are due, and every one of them can render alone | each due scene node, directly, into `canvas.view(its last rectangle)` |
| **full** | the top scene is due, a due node cannot render alone, first render, the canvas changed | the top scene; not-due children may be painted from cached pixels (below) |
| **fresh** (`rfFresh`) | someone asked: render now, activation, deploy, a scene switch | everything, nothing reused |
| **canvas kept** (`rfRedraw`, nothing due) | an overlay changed (link code, local-access code) | nothing: the scene's picture is already on the canvas |

A partial pass runs nothing else: no fetch, no decode, no JS runtime spun up
for a node that is not due. Nested due nodes are invoked **directly** — the
recorded rectangle is absolute (`origin`/`stride` of the view), so an ancestor
that is not due does not run.

What marks things due early: a `render` dispatched from inside a scene, or
state set on it, marks **that scene** (embedded: a partial pass; top: a full
pass that keeps what is not due). An unmarked `render` event — the API, the
cloud verb, a button — is a person asking, and renders everything fresh.
Internally the distinction travels as `{"rhythm": "due" | "redraw"}` on the
`render` event's payload.

### The overpaint rule

A partial pass for node S is right only if nothing painted over S's rectangle
*after* S. (What was painted *before* S is hidden by S's opaque background fill
— that is what makes this tractable.) The runtime works it out instead of
trusting graph shape:

- Every pass keeps a **paint log**: one rectangle per executed render node, in
  order. A node handed the whole canvas is assumed to touch all of it; a node
  handed an image that is not the canvas (`data/newImage`'s buffer) touches
  none of it. Containers that only delegate (`render/split`, native `logic/*`)
  are not paint ops.
- S is **overpainted** if a record after S's own interval intersects its
  rectangle. Overpainted nodes never render alone: when one is due the whole
  top scene re-renders — what always happened, now at the right time.
- The log is capped (512 records); overflow means "everything overpainted".
- A node that swapped its context image for one of its own, or sat in a
  foreign buffer, or is a compiled scene, is likewise never run alone.

Worked cases: a generated split with a background scene + `render/opacity`
paints its cells last → cells render alone, the background does not. A
full-canvas child with a text overlay drawn after it → overpainted → full
passes. A split inside a split → inner cells render alone at absolute
rectangles.

## Pixel reuse: three tiers, by what the device can afford

A full pass wipes the canvas, and used to re-run children that were nowhere
near due — the photo refetched because its sibling forced a pass. A child that
is **not due**, whose **state is what it was** (parent → child inputs
included), and whose pixels a tier still holds, is painted from those pixels
instead of being run, and keeps its due time. "Store nothing" is always a valid
answer: the child just runs, as it did before.

1. **Memory, transient.** Right before a fill wipes them, the rectangles of
   not-due, provably-own nodes are copied out of the canvas; the pass copies
   them back when it reaches them and frees them when it ends. This happens at
   the start of a full pass, and one level down when a partial pass runs a
   scene that itself embeds a not-due scene. Zero steady-state memory.
2. **Memory, kept.** An overpainted node's pixels on the canvas are not its
   own, so its snapshot is taken right after it runs and kept until it runs
   again. A host takes one for every node and drops those the canvas can serve;
   an embedded frame only for nodes already known to need it, and never more
   than 1 MB pinned (the node cache's line).
3. **Storage** (embedded only). A deep-sleeping frame loses the canvas with its
   PSRAM: every wake is a fresh boot and a full pass. Before it sleeps
   (`frameos_nim_set_pass_context(…, canvas_volatile = true)`), a node that has
   ≥ 120 s left *and* will still not be due at the next wake is written to
   `<assets>/.rhythm` (SD card) or `/state/rhythm…` (SPIFFS) — raw rows in the
   canvas's own format, RGB565 on the boards that render in it — and on wake is
   read **straight into the canvas view**, no intermediate buffer. The file
   carries its due date (wall clock), the scene definition's fingerprint and
   the child's state key; any mismatch, an implausible clock, a short file, and
   the child simply runs. A stay-awake frame writes nothing.

Budgets: transient snapshots may take a third of free render memory on an
embedded frame (the pass still has to decode whatever *is* due next to them —
the decode budget is refreshed after they are taken) and a quarter on a host;
storage goes through `spoolHeadroomShortfall` like the image cache's disk tier.
Every refusal is a log line (`rhythm:snapshot:refused`, `rhythm:store:refused`).

Flash wear, for the record: a 10-minute 800×600 RGB565 cell is ~0.9 MB × 144
writes a day ≈ 130 MB/day. On an 8 MB wear-levelled SPIFFS partition rated
100k cycles that is ~17 years; an SD card does not notice. A node only costs a
write when it actually re-rendered.

## The hosts

- **Pi / HDMI (`runner.nim`).** `RunnerThread.sceneCanvas` persists between
  passes, pre-overlay and pre-flip. What goes out is always a **copy**: the
  control-code QR, the cloud link code, the local-access code, the flip and the
  rotation happen on it, never on the canvas. `render:pass` logs which nodes a
  pass ran and which it reused; the "rendering fast, pausing logs" guard and
  the websocket throttle key off the real wake cadence, not the top interval.
- **ESP32 (`embedded_runtime.nim`, `fos_client.c`).** The boot-reserved canvas
  already persisted. C tells Nim why a pass is happening and whether deep sleep
  follows (`frameos_nim_set_pass_context`); Nim tells C how long until
  something is due (`frameos_nim_next_wake`, seconds from *now* — not an
  interval to subtract the cycle from) and the cadence a wall-clock-aligned
  wake schedule should align to (`frameos_nim_wake_cadence`). The render task
  sleeps in whole seconds, so a node counts as due 1.5 s early, plus 10 % of
  its own interval (at most a minute) when a pass is happening anyway — a
  battery frame waking for its clock takes the photo due five seconds later
  along instead of waking twice. A timed wake that still lands early renders
  what is due *next*, never everything.
- **wasm preview (`wasm_main.nim`).** Same pass, same persistent canvas, so the
  editor shows what the frame does. `frameos_wasm_next_sleep` is now the tree's
  next wake and wins over the scene interval in `preview-worker.js`.

## Where it is not seamless

- **Parent → child inputs** are recomputed when the parent runs. A changed
  input changes the child's state key, so the child re-runs on the parent's
  next pass — not before.
- **Compiled (legacy) scenes** get due times when embedded in an interpreted
  scene, but never render alone and are never reused.
- **Panels that cannot show it.** 0.2 s means nothing on Spectra 6. Nothing
  enforces a floor: a partial pass still pushes the whole canvas to the driver,
  and the driver's own refresh time is the only brake — as it was for a fast
  top-level scene.
- **Deep sleep + overpainted.** The storage tier only keeps nodes that render
  alone; an overpainted child on a battery frame re-runs on every wake.
- **Pixels depend on more than state + time** (a JS app reading a global, a
  frame setting): the state key cannot see that. Such a child shows its cached
  pixels until it is due. A `render` request bypasses all reuse.
