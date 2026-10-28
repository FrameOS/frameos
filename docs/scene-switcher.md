# The scene switcher

*Written 2026-10-28.*

Swipe up from the bottom of a touch screen and the frame shows every scene it
has as a tile with its title; tap one and the frame shows it. The same screen
works on e-paper, with the keys: the highlight walks the tiles, and a key
picks one.

| Piece | Where |
|---|---|
| The event that opens it, `sceneSwitcher` | `docs/events-contract.json` (a `scene-command`), resolved by `frameos/src/frameos/event_loop.nim` |
| The scene, `system/sceneSwitcher` (the contract's `scenes.switcher`) | `frameos/src/system/sceneSwitcher/scene.nim`, one module for every host |
| What it lists, and the pictures | the host's: `frameos/scene_switcher_linux.nim`, `embedded/embedded_runtime.nim`, `wasm/wasm_main.nim` |
| The default bindings | `frameos/device_event_map.nim` (every HyperPixel), the SenseCAP Indicator's preset (`fos_board.c`, `EMBEDDED_HARDWARE_PRESETS`, the SPA's `NewFrame.tsx`) |
| "Button actions" | `frontend/src/utils/frameEventMap.ts` (the action "Scene switcher", and the edges of a touch screen as rows) |

## Opening and closing it

`sceneSwitcher` is a scene command the dispatcher resolves, on every host,
like `setCurrentScene {direction}`:

- From any scene, it selects `system/sceneSwitcher` with `state.from`, the
  scene showing. The switcher opens with that scene highlighted and a dot by
  its title.
- While the switcher shows, it selects `state.from` again (the list's first
  scene when that one is gone). So the same swipe opens and closes it, and
  the switcher's own Close, a key with the role `back`, and its idle timeout
  all dispatch `sceneSwitcher` to go back.

A `setCurrentScene {sceneId: "system/sceneSwitcher"}` from another scene
without `state` gets `state.from` added the same way, so the HTTP API and a
schedule can open it by name. While it shows, `setCurrentScene {direction}`
walks the list from `state.from`: on a reTerminal, RIGHT held in the
switcher is the scene after the one it was opened from.

Who may say it (`origins`): the frame's event map, a scene (a "Scenes" button
in a scene's own UI), a schedule, the HTTP API with the frame access key or
an admin session, the preview and the runtime. Not a driver (a key is bound
through the event map), and not the cloud, which has no verb for it; the
cloud can still `set_current_scene` it by name.

The defaults bind it to a swipe up from the bottom edge (`edgeSwipe {edge:
bottom}`) on every touch screen that ships an event map: the HyperPixels
(when frame.json has no `eventMap`) and the SenseCAP Indicator. Left and
right stay the previous and the next scene. E-paper ships no binding; the
owner adds one under "Button actions" (a REFRESH double press, say), and
every frame can be sent to it by name.

## The scene

The switcher is built into the runtime, not installed: it is in no scene
list, the control planes never push it, and nothing persists it. A reboot,
a restart or a deep sleep comes back on the scene it was opened from (the
Linux runner does not write `scene.json` for a system scene; the ESP32
writes neither `last_scene` nor `pending_scene` for it). Its state (`from`,
`highlight`, `page`, `touchedAt`) is in memory only.

It is an `ExportedInterpretedScene` with no nodes, whose `init`, `runEvent`
and `render` are its own: the Linux runner finds it with the system scenes
(`system/scenes.nim`), and `single_scene_host.nim` builds it when the
current scene is `system/sceneSwitcher` (`isBuiltInScene`), running every
scene through its export so the switcher needs nothing else from the host.

### What it lists

The host's scene list, in the order `setCurrentScene {direction}` walks it
(`EventHost.sceneOrder`), with each scene's name, through
`sceneSwitcherListing`:

| Host | List | Names |
|---|---|---|
| Linux | `sceneOrderSnapshot()`: a pushed set first, then the deployed scenes it does not name | `getSceneDisplayName` |
| ESP32 | the catalog (`/state/scene-index.json`) on the lazy path, the parsed payload's order otherwise | the catalog's, or the parsed scenes' |
| wasm preview | the loaded payload's order | the parsed scenes' |

### How it is drawn

It builds a UI tree in Nim (`SvgNode`s with Tailwind classes) and lays it out
with the JSX layer (`ui/layout.nim`), so it needs no QuickJS and draws
through the one rasterizer (`utils/svg_frames.nim`): on an LCD only the
tile that changed is repainted. Its tiles are regions for `ui/events.nim`,
which hit-tests the taps as it does a JS app's UI.

`switcherGrid` puts every scene on one page while the tiles stay big enough
to read (at least a fifth of the shorter side across, up to six by six), and
picks, among the grids that hold them all, the one whose pictures (at the
frame's aspect) or name cards come out largest. More scenes than that fit
page, with the page and two arrows in the header.

- **A fast panel** (an LCD: an RGB565 canvas, the framebuffer, a HyperPixel)
  gets a dark grid: each tile its picture when the host has one, its number
  and title under it, the highlighted tile ringed, and a tile darker while a
  finger is on it (`active:`).
- **E-paper** (an ESP32 that is not an LCD, `waveshare.*`, `inky*`,
  `pimoroni.inky*`) gets black on white, thick borders, the highlighted tile
  inverted, and no press feedback: a refresh to show a finger is down would
  be seconds of flashing for nothing. Only its taps count.

### Pictures

On Linux each tile shows the scene's last snapshot: the PNG the runner writes
under `<assets>/.frameos/scene_images/` on every switch and at most once a
minute after (`render:sceneImage:saved`). `scene_switcher_linux.nim` fits it
to the tile (halved by pixie's box filter, then drawn), and keeps it until
the file changes, so the decode is paid once per scene and snapshot. A scene
not shown since the card was made has its number in the picture's place.

The ESP32 and the preview list names only. The firmware keeps one picture,
the panel's, and a picture per scene would be a decode and a few hundred KB
of PSRAM per tile, or flash writes on every switch.

## Using it

- **Touch:** tap a tile to show that scene, swipe left or right across the
  tiles for the next or the previous page, tap Close (or swipe up from the
  bottom again) to go back.
- **Keys**, by role (`buttons.roles`, `roleByLabel`): `next` / `down` move the
  highlight one tile on, `prev` / `up` one back (wrapping, across pages);
  `primary`, `refresh` and `menu` (OK, REFRESH, BOOT, HOME) show the
  highlighted scene; `back` goes back. A press is one step and a double press
  two, so pressing NEXT three times moves three tiles whatever the button
  layer made of the taps, and presses made during an e-paper refresh land
  together with their timing, so the next refresh shows where they got to.
  A long press stays the frame's: on a reTerminal LEFT and RIGHT held are
  still the previous and the next scene.
- **A keyboard** (Linux): the arrows walk the grid, Page Up and Down turn
  the page, Enter shows the scene, Escape goes back.
- **Nobody there:** it goes back by itself after a minute on a fast panel and
  five on e-paper, counted from the last tap or key. An ESP32 that deep-sleeps
  stays awake that long when the switcher opens, so its keys are heard.

### Why not "press the key N times for the Nth scene"

The button layer (`frameos/input_state.nim`) makes one event of each press:
two quick taps are one `doublePress` and a third starts over, so "five taps"
is not something a key can say, and counting `gpio` edges would need a
timeout the dispatcher does not keep. The switcher counts instead: every
press of a `next` key is a step (a double press two), the tiles are
numbered, and a press of the primary key opens the highlighted one. Open
the switcher, press NEXT n times, press OK: the scene n after the one
showing.

## Flash

No new layout code: the JSX layer it draws with is already in the image.
The module itself is about 14 KB of code and 4 KB of strings (its class
names) on the ESP32-S3 at `-Os`, estimated from its object file, with the
keyboard and the pictures compiled out of the firmware (`frameosEmbedded`);
the firmware gains the scene id, the slot-less select in `fos_scenes.c` and
one preset rule besides. Class names are appended in place, one call each:
the first version, written with `&`, was half as big again.
