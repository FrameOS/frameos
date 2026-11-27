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
- `settings.desktop: true` says it is a desktop that runs the frame's scenes
  in windows ([Windows](#windows)): the frame page lists the desktops apart
  from the layouts around one scene.
- `settings.devices` says it is made for one device, or a few: their hardware
  ids as the frame settings name them (`["seeed_reterminal_sticky"]`;
  `layoutDevices` in `utils/sceneLayouts.ts` reads it, and drops anything that
  is no id). Such a layout goes on the store's Device layouts shelf. Nothing
  on a frame reads it: a layout that knows its device reads the panel and the
  event map, as the reTerminal ones do.

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
`Side rail`, `Windows 98`, `Tiling`, `macOS`, `BeOS`, `Classic Mac`, `NeXTSTEP`, `OS/2 Warp`, `Omarchy`,
`Commander`, `Teletext`, `E-reader`, `Polaroid`, `Front page`, `Terminal`,
`Gallery wall`, `reTerminal Sticky`, `reTerminal` in `repo/scenes/samples`) is also one click away on both planes
(`frontend/scripts/generateLayoutStarters.mjs`): "New layout" in the frame's
Layouts group, "Add layout" at the end of the Add scene drawer while it has none,
and "Add a layout" in its Settings under Layouts. The iOS app offers the same
list (the script also writes `ios/FrameOSKit/.../LayoutStarters.json`): "New
layout" under a frame's Layouts, "Add layout" in Add scene while it has none. Each sample's `thumb.jpg` is
shown in those lists and saved as the added layout's picture. Every list of
starters shows the desktops apart from the full screen layouts, each by name
(the script's order; `layoutGroups` in
`frontend/src/utils/sceneLayouts.ts`, `SceneLayouts.groups` in the app), and so
do the layout selects of a frame's Settings, of each scene and of the preview:
under "Desktops" and "Full screen" when a frame has both kinds.

**In the preview.** The live preview of every scene workspace (a store scene's
page, a frame's scene, a saved scene) has a Layout select under Device: "No
layout", the layouts among the scenes it runs, then every starter not already
among them (by id or name). Picking one makes every scene wear it, as a frame's
active layout does, and runs a starter's scene beside them
(`sceneWorkspace/lib/preview-layouts.ts`); nothing the editor holds changes. It
starts on the layout the shown scene wears (a frame's scene keeps its own), and
the starters load with the panel rather than the page. A desktop chosen, worn or
edited runs the preview windowed (`windowed`, as the playground and a Pi do), so
its scenes open side by side; anything else runs one scene at a time.

**Editing a layout.** A layout run on its own has nothing in its `<yield />`.
When the scene being edited is a layout, the preview runs it around the scenes
beside it, each wearing it with the Settings tried here, and opens on the first
of them; a layout with no scenes beside it (its store page, a starter on its
own) is run around samples (`LAYOUT_PREVIEW_SCENES` in the generated
`layoutStarters.ts`: Clock, Weather demo, Calculator). The Layout select shows
the layout and is not changed there; its Settings open its fields. A frame's
Settings list each of its layouts under "Edit a layout", a link to the layout's
own scene page (every way into editing a scene opens one of the workspace's
pages). While a layout is shown, Settings beside the
select opens its public fields (the preview's own form rows): each value goes
over the `layout.state` the scenes give that layout, and the runtime boots again
with it (a checkbox or a menu at once, typing after a pause). The values are the
viewer's, kept in this browser by layout id (`frameos.preview.layoutSettings`,
unless the workspace is told not to remember), never on a scene or a frame.

**In the store.** Layouts are the store front's second side (Scenes |
Layouts), with three shelves of their own
(`cloud/apps/auth-web/src/lib/categories.ts`): Multi app layouts (`desktops`, the
desktops), Single app layouts (`layouts`; "Desktop layouts" and "Full screen
layouts" before 2026-11-19) and Device layouts (`devices`, made for one device:
2026-11-20). A layout is always on its kind's, whatever it
or its owner states (`validateSceneZip`'s `sceneCategory`: Device layouts when it
says `settings.devices`, else Multi app layouts when it says `settings.desktop`),
and a scene is never on one; the classifier never
sees a layout. A layout's page previews it around the samples, windowed for a
desktop (above). A frame's own Scene store lists them under a Layouts heading
and tries one on the frame before it is kept (docs/scene-store.md "Trying a
layout").

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
layout of the scene they were opened from, so a taskbar stays up: the one it
wears, its own or the one chosen on the frame (`layoutFor`; the scene store's
Try is a choice). The dispatcher hands the built-in scene that layout
(`state.layout`, `event_loop.nim`), which goes on once the scene has read it
(not at the `setCurrentScene` that carries it), and it runs through the same
pass as any scene wearing one (`FrameScene.ownRun`, `builtInRunner`).
`app.frame.systemScene` is true in the layout's app meanwhile:
`if (app.frame.systemScene) return <yield />` gives them the whole panel.

**While a scene types.** The keyboard on the screen of a field in the scene a
layout wraps is the frame's (docs/jsx-ui.md "The frame's keyboard"): docked at
the bottom of the panel, the layout laid out in what it leaves above it, its
bars and the `<yield />` with them; on a desktop of windows, a window of its own
over every other, whose keys type into the window in front without moving the
focus or the windows. `app.frame.typing` is true in the layout's app while that
scene has the keyboard up (`FrameScene.typing`, read off
`ui/events.keyboardShown` at the start of each layout pass, which runs the
layout again when it changes): `if (app.frame.typing) return <yield />` gives
the scene all the panel the keyboard leaves. The reTerminal layouts do this.
Its `app.state.openedOver` then holds the name of the scene the built-in scene
opened over, for a taskbar to keep that scene's button. Around a built-in
scene the layout is the instance the scene under it wore, lent while the
built-in scene shows and handed back with the scene (an ESP32 and the browser
preview, `single_scene_host`; a Pi's runner parks it at every switch), or made
afresh when that scene wore none.

**On the frame.** Frame settings has a Layout select, with a gear for that
layout's fields. It lists the layouts by category, a heading over each: a
layout's `settings.category` ("Multi app layouts", "Single app layouts", the
store's two layout shelves, their former titles going under them, or a name of the owner's own), else the shelf for
its kind (`settings.desktop`); the groups by name, and in each the layouts by
name, whatever the case (`layoutsInOrder`, `layoutGroup`; one group alone has
no heading). A host lists its layouts in no order of its own (a Pi's tables),
so the page sorts; an ESP32's scene index keeps `desktop` beside `isLayout`,
and a layout's category as a scene's (`fos_scene_store.c` `make_entry`). The
select holds the frame's layout whatever has the focus: on a desktop the one
layout instance goes along with the focus, so the frame page in a window
beside it wears none itself, and reads what it holds from the frame's choice
and the scene it was opened from (`heldLayout`), and its gear's fields from
the layout around the scene in front (`types.frameLayoutShown`). The choice covers every scene
until "As each scene says" is picked, and what the gear sets overlays the install's `layout.state`. Both are
the frame's to keep (`layout_choice.nim`, in the hosts' per-scene state files under
`frame-layout` and the layout's id). No plane is told: the selects in the
workspace keep showing what each scene was given. An ESP32's console sets the
choice too (`set layout <id>`, `none`, or `-` for each scene's own; read at
the next start), and the browser flasher sends the layout it picked for a
standalone frame that way: the scene switcher a tap board opens on as its home
wears the frame's choice alone (docs/scene-switcher.md), never the layout the
scenes name.

**What a layout can ask.** `app.frame.sceneName` is the name of the scene it
wraps (its own, shown on its own), `app.frame.wifiRssi` and
`app.frame.batteryPercent` are what the frame knows, `app.frame.eventMap` is
what the frame's keys and swipes do whatever scene shows (the frame's event
map, undefined in the preview of a scene: keep a default), and its handlers can open
the built-in screens with `frameos.dispatch('sceneSwitcher')`,
`frameos.dispatch('sceneSettings')` and `frameos.dispatch('sceneSettings', {page:
'frame'})` for the frame's own page, which is all the Windows 98 taskbar's Start,
gear and tray do (on a desktop of windows, a scene's settings open from the gear
button on its title bar). The `Terminal` layout's prompt, its "F2 settings" at the
top right and its status line are those three too; F2 on a keyboard is the
button as well (its app hears `keyDown`: `events` in its config.json and an
`onEvent`, after the scene it wraps), and while the settings show
(`app.frame.systemScene`, an `app.frame.sceneId` that starts
`system/sceneSettings`) the button is lit and the same command goes back. A
clock that shows no seconds calls
`frameos.setNextSleep` with the seconds left in the minute, and the chrome then
costs nothing until it changes.

A layout also dresses the frame's own pages (the settings, the scene switcher,
the keyboard on the screen) in its look: its state's `theme`
(`docs/jsx-ui.md` "Themes"). The samples set it from their "Look of the settings
pages" field, High contrast among the choices.

## Full screen

A scene can ask the layout for the whole panel: a book, a page of a PDF, a photo
want no bar around them. The scene says it, the person at the frame decides,
and the layout gives it:

- **The scene** sets `settings.fullScreen: true` (the editor's "Full screen" in
  the scene's settings), or declares a public `boolean` field with
  `role: "fullScreen"` whose value then decides, over the setting. The field is
  how people choose on the frame: it is one of the scene's settings there (the
  swipe down, the gear), in the SPA's and the iOS app's scene settings, and a
  `setSceneState` like any field. The Books and PDF viewer samples carry one,
  "Full screen", on by default.
- **The runtime** reads it on every render pass of the frame's scene
  (`full_screen.nim` `sceneWantsFullScreen`, from the interpreter where it reads
  `typing`: the same code on a Pi, an ESP32 and in the browser), and when the
  answer changes it marks the layout due, so a change in the scene's settings
  shows on the next render, no restart. Nothing new goes to a device or into an
  ESP32's scene index: the field and the setting are the scene's own.
- **The layout** hears `app.frame.fullScreen` (true, else undefined) and gives
  the panel by returning a bare `<yield />`, as it does for the built-in scenes
  and while someone types. It is a request, never forced: the reTerminal
  Sticky layout and the Top bar, Bottom bar, Side rail and E-reader layouts
  honor it; a desktop of windows and a frame-as-picture layout (Polaroid,
  Gallery wall) keep their look. On a runtime from before (2026.11.14 and
  older) the key is undefined and every layout keeps its bar.

The Sticky's header is the other half of the same idea, inside one layout: big
over the scene list (its home screen), a thin bar over a scene, none over a
scene that asks for the whole glass.

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
  logged once). It is looked for once per scene set, not at every scene start
  (`layout_choice.nim` `layoutMissing`; a host's new set calls
  `forgetMissingLayouts`, an ESP32's switch within one set does not).
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

On a frame that runs its scenes side by side (a Raspberry Pi, an ESP32, and the
browser when the page asks for it: `frameos_wasm_set_windowed`, the worker's
`windowed`), a layout can be a desktop: every scene opened in a window or a tile
of its own, all of them running, one with the focus. The samples `Windows 98`
(overlapping windows that open at their scene's own size, 800×480 where a scene
says none, filling the desktop where that does not fit, on bare desktop where
there is room (below), and where they were when their scene opens again; moved
and sized with the mouse, snapped to a half or the
whole desktop at its edges, a taskbar of what is open, a Start menu and desktop
icons, Alt+Tab and Alt+F4, full screen with F11, a gear button at the left of a
scene's title bar for its settings, Start's Control Panel) and `Tiling`
(tiles that keep their places in an arrangement the top bar steps through: the
first large on the left and the others in a column, the first on top and the
others in a row, an even grid, columns, rows; the gap between tiles dragged moves
that split, kept per arrangement; a press anywhere in a tile is its scene's at
once and gives it the focus, a tile's bar dragged onto another tile, bar or
picture, swaps the two, a gear on each bar opens that scene's settings as a tile
of their own, and the top bar's gear the frame's) are two. `macOS` and `BeOS`
are desktops of overlapping windows the way `Windows 98` is, opening at the same
sizes, moved, sized and snapped the same way, with their own chrome: on `macOS`
the traffic lights close, put away and zoom a window, a gear at the right of its
title bar opens its settings, the Dock has Launchpad, the scenes that have a
window (a dot under each) and System Settings, and the menu bar's Scenes,
Settings and Window open a scene, the settings of the one in front and the
windows open (full screen there, or F11); on `BeOS` a window's yellow tab (grey
behind) has its close, gear and zoom boxes and puts it away on a double click,
the Deskbar lists the windows open and its gem opens the Be menu (the scenes,
Preferences), and Tracker's icons under it open the frame's own apps (under
where the Deskbar reaches now, and on in columns to its left, so a window opened
never puts the Deskbar over one).
`Classic Mac` and `NeXTSTEP` are two more of those, in black and white and in
four greys, so they look the same on every panel. On `Classic Mac` the window in
front has a pinstriped title bar with its close, gear and zoom boxes, and a
double click rolls a window up to its title bar (WindowShade) and down again; the
menu bar's mark has About This Frame and the frame's own apps, File opens a
scene, closes the front window or opens its settings (Get Info), Scenes lists
them, Special cleans up the windows or goes full screen, and the Application
menu at its right end hides the front window or the others and lists the
windows open. On `NeXTSTEP` the main menu is a column at the top left that no
window goes under (Info, Scenes, Windows, Services for the frame's own apps,
Hide), the Dock down the right edge has the scenes that have run there (a window
open, or one closed) with an ellipsis under those not running now and a clock
tile for the frame's page, and a window put away is a miniwindow under the main
menu. `OS/2 Warp` is a desktop of 1996: the WarpCenter along the top (its first
button the Desktop menu of the frame's scenes, the second the Window List, the
frame's own apps in its tray, and the signal, the battery, the date and the clock,
which open System Setup, the frame's page), icons down the left, and the
LaunchPad at the bottom of the desktop, under the windows (Windows, Scenes with
the arrow to its drawer of scenes, the frame's own apps, Setup; "Show LaunchPad"
turns it off). A window's title is in the middle of its bar; the icon at the
bar's left opens its system menu (Restore, Hide, Maximize, Settings, Window list,
Close), and its buttons are the gear, hide, maximize and close. A hidden window
is in the Window List alone, grey, and comes back from there; the Window List
also tiles the windows in a grid and cascades them. A right click or a long press
on bare desktop opens the desktop's pop-up menu. The keys are OS/2's: Ctrl+Esc
the Window List, Alt+F9 hides, Alt+F10 maximizes, Alt+F5 restores, Alt+F4
closes, Alt+Tab, F11. `Omarchy` is a tiling desktop after Omarchy 4 (Quattro): a
thin bar along the top (its menu, the workspaces, the workspace's layout, the
window with the focus; the day and the time; the signal and the battery, which
open Setup, the frame's page; a double click on its empty stretch makes it
transparent, a swipe across it goes to the next workspace), and every scene a
tile with gaps and a border in the theme's accent where it has the focus, no
title bars. Scenes open on the workspace showing (1 to 5 in the bar, and any
further one in use). Each workspace has a layout of its own, which Super+L or
the bar's mark goes through: dwindle (each tile takes half of what the one before
left, across where that is wider than tall; Super+J turns it around), scrolling
(columns half the desktop wide in a strip that scrolls to the window with the
focus) and floating (windows with a title bar, at their scene's own size where
there is room, moved and sized as on the other desktops, and a dock along the
bottom with the frame's own apps, the windows open and the whole menu; Super+M
puts one in it). A press in a tile gives it the focus and reaches its scene too.
Super+Space opens the menu, a field that filters the frame's own apps, its
scenes by category and the desktop's commands (Setup, the scene list, the
window's own, the layout, the theme, the bar, the bindings). The keys are
Omarchy's, Super being the key its "Super key" setting says (Super or Ctrl by
default, as a browser keeps Cmd+W and Cmd+Space and no Mac binds Ctrl; or
Super, Ctrl or Alt alone): (Super+1 to 0, with Shift the window goes there, Super+Tab, Super+W or
Q, Super+F, Super+arrows, with Shift the tiles swap, Super+Return the terminal,
Super+Shift+F Files, Super+K, Super+Ctrl+W Setup, Super+Shift+Ctrl+Space the next
theme, Alt+Tab), and the theme is one of eleven of Omarchy's (its field
`scheme`), whose colors the frame's own pages wear too. `Commander` is a desktop of two panels and no
windows: the scene with the focus in one, a second scene running in the other
(two at most, which every host can run), a press or Tab giving the other the
focus, and the function keys along the bottom (F5 swaps the panels, F6 shows the
next scene, F10 turns the other panel into the Info panel and back, F3 gives the
panel with the focus the screen). A scene brought forward from anywhere else goes
into the panel with the focus; chosen in another desktop's place it opens the two
that desktop had in front, and hands the next desktop those two as halves.
**A scene's own window size.** A scene says the size it looks best at in
`settings.windowSize`, `"WxH"` in a desktop's pixels (`"480x480"` for the Now
playing player, `"480x800"` for a tall list; "Window size" in the scene's
settings, on both planes and on the store's scene page). The hosts list it
beside the scene's name in `app.frame.scenes` (`windowSize`): a Pi from the
deployed or pushed scene, an ESP32 from its scene index (`fos_scene_store.c`
`make_entry` writes it, so the scene stays on flash), the browser from the
loaded scenes. `Windows 98`, `macOS`, `BeOS`, `Classic Mac`, `NeXTSTEP`, `OS/2 Warp` and `Omarchy`'s floating workspaces open
a new window of the scene at that size, made smaller with its shape kept where
it does not fit the desktop and another window is open, and a scene that says
none at 800×480, a 7.5-inch frame's. That is `ownSize`, the same text in the
seven: a desktop has no window size of its own (its "Window size" field, with
"The whole desktop" among its choices, was taken out on 2026-11-17, and what a
frame kept of it is never read). The first window still fills the desktop where
its size does not fit, as the frame looked before anything else was opened, and
any window fills it from its zoom or maximize button, or let go at the top edge,
and opens that way again when its scene does (until a restart). A window's place and size once moved are the desktop's
own, as before. `Tiling` and `Commander` have no window sizes.
**A scene's icon.** `app.frame.scenes` also lists a scene's `icon`, where it
has one (`settings.icon`, docs/scene-icons.md): one SVG path in a 24 box, for
a desktop to draw with `fill="currentColor"` on a window's title bar, a task
button or a menu. Every host lists it from the same place as `windowSize`
(an ESP32 from its scene index), checked: a value that is not an icon is left
out, so a layout never has to check it.
**Where a new window opens.** Those seven put a new window where it covers the
least of the windows open: all of it on bare desktop where there is room, the
highest such spot first, then the leftmost, a small gap from the others and from
the desktop's edges. Where nothing is free, it keeps off the desktop's icons if
it can (`Windows 98`'s down the left, `Classic Mac`'s down the right, and on
`BeOS` the column left of the Deskbar that Tracker's icons move into as the
Deskbar grows), then covers as little of the windows as it can, a title bar
counting five times over, so no window opens right over another and every title
bar stays in reach. The taskbar, the menu bars, the Deskbar's column, the Docks
and `NeXTSTEP`'s main menu are not part of the desktop at all, nor is `OS/2
Warp`'s WarpCenter (its icons down the left and its LaunchPad are kept clear like
the others' icons). The rule is one
function, `freeSpot`, the same text in each layout (a scene cannot share code
with another): it tries the desktop's corners and thirds, the spots beside each
window and icon, and a title bar down from each window, a few hundred with a few
windows open, each a sum over the boxes, and only when a window opens, so it
costs an ESP32's JavaScript next to nothing.
Windows that do not overlap are holes, each scene drawn straight into its window
(below): a window opened clear of the others costs no picture of its own. A
scene that had a window before opens where it was, as before.
**A desktop of another size.** The windows' boxes are in the desktop's pixels,
and the desktop is the panel over the render scale (docs/jsx-ui.md "Scale"): a
new scale, a turn or a browser window resized gives it another size. Each of
the seven keeps the size its boxes were made for (`room` in its state) and, on
another, puts every window, and every closed window's box, at the same share of
the desktop (`refit`, the same text in each), so a window stays where it was on
the glass, its scene drawn at the new scale inside it. Before, a scale of 0.5
left every window in the top left quarter and one of 2 put them off the panel.
`Tiling` tiles,
its tiles never over one another and a new one the next place in the
arrangement, so it has nothing to choose; `Commander` has its two panels.
**Long lists of scenes.** Each desktop's list of the frame's scenes (`Windows
98`'s Start, the Scenes menus of `macOS`, `Classic Mac` and `NeXTSTEP`, `BeOS`'s
Be menu, `OS/2 Warp`'s Desktop menu and LaunchPad drawer, `Omarchy`'s menu, `Tiling`'s +) scrolls where it is longer than the screen, under a
finger as under a wheel, and so does `BeOS`'s Deskbar with many windows open.
The lists go by category: a scene's `settings.category`, its category by name
("Photos", "Clocks & time"; docs/scene-icons.md "Category"), reaches a layout as
`category` on its entry of `app.frame.scenes`, and each list has a heading over
each category, under that name, "System" first (the frame's own apps), the
other categories by name whatever the case, and the scenes with none last as
Other. Nothing maps a category: a name of the
owner's own is a heading like the store's. Where no scene has a category (an
older runtime lists none), the list is as it always was. That is `grouped`, one more function the same text in each of those
eight layouts. The scene switcher groups its own list by the same rule in Nim
(`grouped` in `system/sceneSwitcher/scene.nim`, docs/scene-switcher.md "What
it lists"): change it with them. A scene's own icon (`icon` on its entry, one path in a 24 box:
`docs/scene-icons.md`) is drawn, in the color of the text around it, wherever a
desktop draws a scene's icon: `Windows 98`'s Start, taskbar and desktop icons,
the `macOS` Dock and Scenes menu, `BeOS`'s Be menu, Deskbar and Tracker's icons,
the `Classic Mac` menus and icons, `NeXTSTEP`'s Dock and miniwindows, `OS/2
Warp`'s menus, title bars and Window List, `Omarchy`'s menu and dock, `Tiling`'s +. A scene without one gets the desktop's own, as before, and the scene store,
Files and the terminal keep the desktop's drawings of them even where they have an icon of their own. That is `ownIcon`, the
same text in the eight. `Commander` draws no icons. Launchpad and the Scenes icons open the
frame's own scene list (the scene switcher, `docs/scene-switcher.md`), which is
the runtime's, not a layout's.
The desktop icons of `Windows 98`, `BeOS`, `Classic Mac` and `OS/2 Warp` are those apps alone, never the
frame's scenes (the menus have those): the scene list, the scene store,
Files, the terminal and the frame's settings. The **Scene store**,
**Files** (`docs/scene-store.md`) and the **Terminal**
(`docs/terminal.md`) are scenes like any other, found by their sample's id
(`scene-store`, `asset-browser`, `terminal-app`) or their name; where the frame
has them each desktop has entries of its own for them and leaves them out of its
scene lists: the top of `Windows 98`'s Start, a bag for the store and a prompt
for the terminal in `Tiling`'s top bar, `macOS`'s mark's menu (the store and
the terminal; each in the Dock while it has a window), `BeOS`'s Be menu,
`Classic Mac`'s mark's menu and icons, `NeXTSTEP`'s Services and Dock, the top of
`OS/2 Warp`'s Desktop menu, its WarpCenter's tray, icons and LaunchPad, the top of
`Omarchy`'s menu, its dock and Super+Return and Super+Shift+F, and `Commander`'s F7
to F9. Everywhere else (an editor's preview) they draw the one
scene, as before.

`Teletext` and `E-reader` are not desktops, but they read `app.frame.scenes`
where a host has it: Teletext numbers each page by the scene's place in the list
(P101 the first, P100 the index) and names the scenes its red and green links go
to, and the E-reader's footer says "Scene 2 of 5". Elsewhere Teletext makes a page
number from the scene's id and the E-reader shows the date.

The runtime gives a layout three things and keeps no windows of its own:

- **`app.frame.scenes`**, the frame's scenes (`{id, name}`, layouts left out, in
  its order), only on a host that runs them side by side: a layout tests for it.
  **`app.frame.sceneId`** is the id of the scene it wraps. **`app.frame.windows`**
  is how many may run at once where that is limited (below).
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
  (`carriedOpen` in `interpreter.nim`), and a desktop that starts
  with no windows of its own opens those, the frame's own scenes named by what
  they are. The scenes are the host's, so they run on as they were. Where each
  one was goes along too, by a convention of the layouts the runtime only
  carries: **`openPlaces`**, beside `openScenes`, by scene id, `{x, y, w, h}` as
  shares (0 to 1) of the whole picture (so a desktop whose bars are elsewhere
  puts a window where it was on the glass) with `max`, `snap` (`'l'` / `'r'` /
  null) and `min`. The desktops of windows open each scene there, kept on their
  desktop, and put the ones it does not place where there is room, as any new
  window (`freeSpot`, above); `Tiling` writes its tiles'
  boxes and, taking over, orders its tiles by where the windows were, left to
  right.

**The frame's own scenes are windows too.** The scene settings and the scene
switcher (`isBuiltInScene`) open over the scene in front the way any scene comes forward, so a layout gives
them a window like the others; `app.frame.sceneName` says what one shows ("Scene
settings", "Frame settings", "Layout settings", "Scene switcher"),
and `Windows 98` names its windows after it ("Clock Properties", "Control
Panel"; `macOS` "Clock Settings", "System Settings"; `BeOS` "Clock Settings",
"Preferences"; `OS/2 Warp` "Clock - Settings", "System Setup", "Scenes - Icon
View"; `Omarchy` "Clock settings", "Setup", "Scenes" in its bar), with no gear where a scene's window has one. Each
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
afresh. It goes back by itself as always (Save, Cancel, its
timeout while it has the focus, or its command again from anyone, which the
dispatcher marks as going back, `goneBack`), and then it is done. A scene picked
in the scene list is not going back here: the list is a launcher, open in its
window beside the scene it opened until it is closed (2026-11-22; before, a
pick closed it). Whatever else
takes the focus from it (another window, the API, a key, a schedule, the voice
chat) leaves it open beside the scene showing, its page and edits as they were:
the scene modules list those in `builtInsAway`, which a layout reads as
**`app.frame.keptOpen`**, and the desktops close a built-in scene's window only
once it is gone from there (`keptOpen`, the same text in each). Before
2026.11.14 they guessed from what they had brought forward themselves
(`asked`), so a switch from outside closed the window while the host kept the
instance, and opening it again lost the edits; on an older runtime they still
guess so. Going back always lands on a scene, so one built-in scene leaving the
focus to another (a scene's settings opening the frame page) stays open.

**Closing opens nothing else.** The desktops keep one set of rules for what a
close, a minimize and a built-in scene going back do (2026-11-20; before, a
built-in window's close went back to the scene it was opened from, wherever that
was, and opened that scene's window again if it had been closed):

- A window closed takes its scene's settings window with it. The window in
  front closed or put away hands the focus to the window that had it before (the
  next one down; `Tiling`'s tile that had it last, `seen`), whatever scene it
  was opened from, a built-in one's included. With nothing left the desktop is
  bare: a scene stays the frame's scene with no window, and a built-in one goes
  back as its own Cancel does.
- **`app.frame.wentBack`** tells a layout that the scene it wraps is showing only
  because a built-in scene went back to it on its own (its Close or Cancel, the
  same command again, its timeout), not because anyone picked it: the dispatcher
  keeps the scene it went back to (`sceneWentBackTo`, `event_loop.nim`), and
  anything else that picks a scene clears it. Landing so, a desktop opens no
  window for a scene whose window was closed and leaves one put away where it
  is, and the window that had the focus before takes it. So closing the scene
  list, the settings or the frame page over a bare desktop leaves it bare,
  while the same scene picked in the list opens its window. The first scene a
  desktop just made shows always opens (a stale `wentBack` after a reload is no
  reason to show nothing).
- A built-in scene opened over another with no scene window left sends the
  first one back and closes its window, rather than leaving it drawn empty.
- `Omarchy`'s keys act on the window with the focus where it shows (on the
  workspace in view, out of the dock): on an empty workspace Super+W, Super+M
  and Super+Shift+number have no window, rather than closing one out of sight
  and taking the view there. A built-in scene opened there brings forward a
  scene on that workspace only, and coming back quietly to a window on another
  workspace leaves the view where it is.
- `Commander`'s F4 over a built-in panel goes back as the command does
  everywhere else (it did nothing), and F6 there shows the scene after the one
  under it (it showed the list's first). The scene lists opened from the
  one-scene layouts (`Terminal`, `E-reader`, `Teletext`) ask with `{swap:
  true}`, so over a scene's settings they open the list their button names.
- On a desktop, where both stay open in windows of their own, `sceneSwitcher`
  over a scene's settings opens the list beside them and `sceneSettings` over
  the list the settings of the scene it was opened from (the swipes up and down
  of a touch screen); where one scene shows at a time the other edge still
  closes either (docs/scene-settings.md).

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
for bringing it forward. A menu over a box that closes it on a press takes
the press itself (an `onPointerDown`, even an empty one): a press goes to the
topmost element with a handler for it, and the render it causes before the
release would take the item away from its click. A transparent box costs
nothing; anything with a background, a border or a picture over a scene makes
that scene a picture while it is there, so windows behind the one in front are
composited, and tiles that do not overlap all stay holes. A window hanging off
the desktop's edge, any edge, is a picture cut there, not a hole squeezed into
what shows.

A picture is part of the desktop's drawing, so a picture whose scene is due
draws the desktop again (its JavaScript, its tree, its raster). One that is not
due is the same picture as last time: a pass where only the holes are due
leaves the chrome and its pictures as the canvas holds them, or copies them
from the other frame buffer around the holes (`rhythmChromeCanStay`). Before,
any picture at all ran the whole desktop on every pass of the window in front:
1.9 fps for DVD logo bounce in Windows 98 on the SenseCAP Indicator, against
24 without windows (the hardware bench, 2026-11-19). And a window wholly under
another, the one in front or one above it, draws nothing of its scene
(`hiddenUnder`, the same text in the six desktops that stack windows): its
scene stays open and running, and draws again when it shows. Where only a few
scenes run at once (an ESP32, `app.frame.windows`), a window behind another runs
at most every five seconds (`scene_rhythm.WindowBehindSeconds`), whatever its
own interval: each of its runs is the whole desktop drawn again, and an
animation behind took the window in front from 20 frames a second to 1 on the
SenseCAP Indicator. Brought to the front, it runs at its own pace at once (the
switch starts a fresh pass). A Pi and the browser keep every window's own pace.

**Windows or one scene** (`windowMode`, every desktop of windows): Automatic,
On or Off. Off, the desktop shows the frame's scene alone in its look, one
window around it and its bars, and that window keeps the rules above: its close
leaves the bare desktop (it used to open the scene list), its minimize or hide
leaves a button that brings it back, and both stay so while the scene list or
the settings show over it and when the focus comes back (`wentBack`). Any scene
chosen, the same one picked in the list included, shows its window again, so a
scene put away is never put away for the next (the one layout instance goes
along from scene to scene, and the window's `minimized` used to go with it).
That is `arrive`, with `reopen` for a frame that keeps no layout from scene to
scene (a preview: its scene list opened from the desktop shows the window), the
same text in the six desktops of overlapping windows. Automatic is windows where the frame runs its
scenes side by side without a limit (a Pi, the browser) or four at once (16 MB
of PSRAM) on a screen of 640x480 or more either way up (`app.frame.width` and
`height`, the panel over the render scale), and one scene where it runs one or
two (`app.frame.windows`: an 8 MB ESP32, where a desktop of two windows is
mostly the one in front, and the one behind costs memory and frames) or the
screen is smaller (a 480x480 panel has no room for a window beside another).
`Commander`, whose two panels never overlap, is two wherever two may run on a
screen of that size. An install from before 2026.11.13, whose boolean
`windows` switch was turned off, stays off; the `true` every install kept from
the old default does not count (`windowsOn`, the same text in the seven
desktops of windows).

Windows pace the frame as a split's panels do: the first one due wakes it,
except on e-paper and a deep sleeper, where none wakes it sooner than the scene
it wraps would (the floor). Their pictures count against the same copy budget,
and a picture is asked for only when the largest free block under the reserve
holds it (`roomForImage`, idle interpreters without handlers let go first): a
window behind another on an 800x480 RGBX e-paper canvas is a 1-1.5 MB buffer,
and on an ESP32 one that does not fit is an out-of-memory abort, then a restart.
Without the room that window shows nothing that pass (`scene:embed:noMemory`,
logged once) and the rest of the frame is drawn. A scene in a window is told
the frame's size (`app.frame.width`), not its window's: an SVG it asks for at
that size and that its `render/image` stretches (or covers or contains at the
same aspect) is drawn straight into the window at the window's size
(`svgStretchesOnto`), never rasterized at the panel's size first.
A scene that cannot start in a window is not tried again until the scenes
change.

**An ESP32 runs a few at once.** Each window is a scene running, its program,
its JS apps' interpreters and its UI, beside the panel's buffers and the scene
in front, so where memory is short the host lets only so many run at once, the
one in front included: `app_runtime.windowLimit`, by what the device leaves its
scenes once the panel has its canvas and buffers (`memory.sceneMemoryBytes`):
2 from 4 MB (an 8 MB board with a panel up to 10.3"), 4 from 9 MB, 1 below
(the 13.3" colour E1004 on 8 MB, whose 3.84 MB canvas leaves about 2.5 MB),
the browser simulating a device counting the same, and no limit on a Pi or in
an ordinary preview. A layout reads it as `app.frame.windows` and opening
one more closes the one that had the focus longest ago (the samples: the
lowest window, `Tiling`'s tile opened longest ago). The host holds to it
whatever the layout does (`single_scene_host.makeRoom`): a scene brought to the
front lets the window kept longest ago go, a window asked for past the limit
first takes the place of one the desktop no longer has open (its `openScenes`)
and was not drawn in that pass, and otherwise stays empty (said once in the
log). After each pass the host lets go of a kept window the desktop does not
have open, every one without a desktop, and a scene the frame leaves stays
running only while the desktop has it open and there is room beside the next
(`keepsInWindow`): never where one runs at a time, and the window kept longest
ago goes at the switch, before the next scene comes off flash beside them (a
reTerminal E1004 ran the scene it left beside the one coming, and ran out of
memory, 2026-11-19). A layout parked between two scenes goes when the next one
starts a layout of its own, its open scenes handed to that one
(`releaseParkedLayout`). An ESP32 without a desktop keeps
one scene, as before (the scene under the switcher kept while there is room,
`covered`, its layout lent to the switcher and parked for its way back), and its one settings scene (`builtInScenesStay` follows the
desktop there, `followDesktop`). The firmware reads a scene off flash only to start it: one running
in a window comes to the front at once (`frameos_nim_scene_running`, then
`selectScene`), and the cache keeps only the scenes running. A board rendered
on its plane (`docs/server-rendering.md`) has no windows yet: the plane's wasm
renders one scene a pull.

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

## Made for a device: the reTerminal layouts

Two samples are made for one family of frames. The E-series one knows where
its keys are on the case (Seeed's drawings), so what a key does is written
beside the key: what a press does, and under it, smaller, what holding it
does; the keys' places are in a table at the top of the app (as a share of
the glass, the panel unturned), the side they are on follows
`app.frame.rotate`, and a "Keys are on the" field overrides it. The Sticky's
tells it in words on its home screen instead. Each reads `app.frame.eventMap`
for what the keys do, and falls back to the map the planes give that board.
Both give the settings the whole panel, and draw only when the scene draws:
on e-paper the chrome never wakes the frame sooner than its scene would
(`scene_rhythm.nim`).

- **`reTerminal Sticky`** (`layout-reterminal-sticky`). The Sticky is held
  upright, its panel turned 270, with three keys on its right edge: Action on top
  (Seeed prints AI on it, and `AI` stays its label in event maps, NVS and the
  fixtures), then UP and DOWN. Its presses, in the help's words: once: go (the
  scene's press, its `primary` role from the contract's `buttons.roleByLabel`:
  what is picked opens), twice: back, thrice: home (the scene list), held:
  talk (the board's preset map). People are told "Action" everywhere a key is named for them: the
  layout's help, and the SPA's and the iOS app's button rows (`keyTitle`,
  pinned by `docs/button-map-fixtures.json`).
  **One header that shrinks.** Over every scene is a thin bar (6.5 units):
  the time and the short date on the left (a tap: the scene list), the Wi-Fi
  signal and the battery on the right (a tap: the frame's page), a 2 px rule
  under it, one ink and no greys, so it stays crisp on the black-and-white
  panel. When the scene list is open (a swipe up, Action pressed thrice, or
  twice where the frame's map leaves that free: the layout's own binding), the
  same header is big: the layout turns the list into a home screen with the
  time and the date large, the battery and the signal, and under the list how
  to get around, a line each, read off the frame's event map: what Action does (once,
  twice, thrice, held: `once: go · twice: back · thrice: home · hold: talk`), what UP and
  DOWN do (in the list they move; held, the map's scene back and on) and the
  swipes. That is the one place the layout teaches
  the keys: a rail of tabs beside them on every scene was its first look, and
  nobody used it (removed 2026-11-23; an install that chose it gets the whole
  glass, as "Around the scene: Nothing" does).
  The signal is a fan of four (the dot and three arcs, the strength solid and
  the rest a hairline) and the battery its level and percentage, each only
  where the frame says it (`app.frame.wifiRssi`, `app.frame.batteryPercent`:
  an ESP32; none in the preview or on a Pi). The bar's clock asks for the next
  run when the minute turns (`frameos.setNextSleep`), and on e-paper that
  never wakes the panel: the chrome is drawn on the scene's own passes (the
  rule above), so the time shown is when the picture was last drawn, and a
  scene that draws more often than once a minute brings it up to date within
  a pass, in the same refresh. A press of Action that the frame's
  map leaves to the scene also draws the picture again (`render`).
- **`reTerminal`** (`layout-reterminal`), for the E1001, E1002, E1003 and
  E1004, the model read off the panel (size and colour) or set. A bar along
  the edge with the keys holds the scene's name, the signal, the battery and
  the time it was drawn, with a cap under each key: the arrows' press is the
  scene's (Next, Prev), the green key's draws the picture again (Refresh: the
  layout dispatches `render` for a press the frame's map leaves free), and
  the small word is the hold (a note under the scene's name says so: the
  E1001's keys are 44 px apart, no room for "hold"). On the E1001-E1003 the
  keys are on the top edge, right of centre, and seen from the front the one
  labelled RIGHT is the leftmost. The E1004's panel is upright (1200x1600)
  with the touch keys under the picture (printed alike: no green key, so the
  help says "Refresh"); hung landscape they are beside it, on the right at
  rotate 90 and on the left at 270, and so is the bar, a narrow strip
  (6.5 units) whose words are turned to run along it (an `<svg>` of `<text>`:
  the UI lays text out level), reading down on the right and up on the left,
  the battery's percentage under it. On a board rendered on
  its plane `app.frame.rotate` is the board's, as on the board, though the
  wasm runtime draws the canvas already turned. Over the scene list (both
  arrows held, the E1004's green key held: docs/buttons.md) the caps say what a
  press does there. The caps read the frame's map by label and by role, a
  key's role as the frame hangs (an arrow is Next where it points to the right
  or the bottom of the picture). The layouts hear the keys' `gpio` edges, never
  `button`: a layout that listens for `button` makes every scene it wraps one
  that does, and that scene's arrows would no longer be its `forward` and
  `back`. On the touch E1003 the name, the gear and the status are buttons too.

Both are on the store's Device layouts shelf (`settings.devices` names the
boards), the browser flasher starts those boards on them (its Layout select,
cloud/docs/flasher.md), and both are set up through their fields, on the install or from the
frame page's gear: whether the signal, the battery and the time show (24 or 12
hours, or none), whether the small hold words and the help lines do (the
E-series' hint under the name; the Sticky's date, in its bar and on its home
screen, and its help under the list), the Sticky's bar or nothing around a scene,
whether the Refresh key or Action draws the picture again when pressed (off: the
press is the scene's alone, and its cap says "To scene"), white on black or black on white, and the text size
(0.85, 1 or 1.2 times the unit, a hundredth of the shorter edge). A switch is
on until it is turned off, so an install from before keeps its look; the
Sticky's bar is the one new look an install gets without asking (it was
"Nothing" by default until 2026-11-24), and "Nothing" takes it off.

The pictures in their pull request were made with
`frameos/tools/wasm_layout_shots.mjs`: the wasm runtime run as each board
(size, canvas, pixel format, event map) and dithered to its panel.

