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

The device holds the preview until the next scene push. On an ESP32 two
rules make that true for a push from the backend (both found on an E1002,
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
- **Push scenes** (`scenesLogic.pushSavedScenes`): the saved list again,
  which replaces the preview on the frame — the backend's deploy, the cloud's
  assigned list re-pushed as it stands (`pushCloudFrameSceneList`).

## Tests

- backend: `app/api/tests/test_embedded_commands.py` (the preview rows, the
  spent bundles, `scene_preview` and its route);
- cloud: `src/test/integration/frame-assets.integration.test.ts` (the
  `preview` metadata on the push, `scenePreviewsByFrame`,
  `scenePreviewScene`, the spent bundle after a newer push).
