# The scene store on the frame

*Written 2026-11-11.*

The scene switcher's last tile is **Scene store**: the FrameOS Cloud store,
browsed on the frame's own screen. Search it, pick a shelf, page through it,
and Preview or Install a scene; a scene the frame already has offers Show,
or Update when the store has a newer version. A long press on any tile in the
switcher opens that scene's page: where it came from, and Show, Update and
Delete (Install and Discard for a preview).

| Piece | Where |
|---|---|
| The pages and their words | `frameos/src/system/sceneSwitcher/store.nim`, drawn by the switcher (`scene.nim`) |
| The facts and the work, ESP32 | `embedded/esp32/main/fos_store.c`, through `frameos/src/embedded/embedded_runtime.nim` |
| The facts and the work, Pi | `frameos/src/frameos/scene_store_linux.nim` |
| The store's short listing | `GET /api/store/device/scenes`, `GET /api/store/device/scenes/{id}` (`cloud/apps/auth-web/src/lib/store-device.ts`) |
| What a frame asks its plane | `POST /api/frames/{id}/panel/scenes`: cloud `src/lib/panel-scenes.ts`, backend `app/api/panel_scenes.py` (also `/api/panel/scenes`) |

## Who does what

The pages have the words; the host has the facts and does the work, as the
frame page of the settings does (`docs/scene-settings.md`). The scene reads
`sceneStoreRead()` on every render (nil: no store, and no tile) and sends
`sceneStoreAction(action, args)`; the host does the work off the render task
(the ESP32 on a task it makes for the work, the Pi on a worker thread) and
asks for a render when what it knows changed, while the switcher shows.

The host offers the store while the settings on the frame's screen are on
(`frame_settings_on_screen`, or the device's own unlock): the store page is
one of them. The wasm preview has no host, so no tile.

### Browsing goes to the store

The frame asks its cloud provider (the one it is enrolled with or linked to,
else `https://cloud.frameos.net`) for the store directly, with no credential:

- `GET /api/store/device/scenes?q=&category=&page=&version=&categories=1`:
  twelve scenes a page as `{id, name, category, version, by}` (about 1.5 KB),
  `more` when there is another page, and the shelves with `categories=1`. The
  same filters and order as the store front, and only what a frame is
  offered: public, active, on a shelf, not shell-risk, and (with `version`,
  the frame's FrameOS) runnable on it. No descriptions, tags, images or
  counts: an ESP32 parses this beside the scene it runs.
- `GET /api/store/device/scenes/{id}`: one of those scenes with a short
  description (280 characters) and its newest version: what a scene's page
  compares the installed copy's `origin.version` with.

Both are public and cached for a minute, limited per address like any
visitor (600 a quarter of an hour, the `store:device` bucket).

### Changes go to the plane

A frame with a control plane never installs on its own: the plane holds the
scene list, and a scene the device added by itself would be gone at its next
push or deploy. The frame asks the plane with its own credential, and the
push that follows is how the scene arrives:

`POST /api/frames/{id}/panel/scenes` `{"action", "scene_id"}`, with the
cloud's enrollment token or the backend's `server_api_key` (a backend first,
as for the voice chat). A Pi does not know its id on the backend and posts
to `/api/panel/scenes` there; the key says which frame it is.

| Action | `scene_id` | What the plane does |
|---|---|---|
| `install` | store scene uuid | adds it to the list (newest version), pushes, shows it; one already there is shown |
| `preview` | store scene uuid | pushes it beside the list, shown now, as a preview (source `panel`, `docs/scene-previews.md`): Install or Discard ends it |
| `update` | the installed scene's `origin.storeSceneId` | moves it to the newest version (`up_to_date` when it is) |
| `remove` | the same | takes it off the list and pushes the rest |
| `discard` | the runtime id to go back to | ends the preview and pushes the list, showing that scene |

The cloud's install, update and remove are the workspace's own
(`assignScenesToFrame`, `updateAssignedScenesToLatest`); the backend's save
`frame.scenes` and send them as "Install & activate" does on every kind of
frame (`api_frame_set_next_scene`: the ESP32's queue, a Pi's deploy). An
update keeps the frame's copy's id, name, field values, button map and
layout, as the workspace's Update does.

What a frame may ask is narrower than what its owner may:

- **Public store scenes only.** A frame's token could name one of the
  owner's private scenes, which its screen never lists; the plane refuses it.
- **No service key is granted.** A scene installed from the screen is a new
  assignment with nothing granted (the cloud) or a store scene the owner's
  frame settings grant what they grant (the backend). What a device asks must
  never widen a grant (`docs/cloud-frames.md`, "Scenes the frame already
  had"); the answer's `needs_settings_groups` says what it asks for, and the
  owner allows it where grants are made.
- **Nothing while the settings on the screen are off** (`panel_locked`).
- **A frame keeps one scene** (`last_scene`), as the ESP32's store does.
- Sixty changes a quarter of an hour per frame.

A refusal is `{"ok": false, "error": <code>}`, and the page says it in
words (`store.nim` `Errors`).

### A frame with no plane does it itself

- **ESP32:** the store's `scenes.json` is fetched (twice a slot at most) and
  split into its scenes by a scanner that never builds the array's tree (a
  cJSON tree of a 100 KB payload is hundreds of small allocations, which land
  in internal RAM), and each scene goes into the scene store as its own file
  (`fos_scenes_put`, unpaced when it is shown). A preview is an install the
  host remembers as one; Discard deletes it and goes back.
- **Pi:** the scenes go into the frame's own scenes, as a save on its admin
  page does (`persistScenesPayload`), and the runtime reloads. A backend's Pi
  previews this way too: a backend keeps no preview of a Pi.

On such a frame Delete is offered for any scene (`removeAny`), not only the
store's: nobody else holds them.

### What came from the store

Every scene the store serves carries `origin {href, storeSceneId, version,
sceneId}` (`scene-origin.ts`), and the frame keeps it. The host reads it off
each scene: the ESP32 from each scene's file, found by its keys without
parsing the scene, cached by the content hash the index already has (a
scene not changed since is not opened again); the Pi from its scenes on
disk. That is what "installed" and Update are measured against.

## The pages

- **The tile.** Last in the switcher, after every scene, on every page count
  (`switcherGrid` counts it). The keys reach it like any tile.
- **The store's page.** Back, the title and the store's pages (Previous,
  More); a search field (on-change keeps the text, Enter or Search sends it)
  and the shelves as a select; a line for what is running, what went wrong
  or what just worked; then the scenes, one row each, that scroll. A row the
  frame lacks has Preview and Install; one it holds has Show, and Update when
  the store's version is newer. Opened over a scene it previews, the
  switcher opens on this page, where Install is.
- **A scene's page.** A long press on its tile, or OK pressed twice (held,
  where no rule of the frame's claims it). Where it came from and its
  version, the store's description and shelf when it answers, and Show,
  Update, Delete (twice), or Install and Discard (twice) for a preview.
- **The keys** walk the buttons of either page in order (next / prev),
  press the lit one (OK, REFRESH, HOME) and go back (back). E-paper draws
  the lit button inverted; an LCD rings it.
- **Busy:** one thing at a time. A tap while something runs is not taken;
  the page says what runs. On e-paper the page is drawn when the work is
  done, not when it starts: a refresh to say "Loading" costs seconds.

## Flash and memory

The generic ESP32-S3 image is **27,040 bytes** bigger with it than without
(3,230,800 → 3,257,840 B, 90.4% of the 3520K app slot; measured 2026-11-11
against #702's head, both built in the CI image at the same path):

| Part | Bytes |
|---|---|
| The two pages (`store.nim`: the trees, the rows, the handler) | 12.2 K |
| The switcher's side (the tile, a long press, the pages' keys, `pageTree`) | 3.7 K |
| `fos_store.c` + `fos_store_scan.c` | 5.1 K |
| Their strings and type info | 6.0 K |

The first build was 30.9 K. What took it down and keeps it there:

- One shape of arguments for every action (`storeAct`), one finder for the
  scenes from the store (`found`), the store's tile drawn by the scene tile's
  own code, a scene's page naming the scene (the host finds its store scene).
- No JSON tree in C for anything the store answers: its answers are handed
  to the page as they came, checked once by parsing, and the scenes of a
  standalone install are split by a scanner. What came from the store is
  read off each file by its keys.
- No new layout code, no Nim checks in `store.nim`, numbered handlers, one
  way out of a proc (an early `return` repeats every clean-up), and the
  same button, field and select shapes as the settings' page.

Internal RAM: 9 bytes of statics. The host's state (about 7 KB: the store's
answers, the scenes from the store, the work asked for) is one PSRAM block,
made when the switcher first asks, so a board that never draws the switcher
(the C3's thin client) spends nothing. The task that does the work has an
8 KB stack while it runs and is gone after.
