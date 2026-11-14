# Scene layouts

A layout is a scene that wraps other scenes: one JSX app with a hole where the
scene goes, for chrome like a task bar with the clock and the battery. The
default is no layout (a scene is the whole frame).

- **`<yield />`** (the contract's `scenes.yield`) is where the wrapped scene goes.
- `settings.isLayout: true` keeps it out of the scene list, the scene switcher
  and next/previous. A frame never boots to one. Shown on its own (the editor,
  a `setCurrentScene` by id) its yield draws nothing.
- Its fields are parameters. Each scene that uses it sets them in
  `layout.state` on the install, as a split panel sets a panel's options.

## What can be a layout

A layout's render is **one JSX app, drawn to the frame, with a `<yield />`**: a
`render` event, one `render/image` and nothing after it, its image fed by an app
with an `app.tsx`. That shape is what lets the runtime draw around the scene it
wraps instead of compositing a picture of it, which was 5x slower on an animated
scene on an ESP32-S3 (`docs/scene-layout-fixtures.json` pins the rule, in
`sceneLayoutProblem` and the backend's `scene_layout_problem`).

Every door checks: the "Use as layout" switches and the cloud's Type field stay
off and say why, a backend refuses it when a frame is saved, a scene is uploaded
or a saved scene is edited, the cloud refuses a store version
(`invalid_layout_scene`, in `validateSceneZip`), and `scene-lint` bounces it back
to the AI. The runtime does not check: a layout with no yield shows no content.

**Starters.** Every repo sample whose scene is a layout (`Top bar`, `Bottom bar`,
`Side rail`, `Windows 98`, `Tiling`, `macOS`, `BeOS`, `Polaroid`, `Front page`,
`Terminal`, `Gallery wall` in `repo/scenes/samples`) is also one click away on both planes
(`frontend/scripts/generateLayoutStarters.mjs`): "New layout" in the frame's
Layouts group, "Add layout" at the end of the Add scene drawer while it has none,
and "Add a layout" in its Settings under Layouts. The iOS app offers the same
list (the script also writes `ios/FrameOSKit/.../LayoutStarters.json`): "New
layout" under a frame's Layouts, "Add layout" in Add scene while it has none. Each sample's `thumb.jpg` is
shown in those lists and saved as the added layout's picture.

**In the preview.** The live preview of every scene workspace (a store scene's
page, a frame's scene, a saved scene) has a Layout select under Device: "No
layout", the layouts among the scenes it runs, then every starter not already
among them (by id or name). Picking one makes every scene wear it, as a frame's
active layout does, and runs a starter's scene beside them
(`sceneWorkspace/lib/preview-layouts.ts`); nothing the editor holds changes. It
starts on the layout the shown scene wears (a frame's scene keeps its own), is
not offered while the scene shown is a layout itself, and the starters load with
the panel rather than the page.

**In the store.** Layouts have their own shelf (`layouts` in
`cloud/apps/auth-web/src/lib/categories.ts`). A scene published with a layout as
the one it starts on goes there without asking the classifier, and an owner can
still move it.

**Safe mode.** A layout can leave a frame unusable, and the settings that would
take it off are drawn inside it. Ten pulls down from the top edge of a touch
screen, each within five seconds of the last (`gestures.safeModePulls` and
`safeModeGapMs` in the events contract) and with no swipe in from another edge
between them, open the frame's settings page with no
layout around it (`sceneSettings {page: "safe"}`). Safe mode changes nothing by
itself: the layout is only left out of that panel, so Cancel, Back or the idle
timeout go back to the scene as it was, and anything set there is what Save saves.
The dispatcher counts the pulls before any event map, so a bad map cannot hide
them, and logs `layout:safeMode`. A frame whose control plane turned the page off
gets the scene's form, without the layout, instead. A frame with keys alone has no
pull; there the control plane changes the layout.

**Around the built-in scenes.** The scene list and the settings are drawn in the
layout of the scene they were opened from, so a taskbar stays up. The dispatcher
hands the built-in scene that layout (`state.layout`, `event_loop.nim`), and it
runs through the same pass as any scene wearing one (`FrameScene.ownRun`,
`builtInRunner`). `app.frame.systemScene` is true in the layout's app meanwhile:
`if (app.frame.systemScene) return <yield />` gives them the whole panel.
Its `app.state.openedOver` then holds the name of the scene the built-in scene
opened over (a layout is made afresh around it), for a taskbar to keep that
scene's button.

**On the frame.** Frame settings has a Layout select, with a gear for that
layout's fields. The choice covers every scene until "As each scene says" is
picked, and what the gear sets overlays the install's `layout.state`. Both are
the frame's to keep (`layout_choice.nim`, in the hosts' per-scene state files under
`frame-layout` and the layout's id). No plane is told: the selects in the
workspace keep showing what each scene was given.

**What a layout can ask.** `app.frame.sceneName` is the name of the scene it
wraps (its own, shown on its own), `app.frame.wifiRssi` and
`app.frame.batteryPercent` are what the frame knows, and its handlers can open
the built-in screens with `frameos.dispatch('sceneSwitcher')`,
`frameos.dispatch('sceneSettings')` and `frameos.dispatch('sceneSettings', {page:
'frame'})` for the frame's own page, which is all the Windows 98 taskbar's Start,
gear and tray do (on a desktop of windows, a scene's settings open from the gear
button on its title bar, and `frameos.dispatch('terminal')` opens the terminal,
`docs/terminal.md`). A clock that shows no seconds calls
`frameos.setNextSleep` with the seconds left in the minute, and the chrome then
costs nothing until it changes.

## How it works

`layout: {sceneId, state}` sits beside `nodes` on the installed scene. The first
render of a scene as the frame's own makes the layout an instance held by the
scene (`sceneNodes[LayoutSceneKey]`, so teardown and the memory budget see it).
From then on, one host loop and one scene:

- **The host still knows one scene.** `setCurrentScene`, persisted state, public
  fields and the scene id on the frame are all the content's. The layout has
  no state of its own on disk.
- **A render pass enters the layout**, and the yield runs the content through
  the same schedule as any panel. Chrome and content each render when due
  (`docs/scene-rhythm.md`), the frame wakes for whichever comes first, and what
  is not due is not touched at all.
- **Pointer events go to what is under them, in its own coordinates**: over the
  content to the content, over the chrome to the layout. Keys, buttons and
  custom events go to the content and then the layout.
- A scene shown as a panel of another has no layout of its own: only the scene
  the frame shows is wrapped.
- A layout that is not on the frame leaves the scene as it is (`layout:missing`,
  logged once).
- **A `<yield />` and a `<Scene>` are holes in the canvas** (up to eight in a
  UI). The chrome is drawn around them and each scene straight into its
  rectangle of the canvas, as a split's panel is: no picture of it is made, what
  is not due stays where it is, and a scene's damage repaint works there as it
  does on the whole panel. A pass the UI has nothing to do in does not enter it
  at all (no JavaScript, no tree, no raster): a 20 fps scene in a clock bar pays
  for the bar once a second, and a dashboard of `<Scene>` tiles redraws only the
  tile that is due. Its chrome comes out of whichever frame buffer holds it,
  around the holes. That holds inside another hole too.
- **What makes one a picture instead:** `opacity` on it or around it, anything
  painted after it that lands on it, a box that scrolls around it, a second
  `<yield />`, or a UI whose render is more than the one app. It still shows,
  composited, at that cost. A UI holding a picture runs on every pass.
- **Floating chrome is a picture:** something drawn over a yield or a `<Scene>`
  makes it one while it is there. On a Pi, an element there that listens for a
  pointer event takes it (a menu, the window in front): see "Windows".
- A layout's JS app can hear the frame's events: `events` in its `config.json`
  and an `onEvent` (`docs/events.md` "Apps that subscribe").

Inside a JSX `<Scene>` or a panel, the keyboard-on-the-screen's flash and held
backspace (`uiTimer`) only reach the frame's own scene, not a nested one.

## Windows

On a frame that runs its scenes side by side (a Raspberry Pi, and the browser
when the page asks for it: `frameos_wasm_set_windowed`, the worker's
`windowed`), a layout can be a desktop: every scene opened in a window or a tile
of its own, all of them running, one with the focus. The samples `Windows 98`
(overlapping windows that open at its "Window size", 800×480 unless set
otherwise, filling the desktop where that does not fit, and where they were
when their scene opens again; moved and sized with the mouse, snapped to a half or the
whole desktop at its edges, a taskbar of what is open, a Start menu and desktop
icons, Alt+Tab and Alt+F4, full screen with F11, a gear button at the left of a
scene's title bar for its settings, Start's Control Panel and Terminal) and `Tiling`
(tiles that keep their places in an arrangement the top bar steps through: the
first large on the left and the others in a column, the first on top and the
others in a row, an even grid, columns, rows; the gap between tiles dragged moves
that split, kept per arrangement; a press anywhere in a tile is its scene's at
once and gives it the focus, a tile's bar dragged onto another tile, bar or
picture, swaps the two, a gear on each bar opens that scene's settings as a tile
of their own, and the top bar's gear the frame's) are two. `macOS` and `BeOS`
are desktops of overlapping windows the way `Windows 98` is, at the same "Window
size", moved, sized and snapped the same way, with their own chrome: on `macOS`
the traffic lights close, put away and zoom a window, a gear at the right of its
title bar opens its settings, the Dock has the frame's scenes (a dot under the
ones open), Launchpad, System Settings and Terminal, and the menu bar's Scenes,
Settings and Window open a scene, the settings of the one in front and the
windows open (full screen there, or F11); on `BeOS` a window's yellow tab (grey
behind) has its close, gear and zoom boxes and puts it away on a double click,
the Deskbar lists the windows open and its gem opens the Be menu (the scenes,
Preferences, Terminal), and Tracker's icons under it open the frame's own apps.
The desktop icons of `Windows 98` and `BeOS` are those apps alone, never the
frame's scenes (the menus have those): the scene list, the scene store and the
asset browser, the terminal and the frame's settings. The **Scene store** and the
**Asset browser** (`docs/scene-store.md`) are scenes like any other, found by
their sample's id (`scene-store`, `asset-browser`) or their name; where the frame
has them each desktop has entries of its own for them and leaves them out of its
scene lists: the top of `Windows 98`'s Start, a bag for the store in `Tiling`'s top
bar, `macOS`'s Dock beside System Settings (and the store in its mark's menu),
`BeOS`'s Be menu. Everywhere else (an ESP32, an editor's preview) they draw the one
scene, as before.

A layout also dresses the frame's own pages (the settings, the scene switcher,
the terminal, the keyboard on the screen) in its look: its state's `theme`
(`docs/jsx-ui.md` "Themes"). The samples set it from their "Look of the settings
pages" field, High contrast among the choices.

The runtime gives a layout three things and keeps no windows of its own:

- **`app.frame.scenes`**, the frame's scenes (`{id, name}`, layouts left out, in
  its order), only on a host that runs them side by side: a layout tests for it.
  **`app.frame.sceneId`** is the id of the scene it wraps.
- **A `<Scene id>` in the layout around the frame's scene is that scene itself**,
  the host's own instance (`hostSceneFor`: runner.nim, single_scene_host.nim),
  not a copy: it runs on its own `refreshInterval` in its window, and it is the
  same one, state and all, when it comes forward. The scene with the focus is
  the frame's scene and goes in the `<yield />`; a layout brings another forward
  with `frameos.dispatch('setCurrentScene', {sceneId})`, so the focus is what
  the scene list, next/previous, the API, the control planes and the voice chat
  already move. A scene twice, or the wrapped one as a `<Scene>`, draws once. A
  scene in a window wears no layout of its own. Keys go to the scene with the
  focus, then to the layout. A `<Scene>` given props is a copy those props set,
  as anywhere: `<Scene id="clock" city="Oslo" />` twice is two clocks.
- **One layout instance goes along from scene to scene** (`carryLayout`, the
  ESP32's parked layout), put on at the switch (`wearLayout`), so the release of
  the press that switched already reaches the new scene through it: what it
  keeps in `frameos.setState` (which windows are open, where, which is
  minimized) outlives the switch. A push, a deploy or a reload hands that state
  to the layout's next instance (`carryLayoutState`); a restart does not, and
  the scene shown then opens alone.
- **Another layout chosen keeps the scenes open.** A desktop keeps what it has
  open in its state as **`openScenes`**, scene ids in its order, the one with
  the focus last. When another layout takes its place (the frame page's Layout,
  `frameos_wasm_choose_layout` in the browser, a push that dresses the scenes in
  another), the runtime hands that list to the new layout's fresh instance
  (`carriedOpen` in `interpreter.nim`, off the ESP32), and a desktop that starts
  with no windows of its own opens those: the samples cascade them as windows
  or lay them out as tiles, the frame's own scenes named by what they are. The
  scenes are the host's, so they run on as they were; only where each window
  was is the old layout's own.

**The frame's own scenes are windows too.** The scene settings, the scene
switcher and the terminal (`isBuiltInScene`; the terminal is `docs/terminal.md`)
open over the scene in front the way any scene comes forward, so a layout gives
them a window like the others; `app.frame.sceneName` says what one shows ("Scene
settings", "Frame settings", "Layout settings", "Scene switcher", "Terminal"),
and `Windows 98` names its windows after it ("Clock Properties", "Control
Panel"; `macOS` "Clock Settings", "System Settings"; `BeOS` "Clock Settings",
"Preferences"), with no gear where a scene's window has one. Each
scene's settings are a scene of their own here, `app.frame.sceneId`
`system/sceneSettings#<scene id>` (`docs/scene-settings.md` "In a window"), so a
layout gives each its own window, named after the scene after the `#`; the plain
`system/sceneSettings` is the frame page, one window. Opening one over another
built-in scene, a layout brings the scene window on top forward first, so the
one open stays open in its window. The host keeps a built-in scene the focus leaves
for another window, as it keeps any scene (`builtInScenesStay`): it stays open
there with its page and its edits, and does not time out. A `<Scene id>` of one
is that instance only while it is open so, never a new one: it has nothing to
show until the dispatcher opens it from a scene, and opened so again it starts
afresh. It goes back by itself as always (Save, Cancel, a scene picked, its
timeout while it has the focus), and then it is done: a layout closes its window
when the focus leaves a built-in scene for a scene without the layout having
moved it (the samples remember what they brought forward, `asked`). Going back
always lands on a scene, so one built-in scene leaving the focus to another (a
scene's settings opening the frame page) stays open.

And the pointer: anything the layout draws over a scene that listens for an
event takes that event there (`uiOverScene`, `UiRegion.scene` marks where each
scene is in paint order), and a press it took is its own to the end, its tap,
double tap, long press and swipe included, and its moves and its release
too, over any scene (a scene an earlier press left captured included). What the layout drew under a scene
hears nothing of the pointer there. So a transparent box with an
`onPointerDown` over a window behind brings it forward without the scene hearing
the press or its tap, a title bar drags its window over the others, and a menu
over the yield is the menu's. **A handler on a `<Scene>` itself is the
layout's** (`<Scene id={id} onPointerDown={() => focus(id)} />`): not a prop of
the scene (it makes no copy), it runs when an event reaches that scene there,
as it starts (`uiSceneHandler`, from `routePointer`), and the scene has the
event all the same. That is how `Tiling` gives a tile the focus on the press its
button has, where `Windows 98`'s covers keep a first press on a window behind
for bringing it forward. Not on an ESP32, whose layouts run no windows. A menu over a box that closes it on a press takes
the press itself (an `onPointerDown`, even an empty one): a press goes to the
topmost element with a handler for it, and the render it causes before the
release would take the item away from its click. A transparent box costs
nothing; anything with a background, a border or a picture over a scene makes
that scene a picture while it is there, so windows behind the one in front are
composited, and tiles that do not overlap all stay holes. A window hanging off
the desktop's edge, any edge, is a picture cut there, not a hole squeezed into
what shows.

Windows pace the frame as a split's panels do: the first one due wakes it,
except on e-paper and a deep sleeper, where none wakes it sooner than the scene
it wraps would (the floor). Their pictures count against the same copy budget.
A scene that cannot start in a window is not tried again until the scenes
change.

The cost is off the ESP32's build (`when not defined(frameosEmbedded)`), whose
layouts wrap one scene.

## Control planes

A layout is a regular scene with `settings.isLayout: true`. Which layout an
installed scene wears is the **install's** choice, and it travels beside the
scene the way the button map does (`docs/events.md` "Event map"):

```json
{ "id": "clock", "nodes": [], "edges": [],
  "layout": { "sceneId": "chrome-bar", "state": { "height": 40 } } }
```

`sceneId` names another scene on the same frame. `state` is that layout's
public fields as this install sets them. A scene that names a layout the frame
no longer has is drawn without one; the SPA reads it as "No layout".

| | Self-hosted backend | FrameOS Cloud |
|---|---|---|
| Stored | on the `frame.scenes` entry | `frame_scene_assignments.layouts` (migration 0076), `{ [runtime scene id]: {sceneId, state?} }`, validated by `src/lib/scene-layouts.ts` |
| Reaches the device | the entry as it is | `withSceneLayouts` writes it onto each pushed scene in `buildScenesPayloadForFrame`; a `layout` inside published content never travels |
| An update keeps it | the SPA's `updateScene` merges content over the entry; MCP `frame_scene_update` carries it over | every assignment write that omits `layouts` keeps the row's; null clears |
| Out of sync | `frame_sync` compares it beside `eventMap` ("Layout") | the per-assignment checksum covers the stamped scene |

Published content never carries it: the SPA strips it with `origin` before any
publish (`withoutSceneOrigin`, `cloudFrameScenesSave.ts`), and templates and
zips drop it (`withoutSceneLayout`, `templatesLogic`).

**A layout is not a scene to switch to.** `utils/sceneLayouts.ts`
(`scenesWithoutLayouts`, `layoutScenes`) is the one test the SPA uses: every
list, schedule picker and panel picker leaves layouts out, and the frame's page
keeps them in a collapsed "Layouts" group at the end of its scenes, editable
like any scene. The voice chat's `list_scenes` and `activate_scene` leave them
out on both planes (the cloud lists assignments, so a push settles
`frame_scene_assignments.is_layout`: every runtime scene of the version is one).

Any scene becomes a layout, and back, where its settings are: "Use as layout"
in the frame's scene settings and the embedded editor, Type in the cloud scene
page's Info column, and "Use as layout" in a backend's saved scene Edit dialog
(`PATCH /api/templates/{id}` `isLayout`, on the scene the template starts on).
A layout's drawer has Activate: it goes on every scene and what changed is
pushed (Deactivate takes it off them all). The layout every scene wears is the
frame's **active layout** (`activeFrameLayout`), marked in the Layouts group even
while that is collapsed. The same choice is the one Layout select in the frame's
Settings; each scene's own select is under Advanced. A starter added to a frame
wearing none goes on every scene, one added next to a layout in use waits for its
own Activate, and a scene that joins a frame with an active layout wears it
(`withActiveLayoutOnNewScenes`; on the cloud the assignment row says so too).
"Layout settings" in the scene's menu edits `layout.state`, and so does the gear
beside each select in those Settings; the one beside the Layout select writes it
to every scene wearing that layout.

**How often it renders** (`utils/sceneRhythm.ts`, `framePacedByInterval`):
where a render is free, a worn layout renders when its chrome or its scene is
due; on e-paper or a deep-sleeping frame the scene's own interval stays the
fastest it renders, whatever the chrome's clock says.
