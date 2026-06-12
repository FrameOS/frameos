# On-device admin interface

Every frame serves its own admin interface at `http://<frame>:8787/admin` (enable it and set
credentials under frame settings → "Frame admin panel"). It is the same React app as the backend's
frame workspace, embedded into the `frameos` binary, but running in **frame control mode**: it talks
only to the frame's own HTTP API and manages exactly one frame — itself.

## What's different on the device

- The frame overview **is** the homepage. The navigation rail shows three entries — Frame, Scenes
  and Apps. There is no "frames home" and no backend settings; those need the backend.
- The **Scenes workspace** (`/admin/scenes/...`) is the full diagram editor. Scenes can be created,
  edited, renamed, duplicated, deleted and saved on the device; saved interpreted scenes go live on
  the display immediately (save **is** deploy on the device — see below).
- The **Apps workspace** (`/admin/apps/...`) browses the system app catalog (embedded in the
  binary, including app sources) and edits the custom apps inside the frame's scenes.
- Frame tools available on the device: Scenes (overview + activating scenes), Settings, Preview,
  Schedule, Logs, Metrics, Assets, Ping and Debug. The Terminal is backend-only.
- The frame actions menu keeps what the frame can do to itself: rename, re-render, restart FrameOS
  (the process exits and systemd restarts it) and reboot the device. Deploys, agent management,
  archive and delete stay in the backend.
- Backend-only features hidden on the device: AI chat, templates ("My scenes", .zip export),
  repositories, the generated Nim scene source panel, "start on boot" (only honored for compiled
  scenes), terminal, SSH/agent/HTTPS/mountpoints settings.

Technical notes:

- The slim wrapper app lives in `frameos/frontend/`; it sets
  `window.FRAMEOS_APP_CONFIG = { frameMode: 'frame', frameId: 1 }` and reuses components from the
  main `frontend/` app. `isFrameControlMode()` (`frontend/src/utils/frameControlMode.ts`) is the
  switch all shared components use.
- In frame control mode, API paths are never project-scoped (`/api/projects/{id}/...` only exists on
  the backend — this missing bypass was what blank-screened `/admin` after the multi-project change).
  `urls.frames()`/`urls.frame()` collapse onto `/admin` (`/admin?tool=settings` etc.), while the
  editors keep the backend's path shape under it: `/admin/scenes/1/<sceneId>`,
  `/admin/apps/system/<keyword>`. The Nim server serves the SPA for every `/admin/**` path.

## Saving settings on the device

Saving in the on-device admin POSTs the form to the frame's own `POST /api/frames/1` endpoint
(admin session required). The frame then:

1. validates and maps the whitelisted fields onto the camelCase keys of its `frame.json`
   (`frameos/src/frameos/server/config_update.nim`),
2. **backs up the current `frame.json` to `frame.json.bak.<UTC timestamp>` in the same release
   folder** (`/srv/frameos/releases/release_*/` via the `current` symlink; the 10 newest backups are
   kept),
3. writes the new `frame.json` atomically (a config that fails to parse is rejected and the old file
   stays), stamps `configUpdatedAt`, mirrors the file to the agent's copy at
   `/srv/frameos/agent/current/frame.json`, and
4. asks the runner to reload. Changing the admin credentials invalidates all admin sessions.

Only runtime-editable fields are accepted: name, access keys/levels, admin auth, dimensions,
rotation/flip/scaling, intervals, debug, log/assets paths, timezone (+ updater), schedule, GPIO
buttons, QR control code, palette, network, error behavior, backend connection and agent settings.
Anything that requires a rebuild or redeploy (deployment mode, display driver, SSH, HTTPS
proxy certs, mountpoints, reboot crontabs) is ignored by the endpoint and hidden or disabled in the
on-device settings page. On Buildroot frames `/srv/frameos` is on the read-write overlay, so saves
work the same way there.

## Editing scenes on the device

The same `POST /api/frames/1` save accepts a `scenes` array. Scenes don't live in `frame.json`;
they live next to the binary in the release folder
(`frameos/src/frameos/server/config_update.nim`):

- `all_scenes.json.gz` — the full scene payload, exactly what the editor sees through
  `GET /api/frames/1` and what the backend's drift check compares against.
- `scenes.json.gz` — only scenes with `settings.execution == "interpreted"`; this is what the
  runner loads and executes (same filter as `setupExportScenes` during deploys).

A scene save backs both files up (`.bak.<UTC timestamp>`, 10 kept, same scheme as `frame.json`),
writes them atomically, and sends the runner a `reload` event: interpreted scenes are re-built from
disk and hot-swapped, so **saving on the device is deploying** — there is no separate deploy step,
and the workspace only ever shows "Unsaved"/"Saved".

Compiled scenes are baked into the binary and cannot be rebuilt on the device. Their edits persist
to `all_scenes.json.gz` (and can be pulled into the backend), but only take effect after switching
the scene's execution to "interpreted" in scene settings — the editor shows a banner explaining
this. Interpreted scenes loaded from disk override a compiled scene with the same ID
(`buildExportedScenesTable` in `frameos/src/frameos/scenes.nim`), which is what makes that
escape hatch work; backend deploys never write a compiled scene into `scenes.json`, so the
override only triggers for on-device edits.

Custom apps inside scenes: JS/TS app sources run on the device's interpreter and work after a
save. Custom **Nim** app sources need the backend's compiler — they can be edited and saved on the
device, but only run after a backend deploy of a compiled scene. The device's
`POST /api/apps/validate_source` only validates JSON files; Nim/JS linting needs the backend.

The settings page shows/hides sections accordingly (`inFrameAdminMode` in
`frontend/src/scenes/frame/panels/FrameSettings/FrameSettings.tsx`), and the section index in the
sidebar follows (`backendOnly` flags in `frontend/src/scenes/workspace/FrameWorkspace.tsx`).

## Pulling device edits into the backend

A frame that edited its own config has "drifted" from the backend's record. When you open a frame's
workspace in the backend, it checks `GET /api/frames/{id}/config_drift` (reads
`/srv/frameos/current/frame.json` and `all_scenes.json.gz` over the agent or SSH and diffs the
device-editable fields plus the scene payload). If the device has newer changes, a
**"Pull changes from frame"** button appears above Save/Deploy, and "Pull config from frame" is
always available in the frame's actions menu.

`POST /api/frames/{id}/pull_config` applies the device's values — including device-edited scenes —
to the backend record (`apply_device_frame_json` in `backend/app/models/frame.py`) and folds them
into `last_successful_deploy`, so a pull does not surface phantom "undeployed changes". Deploying
from the backend without pulling first overwrites the device's local edits — the device keeps
`.bak` files of every config and scene payload it replaced.

## Updates from the frame's admin page

On the device, settings → "Backend access" shows the connected backend plus two buttons:
**Update FrameOS from backend** and **Update agent from backend**. These call the frame's
`POST /api/frames/1/request_update`, which makes the frame call its backend's
`POST /api/frame_device/request_update` (authenticated with the frame's `serverApiKey`). The
backend then runs its normal deploy pipeline:

- binaries are built or downloaded by the backend (cross-compile, build host, or published
  precompiled releases) — the frame never fetches binaries from arbitrary URLs,
- a new release folder is created on the device and activated by symlink swap (instant rollback by
  pointing `current` back),
- the deploy is recorded in the backend like any other.

A standalone frame (no backend configured) cannot self-update; the admin page says so and offers
the adoption flow instead. Buildroot frames are handled by the same deploy pipeline (rw overlay,
temporary ro-remounts where needed).

Security model: the trigger is just a request. The device authenticates to the backend with its
`serverApiKey`; the backend deploys over the already-authenticated agent websocket (HMAC-SHA256
envelopes with the `agentSharedSecret`, which never leaves the device) or SSH. A frame can only
request a deploy of itself, and a request while a deploy is running is rejected.

## Adopting a standalone frame

To connect a frame that already runs FrameOS standalone (SD image, bootstrap script):

1. In the backend: **Add frame → Adopt existing device**. This generates an adoption code
   (`POST /api/frames/adoption_code`) — single use, valid for 15 minutes, stored in Redis.
2. On the frame: open `/admin` → Settings → "Backend access" → "Connect to a backend". Enter the
   backend host, port and the code.
3. The frame calls the backend's public `POST /api/frame_device/adopt` with the code and its own
   metadata (name, mode, device, dimensions, port, access level, FrameOS version). The backend
   validates and consumes the code, creates the frame record (frame host = the caller's IP unless
   provided), generates a fresh `serverApiKey` and `agentSharedSecret`, and returns them.
4. The frame writes the credentials into its `frame.json` (with the usual backup), enables the
   agent (`agentEnabled` + `agentRunCommands`), reloads, and restarts the `frameos_agent` service.
   The agent connects out to the backend and the frame appears in the frames list (it is announced
   over the backend websocket as soon as it is claimed).

Ports ending in 443 are treated as HTTPS for the backend connection (same convention as log
shipping).

## API surface added

Frame (Nim, `frameos/src/frameos/server/`):

| Route | Purpose |
| --- | --- |
| `POST /api/frames/:id` | Save whitelisted config fields + scenes (backup + atomic write + reload) |
| `GET /admin/**` | Serve the admin SPA for the scene/app editor sub-paths |
| `GET /api/apps/source?keyword=` | Sources of a system app (embedded in the binary at build time) |
| `POST /api/apps/validate_source` | Source validation stub (JSON only; Nim/JS pass through) |
| `POST /api/frames/:id/restart` | Exit the process; systemd restarts it |
| `POST /api/frames/:id/reboot` | `sudo reboot` |
| `POST /api/frames/:id/adopt` | Claim an adoption code on a backend, store returned credentials |
| `POST /api/frames/:id/request_update` | Ask the connected backend to deploy FrameOS or the agent |
| `GET /api/frames/:id/metrics/recent` | Recent metrics (same shape as the backend endpoint) |
| `HEAD /api/frames/:id/image` | Image probe used by the UI |
| `GET /img/logo-2/:asset` | Embedded logo assets for the admin UI |

Backend (Python, `backend/app/api/`):

| Route | Purpose |
| --- | --- |
| `POST /api/projects/{p}/frames/adoption_code` | Generate a single-use adoption code |
| `POST /api/frame_device/adopt` | Public; claimed by frames with a valid code |
| `POST /api/frame_device/request_update` | Public; authenticated with the frame's `serverApiKey` |
| `GET /api/projects/{p}/frames/{id}/config_drift` | Diff device `frame.json` against the backend record |
| `POST /api/projects/{p}/frames/{id}/pull_config` | Apply device edits to the backend record |
