# Scene previews on a frame

*The contract for a scene a frame shows **for now**, without holding it in
its saved (backend) or assigned (cloud) scene list: the editor's "Preview on
frame", and anything else that pushes an ad-hoc scene set (the voice chat's
picture, `docs/voice-chat.md`). Both control planes implement it; the shared
SPA draws it. Vocabulary: `docs/ui-vocabulary.md` ("Preview", "Install",
"Push").*

## What a preview is

A preview is a `set_scenes` push that is not an assignment or a deploy. On
the self-hosted backend it is a `set_scenes` row carrying `_preview`
(`app/utils/embedded_commands.py` `queue_embedded_scene_preview`): the
device's `/embedded/scenes` pull serves the preview's scenes in place of the
saved ones while that row is the newest scene set the frame was sent
(`frame_commands.previewed_scenes`), and the device's settings pull carries
what the previewed scenes' apps declare (`embedded_device.
embedded_settings_payload`), so a previewed Unsplash scene gets the key. On
the cloud it is the event route's `uploadScenes`: a checksummed `set_scenes`
the hub delivers over the socket, deliberately not an assignment
(`app/api/frames/[frameId]/event/[eventName]/route.ts`).

## A preview rides along

A preview outlives the pushes that follow it. A scene push without a preview
of its own — a deploy, the saved or assigned list pushed again, a new
assignment — **carries the standing preview along**: the previewed scene is
appended to what the frame receives, and the plane keeps reporting the
preview (backend `frame_commands.carried_preview`, called by
`enqueue_frame_command` before the new row supersedes the preview's; cloud
`carriedScenePreview`, called by `enqueueFrameCommand`). The device keeps the
last shown scene's id in NVS and restores it after any load while the id is
in the payload (`fos_scenes.c` `activate_from_index`, `restore_last_scene`),
so a frame that shows a preview still shows it after a deploy, after its
list is pushed, and after a reboot — a scene that took some prompting to get
is not lost to a click elsewhere in the workspace (the owner's rule,
2026-10-24).

Two things end a preview:

- a push that **holds a scene of the preview's id** — "Install" (the saved
  list holds it now), or a saved scene pushed over its own edited preview —
  replaces it, and nothing is carried;
- **Discard**: `DELETE /api/frames/{id}/scene_preview` (backend) /
  `/scene-preview` (cloud) marks the standing preview `discarded` (the row
  keeps its name for the queue view and loses the kept scene; the backend
  serves the saved list at once), and the push that follows carries nothing.

A new preview replaces the old one: there is one preview per frame, the
newest. A carried preview is served by the backend as the saved list plus the
carried scenes the list does not hold (`previewed_scenes`); the editor's own
preview bundle is served as it is.

The device holds whatever scene set it was sent last. On an ESP32 two rules
make that true for a push from the backend (both found on an E1002,
2026-10-24):

- a commands pull the backend marks `sync` fetches the pushed scenes and
  settings **before** it runs the commands, and a scene switch takes effect
  before the command after it (`fos_commands.c`): a `set_current_scene`
  queued behind the scenes push names a scene from that push;
- a backend scenes sync drops the per-scene slot index the boot split wrote
  (`fos_scenes.c`): with it in place a selection by id went through the slots
  of the previous payload, so a new scene was "not found" and a known id
  reloaded its stale slot file.

## What the planes keep

A push stores its whole scene bundle in a command row; without care a frame
previewed all day stacks hundreds of bundles. Each plane keeps **one bundle
per frame**:

- backend: a new `set_scenes` row empties `_preview.scenes` of every older
  row (`frame_commands.spend_older_scene_pushes`); only the newest row is ever
  served, the rest is history for the queue view;
- cloud: `spentCommandPayload` drops a `set_scenes` row's `scenes` the moment
  the device answers it (next to the asset bodies and LAN codes it already
  spent; the checksum the deploy record compares stays), and
  `enqueueFrameCommand` trims `preview.scene` from older rows when a newer
  scene push is queued.

What outlives the bundle is the preview's **metadata**: the shown scene's id,
its name and where it came from (`source`: `editor`, or another pusher's
name), on the backend inside `_preview`, on the cloud as `payload.preview`.
The newest preview push also keeps the shown scene's own JSON (backend: it is
in `_preview.scenes`; cloud: `preview.scene`) — the body behind "Install".

## What the workspace shows

Both planes report `scene_preview` on the frame (`GET /api/frames`,
`GET /api/frames/{id}`, the backend's `update_frame` broadcast):

```
{ "scene_id": "<runtime id or null>", "name": "…", "source": "editor", "at": "<iso>" }
```

while a preview is the newest scene push, `null` otherwise (backend
`frame_commands.scene_preview_info`, cloud `frames.ts scenePreviewsByFrame`).
The scene list (`frontend/src/scenes/workspace/SceneWorkspace.tsx`) draws a
dashed **preview** row above the saved scenes: the name, where it came from,
"active" when the device reports showing it, and two actions:

- **Install** (`scenesLogic.installPreviewScene`): fetches the previewed
  scene's JSON (`GET /api/frames/{id}/scene_preview` on the backend,
  `/scene-preview` on the cloud; 404 once nothing is previewed), adds it to
  the frame's scene list with its id kept (so the device's active scene is
  this very scene after the push), saves and pushes — on the cloud the save
  mints the private store scene (`persistAndPushCloudFrameScenes`), on the
  backend the deploy pushes the saved list;
- **Discard** (`scenesLogic.discardPreview`): the DELETE above, then the
  saved list pushed again as it stands — the backend's deploy, the cloud's
  assigned list re-pushed (`pushCloudFrameSceneList`). Behind a confirmation
  (`confirmDialog`, danger): a preview is held nowhere but on the frame and
  in the plane's newest push, so one that took some prompting to get is gone
  for good. The row never offers a plain "push the list": a push alone
  carries the preview along, so it would change nothing.

## Tests

- backend: `app/api/tests/test_embedded_commands.py` (the preview rows, the
  spent bundles, `scene_preview` and its route);
- cloud: `src/test/integration/frame-assets.integration.test.ts` (the
  `preview` metadata on the push, `scenePreviewsByFrame`,
  `scenePreviewScene`, the spent bundle after a newer push).
