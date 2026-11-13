# Scenes inside scenes: each on its own schedule

A split screen holds other scenes: each panel is a `scene` node pointing at a
scene of its own. Before this, a frame had one render loop and one interval,
and every pass ran every panel. A split of a 24 fps clock and an Unsplash photo
either never ticked (the photo's interval won) or fetched a photo 24 times a
second (the clock's did). `frameos/src/frameos/scene_rhythm.nim` is the
runtime side; this is what it does.

## The model

- **A scene drawn through a scene node has its own due time:** its last due
  run plus its `refreshInterval` (the state field every scene has,
  `refresh_interval.nim`, which a split panel's options can set), or plus the
  `nextSleep` that run set (`logic/nextSleepDuration`, `frameos.setNextSleep`).
  A panel's `nextSleep` is the panel's: it never reaches the frame.
- **Every pass still starts at the top scene.** When it reaches a scene node
  whose scene is not due, the node puts back the pixels that scene drew last
  time and the scene does not run: no fetch, no decode, no JS.
- **The next wake is worked out.** At the end of every pass the frame's
  `refreshInterval` becomes the time until the first thing on it is due
  (`refreshFollowsChildren` / `followInterval`, `syncRefreshInterval`), on the
  Pi, the ESP32 and the preview alike.
- **On a real-time display (LCD, HDMI) a generated split waits for its first
  panel, whatever its own interval says.** A split of a real-time clock, a
  once-a-second clock and an hourly weather panel wakes at the clock's pace and
  nothing else runs but what is due. A scene with `settings.splitScreenLayout`
  draws nothing that changes with time, so its own interval has nothing to do.
- **A layout's `<yield />` that is a hole has the same schedule, without a
  node.** The content runs when it is due, straight into its rectangle, and the
  chrome around it has a due time of its own: `rhythmVisitChrome` either leaves
  it alone (`rdKeep`), copies it out of the frame buffer that holds it around
  the hole (`rdRestore`), or runs the layout (`docs/scene-layouts.md`).
- **On e-paper and on a deep sleeper the split's own interval stays the fastest
  it renders.** A panel's refresh costs 40 seconds or a battery wake, so a panel
  that defaults to 24 fps must not make the frame refresh back to back. Set the
  split to 60 s and a real-time panel gets every refresh, 60 s apart, while the
  hourly one stays put. `panelIsPaper` decides, and the ESP32 says when it
  sleeps deep (`rhythmHoldFloor`).
- **A `<Scene>` in a UI and a layout bring the next wake forward** without being
  a split: the scene around them still keeps its own interval as its latest.
- **Any other scene keeps its own interval.** A scene node inside a hand-built
  scene renders at most as often as that scene does.

A scene counts as due a little early: a tenth of its wait, at least 2 ms, at
most a minute, plus 1.5 s on an ESP32 whose next pass is a second or more
away, because its render task then sleeps in whole seconds. (Below a second
the frame animates, paced in microseconds, and the extra would make a
once-a-second panel due on every frame.) Wakes land a hair off the due time, and a scene that just missed one
would otherwise wait a whole extra tick. So with a 15-minute panel and an
hourly one, the hourly one runs on the tick that lands on its hour.

## What makes a scene due early

- **State that changed from outside.** A hash of the scene's state is taken
  after each of its runs; a different one at the next pass (a control panel, a
  parent's input wired into it, an event it handled) makes it due. What the
  scene writes to its own state while rendering does not.
- **The scene asking.** A `render` dispatched by the scene marks that scene due.
- **Somebody asking.** A `render` from outside the scene (the API, the cloud
  verb, a schedule, a button, the console, the preview) makes the next pass
  *fresh*: every embedded scene runs, due or not, and its schedule starts over
  from that run. The scene's own requests and the runtime's (a link or access
  code drawn over the picture) do not. On Linux and in the preview this is
  `event_loop.nim`'s render rule; on the ESP32 a render never reaches Nim, so
  `fos_events.c` applies the same rule and `fos_client_render_fresh()` hands it
  to the next pass (`frameos_nim_request_fresh_pass`). The service settings
  arriving on an ESP32 also renders fresh: panels drawn without the account's
  keys must run with them.
- **A different top scene.** Switching scenes or a redeploy draws everything,
  and drops what the previous top scene kept.

## Not drawing at all

The best picture to keep is the one already on the canvas. A canvas that lasts
between renders, under a parent that draws nothing but its panels (a generated
split, all the way up), needs nothing for a panel that is not due: the node
returns (`rdKeep`), and the split paints the background on its gaps and empty
cells only, never under a panel.

- **The canvas is trusted by asking:** `rhythmCanvasGeneration` counts writes
  that were not the render's own. The Pi's kept RGB565 canvas and an ESP32's
  panel buffers and scene canvas answer; a Pi's fresh RGBA canvas and the
  preview say -1 and take the copies below. A frame-wide colour correction
  answers -1 too: it would correct a kept panel twice.
- **An ESP32 LCD draws its frame buffers in turn**, so the one it is about to
  draw may be a frame or two behind. A panel that ran since is put back from the
  buffer that has it (`otherCanvasHolding`), a few milliseconds and no memory.

So a 13.3" 1600x1200 board with three panels on 8 MB keeps all of them, where
the copies below would refuse. Nothing is copied at all on such a canvas.

A hand-built scene can draw over a panel, so its panels take the copy path even
on a canvas that lasts.

## Keeping pictures: capped by memory

A scene that ran is copied out of the canvas right after it drew (its
rectangle, in the canvas's own pixel format: RGBA on a Pi, RGB565 on an ESP32)
when it will not be due again by the next pass. The fastest panel is therefore
never copied, and a copy is reused in place when its size has not changed.

All copies together may hold at most **a quarter of the render memory that
would be free without them** (`availableRenderHeadroomBytes`), and on an
ESP32-class device never more than **1 MiB**. A new copy also needs one
contiguous block. A copy that does not fit is not taken (logged once as
`render:rhythm:copyRefused`), and the scene is then *repainted* (below) on the
passes where it is not due. A scene drawn into several cells in one pass (a
split's "render all other cells") keeps one copy per cell, each found by its
place on the canvas; a cell its last due run did not draw (the layout changed)
loses its copy. Passes that reused or repainted something log one
`render:rhythm` line with how many of each (not on the ESP32).

In practice, for what is left (a canvas that cannot be trusted, a hand-built
parent): a Pi keeps every slow panel. An ESP32 with an 800x480 panel keeps
small panels; on a 13.3" board the big ones are refused. A deep-sleeping ESP32 keeps nothing across a
sleep: every wake is a fresh boot, and its first pass runs everything.

## Repaints, and where #555 comes in

When a scene is not due and no copy of it exists, it runs anyway, without its
due time moving: a **repaint**. While it runs, `FrameScene.repainting` is
true. Today a repaint is an ordinary run, so an app that fetches a random photo
fetches a new one, and an album moves on. That is a known cost of a device
that cannot keep the picture, not a bug in the schedule.

The node store (PR #555, `frameos/node_store.nim`) is how a repaint becomes
exact: a node cache that sees `repainting` should serve what it stored last
time, whatever its age, instead of computing again. Nothing else in the
runtime needs to change for that; `repainting` is the whole interface.

## The ESP32's one-scene loader

The firmware keeps one scene resident (`fos_scenes.c`, the lazy path). A split
needs its panels resident too, or `interpreter.init` fails with "Scene node
references unknown scene id". So when a scene node names a scene that is not
resident, the interpreter asks `sceneLoader` (set by `embedded_runtime.nim`),
which reads that one scene off its slot (`fos_scenes_read_scene_json`) and
parses it alongside; a panel's own panels come the same way, at any depth.
Every Nim entry point the firmware calls now catches `Exception`, not only
`CatchableError`: with `--exceptions:goto` a root `Exception` escaping one
poisoned the runtime (found on the E1004 with exactly that error).

On the ESP32 the per-pass `render:rhythm` line is left out to save image
bytes; a panel whose picture cannot be kept still says so once.

## Tests

- `frameos/src/frameos/tests/test_scene_rhythm.nim`: due times, the split's
  interval as a floor, a panel's own `nextSleep`, panel options, state
  changes, fresh passes from the
  dispatcher, repaints without memory and the `repainting` flag, the budget,
  one scene in several cells, nested splits, switching scenes, RGB565 copies,
  the loader hook that brings an ESP32 split's panels in.
- `embedded/esp32/main/tests/test_fos_events_dispatch.c`: which render
  origins are fresh on the ESP32.
- `cloud/apps/auth-web/src/test/shared-spa/scene-rhythm.test.ts` and
  `split-scene-settings.test.ts`: what the editor says about a split and its
  panels, and "Edit split, Save" keeping the scene's other settings.

What is left is in `docs/todo.md`, "Scenes inside scenes".
