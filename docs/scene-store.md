# The scene store on a frame

*Written 2026-11-14.*

The FrameOS scene store, browsed and installed from the frame itself, is a
scene: **Scene store** (`repo/scenes/samples/Scene store`, one JSX app). Install
it like any other scene, open it from the scene list (on a desktop of windows,
from the layout's own entry for it: `docs/scene-layouts.md` "Windows"), and
pick Scenes or Layouts, open a category or search, scroll through the scenes,
and Preview or Install one. A scene the frame holds can be opened, updated or
deleted there. Leave the store (a preview, the scene list) and come back, and
it opens on the same spot.

**Files** (`repo/scenes/samples/Files`, scene id `asset-browser`, its name
until 2026-11-16) is its sibling for the frame's own assets folder: folders and
pictures as thumbnails or a list, a picture on the whole screen with a swipe to
the next, a slideshow, and New folder.

| Piece | Where |
|---|---|
| The app (its words, its looks, where it is) | the sample's `scenes.json` (`apps.sceneStore`, an `app.tsx`) |
| What a JS app may ask: `frameos.store()`, `frameos.storeAction()` | `frameos/src/frameos/scene_store_hooks.nim`, bridged in `js_runtime/app_runtime.nim`, declared in `frontend/src/utils/appTypeDeclarations.ts` |
| The host on a Pi | `frameos/src/frameos/scene_store_linux.nim` (a worker thread) |
| The host on an ESP32 | `embedded/esp32/main/fos_store.c` (a task of its own), through `frameos/src/embedded/embedded_runtime.nim` |
| The host in the browser preview (previews only) | `frameos/src/frameos/scene_store_preview.nim`, through `frameos/src/wasm/wasm_main.nim` |
| The store's listing for frames | `GET /api/store/device/scenes`, `GET /api/store/device/scenes/{id}` (`cloud/apps/auth-web/src/lib/store-device.ts`) |
| What a frame asks its plane | `POST /api/frames/{id}/panel/scenes`: cloud `src/lib/panel-scenes.ts`, backend `app/api/panel_scenes.py` (also `/api/panel/scenes`) |

The scene store was first built into the scene switcher in Nim (#723,
closed): +27.6 KB of ESP32 firmware for its pages. As a scene, its pages are
JavaScript in the scene and cost the firmware nothing; what the firmware
carries is the host (the network and the plane, which no app may do with the
frame's credential) and two bridge calls.

## The app has the words, the host the facts

`frameos.store()` is what the host knows now, read on every render:

```ts
{ url, version,          // the store this frame browses, and its FrameOS
  busy, error, done,     // the action running, the last one's refusal, the last that worked
  installed: [{ id, store, v }], // every scene on the frame from the store
  preview: { store, id, name } | null,
  updates?: [{ store, name, from, to, owner? }], // the plane's: below
  removeAny,             // a frame with no plane may delete any scene
  previewOnly? }         // the browser preview's host: Preview, never Install
```

`frameos.storeAction(action, args)` asks for work and returns at once:
`preview {store, name}`, `install {store, name, show}`,
`update {store}`, `updateAll`, `remove {store}`, `discard`. One runs at a time (one asked
while another runs is dropped: `busy` says what runs). The host does it off
the render task and renders the scene that asked again when it is done, if
that scene still shows (the Pi checks `shownSceneId()`, the ESP32
`fos_scenes_showing`). On an ESP32 the work runs on the one task that makes
every request a scene asks for (`fos_js_io_run`, `docs/async-js.md`), so the
store and an app's pictures never hold two TLS sessions.

Browsing is the app's: it `fetch`es the listing for frames from `url`
(`${url}/api/store/device/scenes?version=…&<its query>`), off the render, and
renders again when the page is in (`docs/async-js.md`). Where a render may
wait for it (no host, the browser preview, e-paper: one refresh per answer)
it asks in the render with `frameos.httpRequest`. Until 2026.11.10 the host
browsed for it (`storeAction("browse")`, `listing`); a store scene from before
that cannot browse on a newer frame. A re-read of what came from the store that found
nothing new draws nothing: on e-paper a render is a refresh.

The host answers null (`""` from the hook) where there is no store: the owner
turned the settings on the frame's screen off (`frame_settings_on_screen`,
which also covers this), and every runtime without a host: a board rendered
on its control plane (`docs/server-rendering.md`), a virtual frame. There the
app installs nothing
("Previews and installs happen on the frame itself"). That is one-sided on
purpose for now: a plane rendering a frame could be its host, and would answer
`storeAction` itself.

The browser preview has a host of its own that previews and installs nothing
(`frameos/scene_store_preview.nim`, turned on by the preview worker through
`frameos_wasm_set_store_preview`; the store is `storeUrl` in its init message,
else `https://cloud.frameos.net`). Its facts say `previewOnly: true`: the app
offers Preview, then Show and Discard, and says installs happen on the frame
itself. A preview fetches the store scene's `scenes.json`, and at the start of
the runtime's next pass loads its scenes beside the page's and shows the first
(the action comes from inside the store's own tap); Discard drops them and
goes back to the store, as does a second preview's Discard. The page's scene
select follows the runtime (the worker posts `sceneInfo` when the runtime
switches by itself), so the store is picked there again, and it opens on the
scene it previewed: the preview keeps a scene's `persist: "disk"` fields
across a switch for its life, as a frame keeps them on disk. A plane's renders
never turn it on: each is a fresh runtime, where a preview would be gone at the
next one.

### Browsing

The store this frame knows (its cloud provider, else `https://cloud.frameos.net`)
lists for frames at `GET /api/store/device/scenes`: the store front's filters
(`q`, `category`, `version`: only what runs on this FrameOS), `page`, `limit`
(1 to 24: the app asks 24 while it scrolls, a screenful of its grid on
e-paper), `prefer` (a shelf, or the need `fast`, that goes
first), `exclude` (shelves left out, comma separated), `without` (what the
frame cannot run: `fast`, `linux`; below) and `categories=1` for the shelves
(`{slug, title, layout?}`, `layout: true` on the two layouts' shelves). The
app before needs asked `prefer=realtime` / `exclude=realtime` of the Real time
shelf, which was the fast scenes: both still mean `fast`. Each
scene is `{id, name, category, version, by, about, image, thumb, icon?, needs?}`:
`about` the description cut to 140 characters, `image` the cover's path on
that host (`/api/store/scenes/{id}/image?version=N`, a redirect to the CDN for
a public scene), `thumb` the cover as a JPEG of at most 512 px, a URL on the
CDN (null without one, and on a store with no CDN), `icon` the scene's own
icon (docs/scene-icons.md), only when it has one, `needs` what it needs of a
frame (below), only when it needs something. Public, cached a minute,
readable from any page (the browser preview runs the app), limited per
address. The app draws the icon in a card's placeholder (in the letter's
place) until the cover is in, and beside the name on a scene's page; it checks
the path's characters itself, since a store at another address could send
anything.

A cover is the publisher's picture, often a megabyte of PNG: an ESP32 took 5
to 7 s to download and decode one for a card 140 px wide, with the panel
waiting, and 34 s once. The `thumb` is made once per cover, the first time a
listing names it (`src/lib/store-device-covers.ts`, the photo library's
thumbnailer), and stored next to the cover with `.device.jpg` after its key,
which the object-store sweep keeps while the cover's row lives. The frame still
fetches it from the CDN itself: the store scaling its own pictures, not a
proxy for a frame's images. The app takes the `thumb` for a picture up to 640
px wide (cards everywhere, a scene's page on a small screen) and the cover
itself above that.

### Categories

The store's shelves are `cloud/apps/auth-web/src/lib/categories.ts` (the SPA's
copy `frontend/src/utils/storeCategories.ts`, the iOS app's
`StoreCategories.swift`, kept equal by tests). The store front's first split is
**Scenes | Layouts**: what a scene is (`settings.isLayout`, `settings.desktop`,
`settings.devices`),
never a category it states. The scenes' shelves say what a scene is about:
Photos, Art & galleries, Clocks & time, Calendars & agendas, Weather, Home &
dashboards, Games, Fun & animations, Notes & tools, AI & generative, Demos &
examples. The layouts' are Multi app layouts, Single app layouts and Device
layouts (one made for a device: `settings.devices` names it, docs/scene-layouts.md),
and a layout is always on its kind's (`validateSceneZip`), a scene never.

A version's category is the one the scene names (`settings.category`, a
store title; docs/scene-icons.md), else the listing's, else the rules'
(`ruleCategory` in `store-classify.ts`: the node graph's apps and the name,
narrow on purpose), else the classifier's (an LLM, on the operator's key).
Every version has tags: the owner's, else the classifier's, else the rules'
(`ruleTags`: what it needs, the services its apps use, its category), so the
store's search finds every scene by more than its name. The Real time shelf
went on 2026-11-18 (migration 0084 filed its scenes under Fun): a fast screen
is what a scene needs, not what it is about.

### What a scene needs

`frontend/src/utils/sceneNeeds.ts`, read from a version's scenes.json when it
is published and kept on the version (`needs`, migration 0084; the row holds
the latest's): `fast` (it redraws more than once a second: a
`refreshInterval` under 1 s; never a layout), `touch` (taps or a mouse, one
thing to the runtime: JSX handlers, pointer events), `keys` (a keyboard: key
events, text input), `buttons` (the frame's own GPIO buttons), `linux`
(Chromium, FFmpeg, a shell command), `video` (it plays video or reads its
frames, `frameos.video` / `videoFrame` / `videoInfo`: a Pi, cloud-managed or
not, never an ESP32; docs/video.md), and `round`, which is no need but a
fit: the scene works on a round screen too (code that asks `context.round`
or `app.frame.round`, or `settings.round`, which wins either way;
docs/scene-guide.md "Round panels"). The store front shows them on each tile
("Fast screen", "Touch & mouse", "Keyboard", "Buttons", "Pi only", "Video", "Round
screen") and filters by them (Any screen, Fits e-paper, Made for fast
screens, Touch & mouse, Keyboard, Round screens). A frame's own store leaves
out what it cannot run (`without=fast` on a slow panel, `linux,video` on an ESP32)
and puts what fits first: `prefer=fast` on a fast panel, `round` on a round
one (`prefer=round,fast`, the first weighing most). Round rules nothing out. Touch and keys rule nothing out: the frame's buttons and
its pages reach any scene. Versions from before the column are read by
`pnpm --filter @frameos-cloud/auth-web scene:backfill-needs`.

### Changes go to the plane

A frame with a control plane never installs on its own: the plane holds the
scene list, and a scene the device added by itself would be gone at its next
push or deploy. The host asks the plane with the frame's own credential, and
the push that follows is how the scene arrives:

`POST /api/frames/{id}/panel/scenes` `{"action", "scene_id", "show"?}`, with the
cloud's enrollment token or the backend's `server_api_key` (a backend first, as
for the voice chat). A Pi does not know its id on the backend and posts to
`/api/panel/scenes` there; the key says which frame it is. A plane that
answers 404 with no `error` of its own is older than this route: both hosts
report `plane_update_required`, and the app says the plane needs a newer
version (it said the store did not answer, which sent people to the wrong
place). A plane that does not answer at all (asleep, unreachable, an error
with no word of its own) is `plane_unavailable`, "The control plane did not
answer", never `store_unavailable`: that word is the plane's, for a store it
could not reach itself. Saying the store did not answer sent a Sticky's owner
to the store while the laptop running its backend slept (2026-11-23). The
ESP32 tries a request that never reached the plane three times, 3 s apart
(a frame in a hand drops its Wi-Fi for seconds), never one the plane may have
taken, and logs each refusal as `sceneStore:error`. A store id the app hands
over goes into a URL path on the ESP32, so it must be a UUID or nothing.

| Action | `scene_id` | What the plane does |
|---|---|---|
| `install` | store scene uuid | adds it to the list (newest version) and pushes; shows it unless `show: false` (the store installs with `show: false` and stays on the panel). One already there is shown, or nothing at all with `show: false` (`up_to_date`). One that takes the place of a scene the frame holds under the same id is `needs_owner` when it asks for more than that scene (below). A layout shown is put around every scene the frame holds and the frame stays where it is (below) |
| `preview` | store scene uuid | pushes it beside the list as a preview (source `panel`, `docs/scene-previews.md`), shown now unless `show: false` (a layout tried): Install or Discard ends it |
| `update` | the installed scene's `origin.storeSceneId` | moves it to the newest version (`up_to_date` when it is); `needs_owner` when that version asks for more (below) |
| `updates` | none | reads, changes nothing: `{"ok": true, "updates": [{store, name, from, to, owner?}]}`, each public store scene the frame holds with a newer version it can run, in the frame's order |
| `updateAll` | none | moves every one of `updates` without `owner` in ONE push (`{"status", "updated", "kept"}`: `kept` the ones left to the owner) |
| `remove` | the same | takes it off the list and pushes the rest |
| `discard` | the runtime id to go back to | ends the preview and pushes the list, showing that scene (the store) |

The cloud's install, update and remove are the workspace's own
(`assignScenesToFrame`, `updateAssignedScenesToLatest`); the backend's save
`frame.scenes` and send them as "Install & activate" does on every kind of
frame (`api_frame_set_next_scene`: the ESP32's queue, a Pi's deploy). An
update keeps the frame's copy's id, name, field values, button map and
layout, as the workspace's Update does.

What a frame may ask is narrower than what its owner may:

- **Public store scenes only.** A frame's token could name one of the
  owner's private scenes, which the store never lists; the plane refuses it.
- **No service key is granted.** A scene installed from the frame is a new
  assignment with nothing granted (the cloud) or a store scene the owner's
  frame settings grant what they grant (the backend). What a device asks must
  never widen a grant (`docs/cloud-frames.md`, "Scenes the frame already
  had"); the answer's `needs_settings_groups` says what it asks for, and the
  owner allows it where grants are made.
- **An update asks for nothing more.** A version whose apps ask for a
  permission or a settings key the version the frame holds did not (the code
  editor's rule: backend `panel_code.grants_widened_by`, cloud
  `panel-code-grants.ts`) is refused (`needs_owner`, with `needs`), listed with
  `owner: true` and left out of `updateAll`: the owner updates it in the
  workspace, where access is granted.
- **So does an install that takes a scene's place.** The store version's
  scenes may have the ids of scenes the frame holds that did not come from it
  (an older copy from elsewhere: a sample from before the store stamped its
  origin, a scene imported from the device, another store scene's). The frame
  then runs the store's version under that id, so those scenes may ask for
  nothing more than the copies they take the place of (`needs_owner`, with
  `needs`, 403: the same check as an update's). A backend compares with the
  copies in its saved list and replaces them there, keeping their names,
  values, maps and layouts; the cloud compares with the scenes the frame was
  last sent (`buildScenesPayloadForFrame`). A scene of an id the frame does
  not hold installs with what it declares, as the store's red tags say.
- **Nothing while the settings on the frame's screen are off** (`panel_locked`).
- **A frame keeps one scene** (`last_scene`).
- Sixty changes a quarter of an hour per frame, and 120 `updates` reads in a
  bucket of their own, so reading never costs a tap.

A refusal is `{"ok": false, "error": <code>}`, and the app says it in words
(`WORDS` in its `app.tsx`).

### A frame with no plane does it itself

- **ESP32:** the store's `scenes.json` is fetched and split into its scenes by
  a scanner that never builds the array's tree (`fos_store_scan.c`), and each
  scene goes into the scene store as its own file (`fos_scenes_put`). A
  preview is an install the host remembers as one; Discard deletes it and goes
  back to the store.
- **Pi:** the scenes go into the frame's own scenes, as a save on its admin
  page does (`persistScenesPayload`), and the runtime reloads. A backend's Pi
  previews this way too: a backend keeps no preview of a Pi.

### What came from the store

Every scene the store serves carries `origin {href, storeSceneId, version,
sceneId}` (`scene-origin.ts`), and the frame keeps it. A store scene a
backend's workspace installed carries the workspace's longer stamp instead
(`sceneOriginForTemplate`: `repositoryId`, `repositoryUrl`, `templateId` and
`templateName` too), and a backend serves the keys sorted, so no reader may
count on their order. The host reads it off each scene: the ESP32 from each
scene's file without parsing the scene (`fos_store_read_origin`: the scene's
own `origin` object, then its keys inside it), cached by the content hash the
index already has; the Pi from its scenes on disk. That is what "on frame" and
Update are measured against.

### What has updates

Which of them the store has a newer version of is the plane's to say: it
knows which version it sent (the cloud's `assigned_scene_state`, a backend's
`origin.version` on `frame.scenes`), which the frame may run (the cloud leaves
out a version that needs a newer FrameOS or runs shell commands, a backend
what the store's listing for frames does not offer) and which asks for more.
The host asks `updates` when a read of its facts finds the answer five
minutes old (or another plane's), after a change it asked for, and on an
ESP32 with the re-read after a push changed its scenes, and keeps the answer
as it came (`updates` in the facts; the ESP32 asks it once, never three
times, and never pulls commands after it). The Pi re-reads what came from the
store when another scene reads the facts, at most every half a minute: on a
desktop two readers may show at once. An old plane refuses
the action, and the facts have no `updates`. A frame with no plane has none:
the app lists nothing.

The frame page (`docs/scene-settings.md` "The frame page") reads the same
facts: a "Scenes" line with their count and **Update scenes**, which asks the
host for `updateAll`. While it shows, the host's news draws it again (the
ESP32's `fos_scenes_settings_shown`).

`updateAll` is one push however many scenes move: the cloud's
`updateAssignedScenesToLatest` with every scene it may take (the workspace's
"Update all scenes"), a backend's saved list changed once and sent once. Each
scene keeps its install's id, name, field values, button map and layout, as
`update` does; the deploy progress moves as for any push, and an ESP32 gets
the set the way it gets every set (a patch, in parts, or whole).

### Trying a layout

A layout (the Layouts shelves) is tried, not previewed: **Try** is a `preview`
with `show: false`, so the frame takes it beside its scenes and stays on the
store. Once the store sees the preview in its facts it asks for `layout {id}`,
which no host does: `app_runtime.nim` chooses it as the frame's layout
(`layout_choice.nim`, the frame page's own choice) and shows the store again,
so every scene wears it at once, the store included, and a desktop opens its
windows. `frameos.store()` says which layout is chosen (`layout`: "" for each
scene's own). **Keep** installs it shown (`install`, `show: true`): the plane
writes it onto every scene the frame holds (the cloud's `layouts` column, a
backend's `layout` on each `frame.scenes` entry, the way the frame's Settings
choose one for every scene) and the store sets the frame's own choice back to
each scene's. **Discard** drops the preview and puts back the choice the frame
had before the try. A layout already on the frame has **Use**, the frame's own
choice alone. In the browser preview, Try works the same way and nothing is
kept.

## The Scene store app

- **Tiles at one size.** A scene is its picture over its name: the cover's
  `thumb` at 4:3 (120x90 at zoom 1), decoded at the size it is drawn, on its
  category's color until it is in, with the scene's icon as a badge at its
  corner; a scene with no cover shows its icon there instead (else its first
  letter). A mark at the corner says what the frame holds: a check, an arrow
  for an update, a play sign for the preview. E-paper and other slow panels
  get icon tiles instead (the icon on a square over the name, as a desktop
  shows an app): every picture there is a download inside the render before
  its one refresh, and a 120 px photo dithers to mush. The grid is laid out
  from the room the app has, so a bigger window shows more tiles, never
  bigger ones (until 2026-11-20 everything was zoomed by the window's shorter
  side, and a window dragged bigger drew nine bigger cards a page). How big a
  tile is follows the panel instead, by the square root of its shorter side
  over 480 in quarters: 0.75 below about 370 px, 1.25 from about 600, 1.5 from
  about 900 (a 1080p screen across a room), and at most 1 in a window of a
  desktop (a box smaller than the panel), the desktop's own size.
- **What the pictures cost.** Only tiles near the screen are built, so only
  they ask for their picture; each is kept by the runtime at its drawn size
  (`docs/jsx-ui.md` "Photos that stay": 48 small pictures at most, the oldest
  let go first, fewer when render memory is short). At zoom 1 a picture is
  120x90, 21 KB in an ESP32 LCD's RGB565, so the store holds about a megabyte
  of them at the very most, and an 800x480 screen shows about eighteen.
- **Scenes | Layouts, by category.** The two sides are tabs in the header.
  A wide window (600 layout pixels and more) lists the side's categories down
  its left, always on the screen (Scenes starts with Featured, open at
  first), beside the category picked, its name over its grid; a scene's page
  opens in the same place, with Back at its top, and the header keeps the tabs
  and the search. A narrow one lists the categories as its front, and a
  category opens in a step of its own. A category, Featured or a search is
  one grid that scrolls. Until 2026-11-22 a wide front was a section per
  category, its first row or two and an All to open the rest, which nobody
  saw: the owner asked for every category on the screen at once.
- **Covers** are nearly square in the corners (4 px; an icon tile keeps an
  app's rounder corners).
- **Back** goes up one step and says where to: a scene's page to its category
  (or the search, or the store), and on a narrow window a category to the
  store's front.
- **It scrolls, and builds only what shows.** A box that scrolls
  (`docs/jsx-ui.md` "Scrolling and clipping") holds the rows,
  `onScroll` keeps where it is, and only the rows within a third
  of a screen of what shows are built; spacers stand for the
  rest. A category's pages are 24 scenes (the most the store gives, the same
  at any window size, so a resize asks for nothing again) and are fetched,
  together, down to a screen and a quarter below what shows, with a row of
  placeholders while they come. E-paper
  never scrolls a grid: a page is a screenful (`limit` the grid), turned by
  the arrows or a swipe, one refresh each. This needs `scrollTop` and
  `onScroll`, 2026.11.12 (the template's `frameosVersion`).
- **Where it is** is the private `spot` field (`persist: disk`): the side
  (`tab`), the category or search open (`cat`, `q`), the scene open
  (`detail`), how far the front, the list and the side panel were scrolled (`scroll`, written
  at each step, not each scroll), e-paper's page, what it last asked, and the
  shelves. It is written when it changes, so the scene that opens after a
  preview, a reboot or a deep sleep draws the same spot before any answer
  comes back. A spot from before (a `shelf`) opens that category.
- **Snappy.** A tap answers in the next render: a page is `fetch`ed off the
  render and fills in when the answer comes. Pages already seen are kept with
  `frameos.remember`, one value a page (32, 8 on an ESP32; fresh for five
  minutes, a first page then asked again in the background), and the
  thumbnails are `<img src>`s (`docs/async-js.md`): they download off the
  render (a Pi's request workers, an ESP32's request task) and the grid is
  drawn again as they land, so a tap is never stuck behind a download. Each
  is kept at its icon's size (`docs/jsx-ui.md` "Photos that stay"), and only
  tiles near the screen ask for theirs. A board that sleeps between renders,
  e-paper and the browser preview fetch them in the render (the preview one
  picture a render).
- **The desktop's look.** Its header, tabs, buttons, search field and tiles
  name their role (`look="bar"`, `"selected"`, `"button"`, `"primary"`,
  `"field"`, `"option"`, `"page"`), so in a desktop's window it wears that
  desktop's theme, and its own dark (or high contrast) look with none.
- **What this frame is** decides what it is offered: a panel that animates gets
  the scenes made for a fast screen first under Featured (`prefer=fast`);
  e-paper is not offered them at all (`without=fast`), an ESP32 nothing that
  needs Linux (`without=linux`). Featured is scenes (`exclude=desktops,layouts,devices`):
  the layouts are the other side. E-paper
  fetches its own pages (`httpRequest` in the render, so one answer is one
  refresh) and takes a page's covers before its one refresh. A grey or black
  and white panel (`app.frame.color === false`) gets the high-contrast look,
  as e-paper does. A layout has Try instead of Preview (above).
- **Updates first.** Where the plane lists updates, an Updates entry with
  their count tops the categories (the side panel of a wide window, the front
  of a narrow one) on both sides. It opens a list: each scene's name and
  "Version 2 to 4" with Update, Update all where more than one may be taken
  here, and in place of Update the words for one only the owner may take. A
  scene's page offers no Update for that one either. With no plane (or in the
  browser preview) there is no entry, and a spot left on it opens the
  categories.
- **Keys alone** (a frame with buttons and no glass) cannot drive it yet: the
  JSX layer has no focus for keys (`docs/ui-todo.md`).

## The Files app

- Its id stays `asset-browser`, the name it shipped with: the desktops find it
  by that id, or by its name where a control plane gave a copy another id.
- `frameos.listAssets(dir, { shallow: true })` lists one folder (folders end in
  `/`), so a large SD card is walked a folder at a time; a runtime before
  2026.11.8 lists every file below and the app reads the folders off the paths.
- **A storage that cannot be read is not an empty folder.** The app lists with
  `strict: true`, which answers null when the storage's root is not there or a
  read fails (2026.11.15+; a runtime before says `[]`). It then says "The TF
  card cannot be read right now." with Try again, keeps the spot (folder, page,
  picture open), never keeps that answer, and lists again every 5 s, six
  times (counted in the spot, on disk, so a frame that deep-sleeps between
  tries stops too). A listing is kept 30 s otherwise, and not when the clock went back
  (a frame sets it once online). **Reload** in the header, and opening a place
  from the top, drop what was read (the listing, sizes, thumbnails) and list
  the folder again.
- **A file that is no picture opens in the scene that reads it.** A scene
  names the kinds of file it opens (`settings.opens`, its extensions as text:
  the PDF viewer `"pdf"`, the ePub reader `"epub"`, the Code editor
  `"txt md json csv ..."`; docs/scene-guide.md), every host lists that as
  `opens` on `app.frame.scenes` (`listingItem`; an ESP32 keeps it in its scene
  index, `make_entry`'s `keep_text`), and a tap on such a file is
  `setCurrentScene {sceneId, state: {file: "<storage>:<path>"}}`: the scene's
  public field `file`, which it reads once and sets back to `""`. The first
  scene in the frame's order that opens the kind wins. With none, a card over
  the page says "Can't open .mp3 files" and a tap puts it away; in the
  browser preview such a file is downloaded instead, as before.
- **Thumbnails or a list**, two buttons in its header. Thumbnails are
  `frameos.loadAssetImage(path, { keep: true, width, height })`: decoded at the
  tile's size (a JPEG scaled as it decodes, `readImageIntoTarget`), one a pass
  after the page shows, all at once on e-paper. A kept picture never sets the
  frame's dither palette (a photo's sidecar palette): the render shows others.
  The list decodes nothing: a row is an icon, the name, and the kind and size.
  On an ESP32 a row says the kind alone, as the files may be on the flash,
  where each size is a lookup by name that takes a good part of a second.
  Both are a page a screen; a change of view keeps the first entry showing.
- **New folder** opens a card with a name field (the keyboard on the screen,
  `docs/jsx-ui.md` "Fields and the keyboard"), Cancel and Create (or Enter).
  The app says what is wrong with a name (empty, a slash, a dot first, there
  already) and `frameos.makeAssetFolder(path)` makes it in the folder showing.
  That is the runtime's own asset call (`js_runtime/app_runtime.nim`, op
  `mkdir`), so one implementation serves every host through its file system:
  a Pi's disk, an ESP32's SD card or its flash folders (`fos_assets_flash.c`
  keeps a hidden `.k` marker in an empty one), the browser's IndexedDB
  folder. It makes one folder whose parent is there (an ESP32 cannot make the
  folders above its assets mount), and refuses a name the listing would hide
  (a dot first, `@eaDir`, `Thumbs.db`, ...), as the device's own write paths
  refuse dot names. The button shows where the runtime has the call
  (2026.11.10+). The name being typed is kept with `frameos.remember`.
- **The desktop's look.** Each element names its role in the theme
  (`look="page"`, `"bar"`, `"button"`, `"selected"`, `"primary"`, `"field"`,
  `"option"`, `"tile"`, `"card"`, `"muted"`, `"accent"`), so on Windows 98, macOS, BeOS
  and the other desktops it is drawn in their theme, and in its own dark (or
  high contrast) look with none; folders take the theme's accent color through
  `app.frame.theme` (`docs/jsx-ui.md` "Themes").
- The picture open is decoded at the screen's size with `fit: "contain"`; a
  swipe goes to the next or the one before, down closes it, a tap hides the
  bars, and the play button turns the folder into a slideshow (ten seconds a
  picture, `setNextSleep`).
- The spot (folder, page, picture open, playing, the view) is a private disk
  field, as the store's is. A folder that went away goes back to the top.
- It asks for `"permissions": ["assets", "assets-write"]`: making a folder is
  a write, so it shows as "reads & writes files" (until 2026-11-16 it read
  only).
- **Upload and Download, in the browser preview** (2026.11.14): where the frame
  is shown on a computer, Upload (the header's last button) puts files from
  that computer into the folder showing, and Download (the picture's bar, or
  a tap on a file that is no picture) saves one there. Both are
  `frameos.transfer(op, args)` (`frameos/file_transfer_hooks.nim`, bridged in
  `js_runtime/app_runtime.nim`, which resolves the path against the app's own
  asset sandbox first): `read` is the host's facts and null with no host, so a
  Pi, an ESP32 (whose image has no bridge at all) and a plane rendering a
  board show neither button. The one host is the preview's
  (`frameos/file_transfer_preview.nim`, turned on by the worker for a page
  that says it answers, `fileTransfer` in its `init`).
- **The gesture.** A file picker opens, and a download starts, only from a
  person's press on the preview itself, and the tap on Upload is a pointer
  event the page forwarded to the worker (`previewHasGesture`, five seconds
  from a pointer or a key on the picture). `frameos.transfer` is any scene's
  to call and a store scene's preview runs on its public page, so a click
  somewhere else on the page is not the scene's permission to save a file
  to the computer. The runtime hands the request to the worker
  (`onFrameosFileRequest`), the worker to the page (`fileRequest`), a round
  trip of a few milliseconds; the page still has the tap's transient
  activation then (`navigator.userActivation.isActive`: about five seconds in
  Chrome and Firefox), and opens the picker or saves the file at once
  (`frameos/wasm/src/files.ts`). With no press behind the request, or when
  the page has no gesture left (a long render in between, a browser that
  cannot say), the page asks with a button of its own (`onFileRequest`: the
  editor's preview and the playground show "Choose files" / "Save" and
  Cancel), whose click is the gesture; a page with no such button turns a
  request nobody pressed for down. A file is saved under its name as the
  page cleaned it (`safeFileName`: no folders, no control or
  direction-changing characters, no dot first). The files picked go
  back to the worker (`fileUpload`), which writes them into the folder the
  runtime named, never one the page names: no folders or dot first in a
  name, and a name that is there gets " (2)". They are in the preview's
  folder, IndexedDB through emscripten's IDBFS, so they stay across reloads
  and every scene in that browser sees them, within its 128 MB. The scene that
  asked is drawn again (`frameos_wasm_file_transfer_done`, a `render`) and
  lists the folder again on the facts' `seq`.
