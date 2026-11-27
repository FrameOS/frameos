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
- **The gear** in the header opens the settings of the scene the list was
  opened from (`sceneSettings {page: "scene"}`, with the `fields` and
  `values` the list read when it opened, because a host that holds one scene
  let that scene go; docs/buttons.md "Home"), whose own gear is the frame
  page. Opened with no scene behind it (the frame's home), or over a scene
  with no settings, the gear goes the other way: `sceneSettings {page:
  "frame"}` while the switcher shows opens the frame page
  ([scene-settings.md](scene-settings.md) "The frame page") over the scene
  the switcher was opened from, in its layout, instead of going back to that
  scene. A layout that broke every scene can leave the switcher as the one
  screen still reachable, and the frame page's Layout is where it is taken
  off. On a desktop the frame page opens as its window and the switcher stays
  open in its own. A plain `sceneSettings` still goes back.
- **A scene picked on a desktop** (`builtInScenesStay`) opens beside the
  list, which stays open in its window as a launcher, as a window that lost
  the focus does (`app.frame.keptOpen`); brought forward again it is as it
  was left, scrolled and highlighted. Only its Close, the same command again
  or its timeout end it (2026-11-22; before, a pick closed it). Without a
  desktop a pick goes back as always.

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
the runtime draws itself. Every board's keys open it too (docs/buttons.md:
it is Home): a Home key pressed, a Back key held, two keys held together on
a board without a Back key, an Action key held on a board without a
microphone, a Screen key held (the SenseCAP Indicator's one key: pressed it
switches the screen off and on). Every frame can be sent to it by name.

## The frame's home

An ESP32 that takes taps starts on the switcher when nothing was ever picked
on it and no scene in its set is marked `default`: a board fresh from
flash.frameos.net on a touch preset (the flasher marks no default there), or
any set whose maker left the start to the frame. Without this it showed the
first scene of the list (the Clock of a flasher's set), which nobody chose.

- The firmware decides that nothing was picked (`fos_boot_scene_home` in
  `embedded/esp32/main/fos_boot_scene.c`, host-tested): no queued selection,
  no remembered `last_scene` it still has, no scene marked `default`. It still
  makes the list's first scene resident, then queues the switcher, and the
  runtime opens it with `state.home` (`embedded_runtime.openHome`) unless
  nothing on the frame takes a tap (`takesNoTaps`: e-paper whose event map
  binds keys alone), which shows that first scene as before.
- At home the switcher has nothing to go back to: no Close, no idle timeout
  (it draws again hourly), and a `back` key, Escape, or `sceneSwitcher`
  again leave it where it is (`backFrom` in `event_loop.nim` answers the
  switcher itself). Its gear opens the frame page over it, and the frame
  page's way back is home again (the settings keep `home`). The Wi-Fi a
  board fresh from the flasher has to join is on that page.
- A scene picked from it ends home: that scene is remembered (`last_scene`),
  so the next boot starts there, and the switcher opened from it later is the
  usual one (`state.home` goes when it is opened from a scene).
- It wears the frame's chosen layout, if any (`layoutFor("")`): on a desktop
  it is the launcher's window. What the scenes name is not it: the browser
  flasher makes the layout it picked the frame's choice (`set layout`,
  cloud/docs/flasher.md), or a reTerminal Sticky's home has no header.
- A Pi starts on its first scene as before (`getFirstSceneId`): a Pi always
  gets its scenes from a backend deploy.

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
together under a heading with its name, "System" first (the frame's own apps:
the Scene store, Files, the terminal, the code editor, Fonts, the readers, the
Calculator, the Browser; the owner's call, 2026-11-25), then the categories sorted by name
with case aside (the raw name breaking a tie), each trimmed, and the scenes
without one, or in a category named "Other" in any case, last under "Other".
Within a group the scenes keep the list's order (the flash.frameos.net
flasher puts the store first). Where no scene has a category there are no
headings, and the list is as the host gave it. The keys walk the
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
frame's render scale, sized for a 480 px panel, within the bounds the settings
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
- **Categories** are sections, as a file manager's: each starts a row of its
  own under a small name with a thin rule across the row (the owner's call,
  2026-11-22; before, the next category went on in the row the last one
  ended in). Only a category's first row has the strip its heading sits in.
  They show wherever a scene has a category, from a list of one (`headed`;
  until 2026-11-25 only from a dozen scenes and two a category), and never
  where none has: no lone "Other" over a list with no categories.
- **No pictures.** A host's snapshots of its scenes
  (`sceneSwitcherThumbnail`, the Linux runner's) are no longer drawn: the
  icon view is the owner's call (2026-11-21). The hook stays for now.

The cells are one list under the header, a box with `overflow-y-auto` from
the header to the bottom edge, the whole width (ui/layout.nim; docs/jsx-ui.md
"Scrolling and clipping"), each placed by `spots`. A list longer than the
screen scrolls, with the layer's thin bar at its right edge; the rows cut by
the bottom edge say there is more. Its scroll is the layer's, kept by the
list's place in the tree (the root's first child, `ListKey`), which is how
the keys move it too. Opened, the list starts at its top and, at its first
render, brings the scene it was opened from to its middle when it is further
down: measured in the room that render has (a layout's hole, a window), never
the panel's, which is all the open knows (`revealing`; the reTerminal
Sticky's home screen left it below the hole, 2026-11-25).

The header ends with the gear and Close. **A frame that takes no taps has no
Close**: e-paper whose event map binds its keys and nothing else
(`takesNoTaps`; every touch preset binds the edge swipes, so a map of keys
alone is a board of keys alone, the reTerminal E1001, E1002 and E1004). Its
keys open, walk and go back, and its gear is a stop for them after the last
tile, so the scene's settings and the frame page are a key's walk away
(docs/buttons.md); a board whose keys move nothing (one key, no glass:
`frameHasNoArrows`) has no gear. The gear is there only while the
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
  list is a lens, as a watch's is: a tile is full size at the circle's middle
  and smaller towards its rim (`lens`, 1 − 0.65 × (dy / radius)², about two
  thirds at the list's top and bottom edges), its cell and what a tap there
  does unchanged; every scroll is a render, so the lens follows the finger.
  Its scroll bar is an arc along the rim (docs/jsx-ui.md "Scrolling and
  clipping"). The bottom swipe opens it from the rim there (`input_state.nim`
  `edgeAt`).
  `test_scene.nim` checks every hit region where it shows and every pixel
  drawn for 1, 5, 9 and 20 scenes, with categories and without, at the top
  of the list and scrolled to its end, pressed and highlighted.

### Pictures

*Not drawn since 2026-11-21 (the icon view, "The tiles"); the hook and the
Linux host's copies stay for now.* On Linux each tile showed the scene's last snapshot: the PNG the runner writes
under `<assets>/.frameos/scene_images/` on every switch and at most once a
minute after (`render:sceneImage:saved`), once the panel has the picture
and on a thread of its own below the runner's priority
(`scene_snapshot_writer.nim`: the encode is most of a second on a Pi Zero,
three for a photo, and on the runner it held every tap and switch back by
that), and never for the switcher or the settings themselves.
`scene_switcher_linux.nim` fits it to the tile (halved by pixie's box
filter, then drawn), and keeps it until the file changes. A scene not shown
since the card was made has its icon (or its first letter) in the picture's place.

Opening it is fast on a Pi Zero (a 720x720 PNG is a few hundred ms to decode
there):

- The snapshot writer writes a small copy beside each snapshot from the
  pixels it has in hand, halved down to a shorter side of 320 to 639 px
  (360x360 on a HyperPixel 4.0 Square), with no decode:
  `.frameos/scene_thumbs/<snapshot>.qoi` (QOI is a few ms to write and to
  read). The switcher reads the copy, unless the snapshot is newer (one from
  an older runtime, or put there by a control plane), which it decodes, and
  keeps what it read until the snapshot changes.
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
  from the right edge (the frame's `forward`) to move the highlight a
  screenful on, tap the gear for the scene's settings, tap Close, swipe in
  from the left (the frame's `back`) or swipe up from the bottom again to go
  back. A
  mouse's wheel scrolls the list (Linux, the preview).
- **Keys**, by role (`buttons.roles`, `roleByLabel`): `next` / `down` move the
  highlight one tile on, `prev` / `up` one back (wrapping, and through the
  gear after the last tile, which is inverted like a tile), and the list
  scrolls as little as it takes to show the tile they land on, its heading
  with it where it starts a group: on e-paper the keys are all there is to
  follow;
  `primary` (OK, the reTerminal's green REFRESH, BOOT; `refresh` too, for a
  key given it by hand) shows the highlighted scene, or opens the frame page
  on the gear; `back` and `menu` (HOME, MENU) go back, and so does the
  frame's `back` (the Back key the default maps make `back`, two keys held
  together). A press is one step, so pressing NEXT three times moves three
  tiles, and presses made during an e-paper refresh land together with their
  timing, so the next refresh shows where they got to. A long press stays the
  frame's: the arrows held walk the scenes, which in the switcher is a
  screenful back and on (`setCurrentScene {direction}` is `back` and
  `forward` there, said with its `direction`: a plain `back` leaves), and the
  key held that opened it (Home) closes it. One the frame's map leaves free
  goes back from a `primary`, `refresh`, `menu` or `back` key.
- **One key** (a board whose keys move nothing, `frameHasNoArrows`: a TRMNL,
  a C3; docs/buttons.md): its press walks the tiles one on, and its hold,
  which opened the list, opens the tile it is on (the dispatcher goes back to
  the highlighted scene, `backFrom`).
- **A screenful** (`forward`, a scene direction, Page Down and Up): the highlight moves as many tiles as a screen holds (the grid's
  columns times its rows, in the room the last render had), no further than
  the last tile or the first, and the list scrolls with it; from the last
  tile on goes to the first, from the first back to the last. It is what a
  page turn was before the list scrolled, so the frame's event map needs no
  change.
- **A keyboard** (Linux, the preview): the arrows walk the grid (up and down
  to the tile in the same column of the row above or below, the last of a
  shorter row, since a category starts a row of its own), Tab one tile on
  and Shift+Tab one back as the buttons do, Page Up and Down a screenful,
  Enter shows the scene, Escape goes back. The highlight is the switcher's
  one focus: the JSX keys' ring (docs/jsx-ui.md "Keys") is not drawn here,
  and Tab rings neither a tile's icon and name apart nor the layout around
  it.
- **Nobody there:** it goes back by itself after a minute on a fast panel and
  five on e-paper, counted from the last tap or key. An ESP32 that deep-sleeps
  stays awake that long when the switcher opens, so its keys are heard.

### Why not "press the key N times for the Nth scene"

The button layer (`frameos/input_state.nim`) makes one event of each press,
the moment the key is up, so "five taps" is five presses and nothing waits
to count them; a count that meant something else would need a timeout after
the last one. The switcher counts instead: every press of a `next` key is a
step, the tiles are in
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
- The firmware gets no keyboard (`frameosEmbedded`) and no pictures, and its
  one round board (the Waveshare 1.75" AMOLED, `boardPanelRound`) the round
  list and chrome a Pi's HyperPixel Round gets (about 4.8 KB of flash with
  the keyboard's and the settings' round layouts, 2026-11-23); integer arithmetic, and
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
