# The scene switcher

*Written 2026-10-28.*

Swipe up from the bottom of a touch screen and the frame shows every scene it
has as a tile with its title, grouped by category, in one list that scrolls;
tap one and the frame shows it. The same screen works on e-paper, with the
keys: the highlight walks the tiles, the list scrolls to it, and a key picks
one. A gear in its header opens the frame's own settings page.

| Piece | Where |
|---|---|
| The event that opens it, `sceneSwitcher` | `docs/events-contract.json` (a `scene-command`), resolved by `frameos/src/frameos/event_loop.nim` |
| The scene, `system/sceneSwitcher` (the contract's `scenes.switcher`) | `frameos/src/system/sceneSwitcher/scene.nim`, one module for every host |
| What it lists, and the pictures | the host's: `frameos/scene_switcher_linux.nim`, `embedded/embedded_runtime.nim`, `wasm/wasm_main.nim` |
| The default bindings | `frameos/device_event_map.nim` (every HyperPixel), the SenseCAP Indicator's, the Sunton S070's and the reTerminal E1003's presets (`fos_board.c` `TOUCH_EDGE_SWIPES` and `INDICATOR_EVENT_MAP`/`ONE_BUTTON_TOGGLE`, `EMBEDDED_HARDWARE_PRESETS`, the SPA's `NewFrame.tsx`) |
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
  all dispatch `sceneSwitcher` to go back. `sceneSettings` (a swipe down
  from the top) goes back the same way, and `sceneSwitcher` over the scene
  settings closes them unsaved ([scene-settings.md](scene-settings.md)), or,
  with `{swap: true}` (a taskbar's Start), goes straight to the list, the
  scene behind staying behind. On a desktop, where both stay open in windows
  of their own, the other one always opens: `sceneSwitcher` over a scene's
  settings opens the list, `sceneSettings` over the list the settings of the
  scene it was opened from.
- **The gear** in the header goes the other way: `sceneSettings {page:
  "frame"}` while the switcher shows opens the frame page
  ([scene-settings.md](scene-settings.md) "The frame page") over the scene
  the switcher was opened from, in its layout, instead of going back to that
  scene. A layout that broke every scene can leave the switcher as the one
  screen still reachable, and the frame page's Layout is where it is taken
  off. On a desktop the frame page opens as its window and the switcher stays
  open in its own. A plain `sceneSettings` still goes back.

A `setCurrentScene {sceneId: "system/sceneSwitcher"}` opens it by name (the
HTTP API, a schedule) without `state.from`: it highlights the list's first
scene and goes back there, and so does a switcher whose `from` has left the
list (it forgets `from` then, and when it is left). While it shows, the
dispatcher hands it `setCurrentScene {direction}` as `forward` (`next`) or
`back` (`prev`), which move its highlight a screenful of tiles on or back
("Using it"): the swipe or the key the frame's event map walks the scenes with
walks the tiles in the switcher, and the frame stays on it. On a reTerminal,
RIGHT held in the switcher is a screenful on.

Who may say it (`origins`): the frame's event map, a scene (a "Scenes" button
in a scene's own UI), a schedule, the HTTP API with the frame access key or
an admin session, the preview and the runtime. Not a driver (a key is bound
through the event map), and not the cloud, which has no verb for it; the
cloud can still `set_current_scene` it by name.

The defaults bind it to a swipe up from the bottom edge (`edgeSwipe {edge:
bottom}`) on every touch screen that ships an event map: the HyperPixels
(when frame.json has no `eventMap`), the SenseCAP Indicator and the
reTerminal E1003, whose e-paper has a touch glass: that is how a touch
screen changes the scene. In from the left and the right are `back` and
`forward`, the scene's own (docs/events.md), which the switcher takes as a
screenful back and on. Down from the top is the scene's settings
(`sceneSettings`, [scene-settings.md](scene-settings.md)), the other scene
the runtime draws itself. The SenseCAP Indicator's one key opens the
switcher too, pressed twice (pressed once it switches the screen off and on,
and held it does nothing). E-paper without glass ships no binding; the
owner adds one under "Button actions" (a REFRESH double press, say), and
every frame can be sent to it by name.

## The scene

The switcher is built into the runtime, not installed: it is in no scene
list, the control planes never push it, and nothing persists it. A reboot,
a restart or a deep sleep comes back on the scene it was opened from (the
Linux runner does not write `scene.json` for a system scene; the ESP32
writes neither `last_scene` nor `pending_scene` for it). Its state (`from`,
`highlight`, `touchedAt`) is in memory only, and so is how far its list is
scrolled, which is kept with its UI's input like any scrolling box's
(docs/jsx-ui.md "Scrolling and clipping").

It is an `ExportedInterpretedScene` with no nodes, whose `init`, `runEvent`
and `render` are its own: the Linux runner finds it with the system scenes
(`system/scenes.nim`), and `single_scene_host.nim` builds it when the
current scene is `system/sceneSwitcher` (`isBuiltInScene`), running every
scene through its export so the switcher needs nothing else from the host.

### What it lists

The host's scene list, in the order `setCurrentScene {direction}` walks it
(`EventHost.sceneOrder`), with each scene's name (and its window size, icon and
category, docs/scene-icons.md), through `sceneSwitcherListing`. Every host's
listing carries the category (`listingItem`'s entries are the same):

| Host | List | Names |
|---|---|---|
| Linux | `sceneOrderSnapshot()`: a pushed set first, then the deployed scenes it does not name | `getSceneDisplayName` |
| ESP32 | the catalog (`/state/scene-index.json`) on the lazy path, the parsed payload's order otherwise | the catalog's, or the parsed scenes' |
| wasm preview | the loaded payload's order | the parsed scenes' |

It shows them grouped (`grouped`, the same rule as the desktops' JavaScript
`grouped`, docs/scene-layouts.md "Long lists of scenes"): a category's scenes
together under a heading with its name, the categories sorted by name with
case aside (the raw name breaking a tie), each trimmed, and the scenes without
one, or in a category named "Other" in any case, last under "Other". Within a
group the scenes keep the list's order. Where no scene has a category there
are no headings, and the list is as the host gave it. The keys walk the
tiles in the order shown. JavaScript lowers every letter
for the comparison and the Nim lowers A to Z and the Latin-1 capitals
(`folded`): two categories that differ only in another script's capitals can
sort the other way round.

### How it is drawn

It builds a UI tree in Nim (`SvgNode`s with Tailwind classes) and lays it out
with the JSX layer (`ui/layout.nim`), so it needs no QuickJS and draws
through the one rasterizer (`utils/svg_frames.nim`): on an LCD only the
tile that changed is repainted. Its tiles are regions for `ui/events.nim`,
which hit-tests the taps and scrolls the list under a finger as it does a JS
app's UI. It is laid out at the
frame's render scale, sized from the panel, within the bounds the settings
panel keeps (docs/scene-settings.md, "At the frame's scale").

### The tiles

A folder's icon view, as Windows Explorer's large icons or the macOS
Finder's: each scene its icon with its name centred under it, wrapping to two
lines, and nothing around it (no card, no button). Every desktop of windows
opens this switcher as its window of every scene (Windows 98's Programs,
macOS's Launchpad, the others' Scenes), so that window is this view in each
desktop's theme. It was cards of a number and a name (until 2026-11-21), and
for a day the Scene store's tiles, which the owner found a bunch of square
buttons with unlimited whitespace.

`switcherGrid` lays the cells out from the room it has, from the left, as many
across as fit, close together, and the rows that do not fit scroll (`rows` is
how many show: a screenful for the keys). The cells are a share of a unit
that is the panel's shorter side, 400 px at most (`CellUnitMax`; the header
keeps its 480, `GridUnitMax`): in a desktop's window, on a 480 px square and
on a 10" panel alike a cell is 84 px wide (Explorer's is about 75 to 90 at
100%, Finder's 80 to 100), 4 px apart, with a 40 px icon and 12 px letters,
90 px tall with room under the names. A bigger panel or window shows more of them, never larger ones
(the owner's rule, 2026-11-20); the frame's render scale is what makes them
larger.

- **The icon** is the scene's own (`settings.icon`, docs/scene-icons.md) in
  its category's color, or its first letter on a rounded square of that
  color. The colors are eight, by the category's place in the list, so two
  categories side by side differ. On e-paper the icon is black, the letter
  outlined.
- **Selected** (the keys' highlight, the scene it was opened from at first)
  as a file manager shows it: a tint behind the icon and the name on a filled
  label, in the theme's `picked` role (Explorer's navy label in Windows 98,
  Finder's blue pill in macOS). A dot at the icon's corner marks the scene it
  was opened from. On e-paper the whole cell is inverted.
- **Categories** are compact, as Finder's groups: a small name over the first
  cells of each category with a thin rule under it as far as they go, the
  next category straight after in the same row, so a category of one takes
  one cell, not a row. A row keeps a strip for its headings. Where headings
  would be most of the list (fewer than a dozen scenes, or fewer than two a
  category: `headed`) there are none, and the scenes keep the order by
  category in one flow.
- **No pictures.** A host's snapshots of its scenes
  (`sceneSwitcherThumbnail`, the Linux runner's) are no longer drawn: the
  icon view is the owner's call (2026-11-21). The hook stays for now.

The cells are one list under the header, a box with `overflow-y-auto` from
the header to the bottom edge, the whole width (ui/layout.nim; docs/jsx-ui.md
"Scrolling and clipping"), each placed by `spots`. A list longer than the
screen scrolls, with the layer's thin bar at its right edge; the rows cut by
the bottom edge say there is more. Its scroll is the layer's, kept by the
list's place in the tree (the root's first child, `ListKey`), which is how
the keys move it too. Opened, the list starts at its top and scrolls to the
highlighted cell.

The header ends with the gear and Close. **A frame that takes no taps has
neither**: e-paper whose event map binds its keys and nothing else
(`takesNoTaps`; every touch preset binds the edge swipes, so a map of keys
alone is a board of keys alone, the reTerminal E1001, E1002 and E1004). Its
header is the title; its keys open, walk and go back. The gear is there only while the
frame offers its page (`frameSettingsRead` answers, as the scene settings'
gear): not in an editor's preview, and not while the frame's control plane
turned the settings on the screen off (`frame_settings_on_screen`), where it
would open nothing. The device's unlock (docs/scene-settings.md "Turned off by
the control plane") brings it back with the page.

- **A fast panel** (an LCD: an RGB565 canvas, the framebuffer, a HyperPixel)
  gets the icons on a dark page, and a cell tinted while a finger is on it
  (`active:`).
- **In a desktop** the header, Close and the gear take the theme's roles as
  before, the headings `muted`, the selected name `picked`
  (`test_desktop_switcher.nim` renders every desktop's window with twenty-five
  scenes, small and large, `FRAMEOS_DESKTOP_SHOTS=<dir>`).
- **E-paper** (an ESP32 that is not an LCD, `waveshare.*`, `inky*`,
  `pimoroni.inky*`) gets black on white, the highlighted cell inverted, and no press feedback: a refresh to show a finger is down would
  be seconds of flashing for nothing. A tap counts, and a finger dragging
  the list is drawn once, where it let go (ui/events.nim keeps quiet until
  then).
- **A round panel** (`frameos/panel_shape.nim` `panelIsRound`: the HyperPixel
  2.1" Round, whose 480x480 shows and takes touches only inside its circle)
  keeps everything `RoundInset` (12 px) in from the rim, where the bezel
  covers the glass: the list is the square inscribed in that circle and
  scrolls inside it, the arc above holds the title (12 o'clock) and the one
  below Close and the gear (6), each box cut to the chord it sits on. The
  bottom swipe opens it from the rim there (`input_state.nim` `edgeAt`).
  `test_scene.nim` checks every hit region where it shows and every pixel
  drawn for 1, 5, 9 and 20 scenes, with categories and without, at the top
  of the list and scrolled to its end, pressed and highlighted.

### Pictures

*Not drawn since 2026-11-21 (the icon view, "The tiles"); the hook and the
Linux host's copies stay for now.* On Linux each tile showed the scene's last snapshot: the PNG the runner writes
under `<assets>/.frameos/scene_images/` on every switch and at most once a
minute after (`render:sceneImage:saved`), once the panel has the picture
(the encode is most of a second on a Pi Zero, and it used to hold every
switch back), and never for the switcher or the settings themselves.
`scene_switcher_linux.nim` fits it to the tile (halved by pixie's box
filter, then drawn), and keeps it until the file changes. A scene not shown
since the card was made has its icon (or its first letter) in the picture's place.

Opening it is fast on a Pi Zero (a 720x720 PNG is a few hundred ms to decode
there):

- The runner hands the switcher the snapshot it just wrote while it still
  has the pixels (`noteSceneSnapshot`): kept halved down to a shorter side
  of 320 to 639 px (360x360 on a HyperPixel 4.0 Square), with no decode.
- It writes that small copy beside the snapshots
  (`.frameos/scene_thumbs/<snapshot>.qoi`; QOI is a few ms to write and to
  read), and after a restart the switcher reads the copy, unless the
  snapshot is newer (one from an older runtime, or put there by a control
  plane), which it decodes.
- A render on a fast panel decodes for 120 ms at most; the tiles it did not
  get to show their older picture, or their number, and the switcher
  renders again at once (`sceneSwitcherThumbnailPass`). E-paper waits for
  all of them: every render there is a refresh.

An ESP32 shows name cards only. #709 gave it a small RGB565 picture per scene
on the state partition, and on a reTerminal E1003 (a 10.3" e-paper panel, 23
scenes) the drawer then took 8 to 14 s to open: each picture was a SPIFFS open
(up to 1.4 s, a walk of the partition), a stretch onto the grey canvas through
pixie's float sampler (0.86 s a tile), and a write of seconds after renders.
The owner's call (2026-11-10): no pictures on an ESP32. The first boot of a
firmware without them deletes the old `th-*.bin` files once
(`drop_old_scene_pictures` in `fos_scenes.c`, remembered in NVS as
`th_swept`).

The preview lists names only.

## Using it

- **Touch:** tap a tile to show that scene, drag the list up or down to
  scroll it (on e-paper it shows where it got to when the finger lifts, one
  refresh, and a tap after that opens the tile under the finger), swipe in
  from the right or the left edge (the frame's `forward` and `back`) to move
  the highlight a screenful on or back, tap the gear for the frame's
  settings, tap Close (or swipe up from the bottom again) to go back. A
  mouse's wheel scrolls the list (Linux, the preview).
- **Keys**, by role (`buttons.roles`, `roleByLabel`): `next` / `down` move the
  highlight one tile on, `prev` / `up` one back (wrapping, and through the
  gear after the last tile, which is inverted like a tile), and the list
  scrolls as little as it takes to show the tile they land on, its heading
  with it where it starts a group: on e-paper the keys are all there is to
  follow;
  `primary`, `refresh` and `menu` (OK, REFRESH, BOOT, HOME) show the
  highlighted scene, or open the frame page on the gear; `back` goes back. A press is one step and a double press
  two, so pressing NEXT three times moves three tiles whatever the button
  layer made of the taps, and presses made during an e-paper refresh land
  together with their timing, so the next refresh shows where they got to.
  A long press stays the frame's: on a reTerminal LEFT and RIGHT held walk
  the scenes, which in the switcher is a screenful back and on
  (`setCurrentScene {direction}` is `back` and `forward` there). One the
  frame's map leaves free goes back from a `primary`, `refresh`, `menu` or
  `back` key: the E1004's REFRESH held closes the list (the E1001-E1003's
  talks, as their map says).
- **A screenful** (`forward` and `back`, a scene direction, Page Down and
  Up): the highlight moves as many tiles as a screen holds (the grid's
  columns times its rows, in the room the last render had), no further than
  the last tile or the first, and the list scrolls with it; from the last
  tile on goes to the first, from the first back to the last. It is what a
  page turn was before the list scrolled, so the frame's event map needs no
  change.
- **A keyboard** (Linux): the arrows walk the grid (up and down to the tile
  in the same column of the row above or below, the last of a shorter row,
  since a category starts a row of its own), Page Up and Down a screenful,
  Enter shows the scene, Escape goes back.
- **Nobody there:** it goes back by itself after a minute on a fast panel and
  five on e-paper, counted from the last tap or key. An ESP32 that deep-sleeps
  stays awake that long when the switcher opens, so its keys are heard.

### Why not "press the key N times for the Nth scene"

The button layer (`frameos/input_state.nim`) makes one event of each press:
two quick taps are one `doublePress` and a third starts over, so "five taps"
is not something a key can say, and counting `gpio` edges would need a
timeout the dispatcher does not keep. The switcher counts instead: every
press of a `next` key is a step (a double press two), the tiles are in
order, and a press of the primary key opens the highlighted one. Open
the switcher, press NEXT n times, press OK: the scene n after the one
showing.

## Flash

The generic ESP32-S3 image (`embedded/esp32/ci_build_image.sh`) is 13.6 KB
bigger with it than without: the module's code 8.6 KB and its strings
2.5 KB, the dispatcher's (`sceneSwitcher`, and the walk from `state.from`)
1.0 KB, the firmware's listing and slot-less select (`embedded_runtime.nim`,
`fos_scenes.c`) 0.8 KB. The first version was 20.8 KB. What keeps it there:

- No new layout code: the JSX layer it draws with is already in the image.
- The firmware gets no keyboard and no round panel (`frameosEmbedded`; no
  ESP32 board is round) and no pictures, integer arithmetic, and
  no Nim checks in the module (every index is guarded by the loop or the test
  that reaches it).
- Class names are appended in place, one call each, and a class that
  depends on something in a branch of its own: every `&`, and every `if`
  that yields a string, is a temporary with its own clean-up at each call
  site. Nodes are handed on (`sink`), never copied, and a proc has one way
  out: each early `return` repeats the clean-up of everything live.
- No class that restates a default: e-paper's white page and black text are
  the canvas's own (only an LCD's dark page, which covers every pixel and so
  lets a press repaint only what changed, is drawn).
- What raises is reported where any scene's is (the dispatcher, the render
  pass), and opened by name the switcher knows no scene it came from, so the
  dispatcher has nothing to add to a `setCurrentScene`.

The list that scrolls and the categories (2026-11-20) took the page arrows,
the page number and the swipe handling out and put in the grouping (one pass
and an insertion sort of the category names), the tiles' places (`spots`)
and the scroll to the highlight; the scrolling itself is the JSX layer's,
already in the image. That change was not measured on the ESP32-S3 image:
no image was built for it. The firmware-size comment on its pull request is
the number.

The icon view (2026-11-21) replaced the number row, the name-card layout,
the densest-grid search and the picture tiles with one fixed cell, a category
color table and headings that flow with the cells: the firmware-size comment
on that pull request (#940) is the number.
