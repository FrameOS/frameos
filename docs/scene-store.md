# The scene store on a frame

*Written 2026-11-14.*

The FrameOS scene store, browsed and installed from the frame itself, is a
scene: **Scene store** (`repo/scenes/samples/Scene store`, one JSX app). Install
it like any other scene, open it from the scene list, and pick a shelf or
search, page through the scenes, and Preview or Install one. A scene the frame
holds can be opened, updated or deleted there. Leave the store (a preview, the
scene list) and come back, and it opens on the same spot.

**Asset browser** (`repo/scenes/samples/Asset browser`) is its sibling for the
frame's own assets folder: folders and pictures as a grid, a picture on the
whole screen with a swipe to the next, and a slideshow.

| Piece | Where |
|---|---|
| The app (its words, its looks, where it is) | the sample's `scenes.json` (`apps.sceneStore`, an `app.tsx`) |
| What a JS app may ask: `frameos.store()`, `frameos.storeAction()` | `frameos/src/frameos/scene_store_hooks.nim`, bridged in `js_runtime/app_runtime.nim`, declared in `frontend/src/utils/appTypeDeclarations.ts` |
| The host on a Pi | `frameos/src/frameos/scene_store_linux.nim` (a worker thread) |
| The host on an ESP32 | `embedded/esp32/main/fos_store.c` (a task of its own), through `frameos/src/embedded/embedded_runtime.nim` |
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
  params, listing,       // the newest listing the host brought, and its query string
  installed: [{ id, store, v }], // every scene on the frame from the store
  preview: { store, id, name } | null,
  removeAny }            // a frame with no plane may delete any scene
```

`frameos.storeAction(action, args)` asks for work and returns at once:
`browse {params}`, `preview {store, name}`, `install {store, name, show}`,
`update {store}`, `remove {store}`, `discard`. One runs at a time (one asked
while another runs is dropped: `busy` says what runs). The host does it off
the render task and renders the scene that asked again when it is done, if
that scene still shows (the Pi checks `shownSceneId()`, the ESP32
`fos_scenes_showing`). A re-read of what came from the store that found
nothing new draws nothing: on e-paper a render is a refresh.

The host answers null (`""` from the hook) where there is no store: the owner
turned the settings on the frame's screen off (`frame_settings_on_screen`,
which also covers this), and every runtime without a host: the browser
preview, a board rendered on its control plane (`docs/server-rendering.md`),
a virtual frame. There the app browses on its own with `frameos.httpRequest`
and installs nothing ("Previews and installs happen on the frame itself").
That is one-sided on purpose for now: a plane rendering a frame could be its
host, and would answer `storeAction` itself.

### Browsing

The store this frame knows (its cloud provider, else `https://cloud.frameos.net`)
lists for frames at `GET /api/store/device/scenes`: the store front's filters
(`q`, `category`, `version`: only what runs on this FrameOS), `page`, `limit`
(the app's grid, 1 to 24), `prefer` (a shelf that goes first), `exclude`
(shelves left out, comma separated) and `categories=1` for the shelves. Each
scene is `{id, name, category, version, by, about, image, thumb}`: `about`
the description cut to 140 characters, `image` the cover's path on that host
(`/api/store/scenes/{id}/image?version=N`, a redirect to the CDN for a public
scene), `thumb` the cover as a JPEG of at most 512 px, a URL on the CDN (null
without one, and on a store with no CDN). Public, cached a minute, readable
from any page (the browser preview runs the app), limited per address.

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

The app hands the host the query string (`params`); the host takes only what a
query holds (`validStoreParams`, `valid_params`) and puts it after the
listing's path on the store it knows, so an app cannot point the host
anywhere else.

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
place). A store id the app hands over goes into a URL path on the ESP32, so it
must be a UUID or nothing.

| Action | `scene_id` | What the plane does |
|---|---|---|
| `install` | store scene uuid | adds it to the list (newest version) and pushes; shows it unless `show: false` (the store installs with `show: false` and stays on the panel). One already there is shown, or nothing at all with `show: false` (`up_to_date`) |
| `preview` | store scene uuid | pushes it beside the list, shown now, as a preview (source `panel`, `docs/scene-previews.md`): Install or Discard ends it |
| `update` | the installed scene's `origin.storeSceneId` | moves it to the newest version (`up_to_date` when it is) |
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
- **Nothing while the settings on the frame's screen are off** (`panel_locked`).
- **A frame keeps one scene** (`last_scene`).
- Sixty changes a quarter of an hour per frame.

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
sceneId}` (`scene-origin.ts`), and the frame keeps it. The host reads it off
each scene: the ESP32 from each scene's file, found by its keys without parsing
the scene, cached by the content hash the index already has; the Pi from its
scenes on disk. That is what "on frame" and Update are measured against.

## The Scene store app

- **A page a screen.** The grid is as many cards as fit (`limit`), so paging
  is exact, a swipe or the arrows turn it, e-paper never scrolls, and the spot
  is a shelf, a search and a page number. Wide screens have the shelves down
  the side and a search field; narrow ones a select and a search button.
- **Where it is** is the private `spot` field (`persist: disk`): the shelf, the
  search, the page, the scene open, what it last asked, and the shelves. Every
  render writes it, so the scene that opens after a preview, a reboot or a
  deep sleep draws the same spot before any answer comes back.
- **Snappy.** A tap answers in the next render: the host fetches off the render
  task and the page fills in when the answer comes (`pending`, then the host's
  render). Pages already seen are kept with `frameos.remember` (sixteen,
  fresh for five minutes, then asked again in the background), the next page
  is asked for while nothing else runs, and the first pass of a page draws no
  covers: one cover is decoded a pass after that (`setNextSleep(0.05)`), kept
  at its card's size (`fetchImage` `keep`, up to 48 small pictures,
  `docs/jsx-ui.md` "Photos that stay").
- **What this frame is** decides what it is offered: a panel that animates puts
  the Real time shelf first (`prefer=realtime` under Featured, the shelf right
  after Featured); e-paper is not offered it (`exclude=realtime`, no shelf),
  fetches its own pages (`httpRequest` in the render, so one answer is one
  refresh) and takes a page's covers before its one refresh. A grey or black
  and white panel (`app.frame.color === false`) gets the high-contrast look,
  as e-paper does. A layout has no Preview (it wraps other scenes), and its page
  says where to pick it.
- **Keys alone** (a frame with buttons and no glass) cannot drive it yet: the
  JSX layer has no focus for keys (`docs/ui-todo.md`).

## The Asset browser app

- `frameos.listAssets(dir, { shallow: true })` lists one folder (folders end in
  `/`), so a large SD card is walked a folder at a time; a runtime before
  2026.11.8 lists every file below and the app reads the folders off the paths.
- Thumbnails are `frameos.loadAssetImage(path, { keep: true, width, height })`:
  decoded at the tile's size (a JPEG scaled as it decodes, `readImageIntoTarget`),
  one a pass after the page shows, all at once on e-paper. A kept picture never
  sets the frame's dither palette (a photo's sidecar palette): the render shows
  others.
- The picture open is decoded at the screen's size with `fit: "contain"`; a
  swipe goes to the next or the one before, down closes it, a tap hides the
  bars, and the play button turns the folder into a slideshow (ten seconds a
  picture, `setNextSleep`).
- The spot (folder, page, picture open, playing) is a private disk field, as
  the store's is. A folder that went away goes back to the top.
- It asks for `"permissions": ["assets"]` (read only).
