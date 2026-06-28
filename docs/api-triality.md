# FrameOS API Triality

FrameOS has three API faces that need to feel like one product:

- Backend control plane: multi-frame, multi-project FastAPI service, project-scoped under `/api/projects/:project_id`.
- FrameOS Pi local admin: the Nim runtime running on a frame, serving a single-frame `/admin` UI and `/api` routes directly from the device.
- FrameOS ESP32 local/admin: the embedded HTTP server, with a smaller local API plus backend-facing embedded sync routes.

The long-term contract is not three independent APIs. It is one canonical frame-management API with adapters at the edges. Feature code in the frontend should call logical `/api/...` paths. The backend adapter project-scopes them. The Pi adapter serves them directly. The ESP32 adapter implements the subset it can support locally and uses backend embedded routes for remote render, scene, settings, and OTA work.

## Core Principles

- The canonical management contract is the frontend/backend shape: snake_case JSON, `/api/frames`, `/api/apps`, `/api/fonts`, and `/api/frames/:id/...`.
- Backend paths are project-scoped on the wire: `/api/projects/:project_id/frames/:id`. Frontend code should still call `/api/frames/:id`; `apiFetch` owns backend scoping.
- Local frame paths are unscoped on the wire: `/api/frames/:id`. In frame-control mode `apiFetch` must not probe or prepend a project.
- Runtime config can stay native. Pi stores runtime config in camelCase `frame.json`, scenes in `scenes.json(.gz)`, and exposes/saves the canonical API shape through translation helpers.
- A local frame is a single-frame API. `GET /api/frames` still returns a list, but only with the local frame.
- Legacy Pi/ESP32 routes such as `/uploadScenes`, `/reload`, `/state`, and `/image` are aliases for compatibility. New UI code should prefer `/api/frames/:id/...`.
- Backend-only operations, such as deploy, buildroot image creation, SSH key installation, and firmware generation, remain backend-only until a concrete standalone implementation exists.

## Abstractions

- `frontend/src/utils/apiFetch.ts`: API transport boundary. Backend mode resolves `/api/...` through `projectApiPath`. Frame-control mode talks directly to the local frame without project discovery.
- `frameos/src/frameos/server/api.nim`: Pi frame API adapter. `frameApiPayload` exposes a backend-shaped frame object. `persistFrameApiUpdate` maps frontend/backend snake_case updates into runtime `frame.json` and saves scenes to the active scenes file.
- `frameos/src/frameos/server/routes/frame_api_routes.nim`: Pi canonical local routes. This is the local target for the shared frontend.
- `backend/app/utils/frame_http.py`: backend-to-frame HTTP adapter. It normalizes auth, host, embedded last-boot IP, proxying, and response handling when the backend talks to frames.
- `embedded/esp32/main/fos_http.c`: ESP32 local route adapter. It implements the local subset, maps `/api/frames/:id/...` aliases to embedded handlers, and keeps old simple routes alive.
- `backend/app/api/embedded_device.py`: backend API consumed by ESP32 devices for render, scenes, settings, and OTA.

## Compatibility Table

Status legend:

- Full: implemented and intended as part of the shared contract.
- Partial: implemented with reduced data or behavior.
- Alias: compatibility route; do not build new frontend dependencies on it.
- Backend only: intentionally only on the control plane.
- Planned: target behavior is defined but not implemented yet.
- N/A: not meaningful for that interface.

| Capability | Canonical route | Backend control plane | FrameOS Pi local | FrameOS ESP32 local | Target behavior |
| --- | --- | --- | --- | --- | --- |
| Apps catalog | `GET /api/apps` | Full, project-scoped | Full, bundled repo app catalog | Partial, returns empty list today | Same response shape everywhere; ESP32 may return a filtered catalog. |
| App source helpers | `GET /api/apps/source`, `POST /api/apps/validate_source`, `POST /api/apps/enhance_source` | Full | N/A | N/A | Backend-only authoring helpers unless local code editing is added. |
| Fonts list | `GET /api/fonts` | Full, project-scoped | Full, reads local assets fonts | Planned | UI can load fonts locally on Pi. ESP32 should expose an empty or flash/SD-backed list when needed. |
| Font file | `GET /api/fonts/:font` | Full | Full, local TTF from assets | Planned | Same path; content type may vary by font. |
| Templates list | `GET /api/templates` | Full | N/A in frame-control mode | N/A | Template gallery remains backend/project data. Local UI should not require it to edit an existing standalone frame. |
| Templates CRUD/export | `/api/templates...` | Full | N/A | N/A | Backend-only until a local template store exists. |
| Frame list | `GET /api/frames` | Full, multi-frame | Full, single-frame list | Full, single-frame list | Always returns `{ frames: [...] }`. |
| Frame detail | `GET /api/frames/:id` | Full, DB-backed | Full, translated from runtime config and scene file | Partial, embedded summary | Always returns `{ frame: ... }`; fields can be absent if unsupported. |
| Frame save | `POST /api/frames/:id` | Full, DB-backed | Full for standalone config/scenes, translated into `frame.json` and `scenes.json(.gz)` | Partial, NVS-backed embedded fields and scenes | The shared editor can save to backend, Pi, or ESP32 directly. ESP32 intentionally ignores unsupported backend-only fields. |
| Frame create | `POST /api/frames/new` | Full | N/A | N/A | Backend-only for now. Local setup creates the single frame implicitly. |
| Frame import/adoption | `POST /api/frames/import` | Full import today; standalone adoption flow planned | Planned export/source payload | Planned export/source payload | Backend should import a standalone frame by reading local canonical frame detail plus scenes. |
| Frame delete/archive | `DELETE /api/frames/:id`, archive via `POST /api/frames/:id` | Full | N/A | N/A | Backend-only; local frame cannot delete itself from a project. |
| Ping | `GET /api/frames/:id/ping` | Full, probes frame/agent/backend state | Full, local pong | Full, local pong | Same shape with `ok`, `mode`, `target`, `status`, `message`. |
| Current public state | `GET /api/frames/:id/state` | Full, proxied/cached from frame | Full | Full | Same `{ sceneId, state }` shape. |
| All public states | `GET /api/frames/:id/states` | Full, proxied/cached from frame | Full | Full | Same `{ sceneId, states }` shape. |
| Uploaded scenes readback | `GET /api/frames/:id/uploaded_scenes` | Full, proxied/cached | Full | Full | Same `{ scenes: [...] }` shape. |
| Hot scene upload | `POST /api/frames/:id/upload_scenes` | Full, forwards to frame `/uploadScenes` | Full, sends local `uploadScenes` event | Full alias, stores uploaded scene payload | Canonical route is snake_case; camelCase `/uploadScenes` remains legacy. |
| Generic frame event | `POST /api/frames/:id/event/:event` | Full, forwards to frame | Full | Full | Canonical command path. Payload is event-specific JSON. |
| Generic body event | `POST /api/frames/:id/event` | N/A | Full local admin helper | N/A | Keep as Pi admin helper only; new shared UI should use `/event/:event`. |
| Render now | `POST /api/frames/:id/event/render` | Full | Full | Full | Triggers a render on the target interface. |
| Reload runtime | `POST /api/frames/:id/event/reload` or local reload alias | Full through event route | Full through event route and local save side effect | Full through event route and `/api/frames/:id/reload` | Prefer event route. Pi save also queues reload after config persistence. |
| Set current scene | `POST /api/frames/:id/event/setCurrentScene` | Full | Full | Full | Payload should include `sceneId` or `scene_id` where supported. |
| Set scene state | `POST /api/frames/:id/event/setSceneState` | Full | Full | Partial via Nim bridge when available | Keep event name stable; payload stays scene-defined. |
| Latest image | `GET /api/frames/:id/image` | Full, proxy/cache or backend image | Full, PNG | Full, BMP preview today | UI should tolerate image content type. PNG is preferred where available. |
| Scene image | `GET /api/frames/:id/scene_images/:sceneId` | Full | Full, current/last image response | Full, BMP preview alias | Same path. Backend may serve per-scene cached assets. |
| Scene source | `GET /api/frames/:id/scene_source/:scene` | Full | N/A | N/A | Backend-only build/debug helper. |
| Logs | `GET /api/frames/:id/logs` | Full, DB logs | Full, in-memory UI logs | Partial, empty list | Same `{ logs: [...] }` shape. |
| Full logs | `GET /api/frames/:id/logs/full` | Full | N/A | N/A | Backend-only for historical logs. |
| Metrics | `GET /api/frames/:id/metrics` | Full, DB metrics | Full, local UI metrics | Partial, empty list | Same `{ metrics: [...] }` shape. |
| Recent metrics | `GET /api/frames/:id/metrics/recent` | Full | N/A | N/A | Backend-only historical query. |
| Asset list | `GET /api/frames/:id/assets` | Full, frame/proxy aware | Full, local assets | Partial, empty list | Same `{ assets: [...] }` shape. |
| Asset file | `GET /api/frames/:id/asset?path=...` | Full | Full | Planned | Same route for local files. Must preserve path safety. |
| Asset sync | `POST /api/frames/:id/assets/sync` | Full | N/A | N/A | Backend-only or future local asset rescan. |
| Asset upload image | `POST /api/frames/:id/assets/upload_image` | Full | Available through Pi admin asset API, not canonical frame API | Planned | Add canonical Pi/ESP32 routes before using from shared standalone UI. |
| Asset upload file | `POST /api/frames/:id/assets/upload` | Full | Available through Pi admin asset API, not canonical frame API | Planned | Same as above. |
| Asset mkdir/delete/rename | `POST /api/frames/:id/assets/{mkdir,delete,rename}` | Full | Available through Pi admin asset API, not canonical frame API | Planned | Add canonical aliases if local asset management is part of standalone UI. |
| Clear build cache | `POST /api/frames/:id/clear_build_cache` | Backend only | N/A | N/A | Build cache is backend-owned. |
| Reset frame | `POST /api/frames/:id/reset` | Backend only | N/A | N/A | Backend operation; local reset should become an explicit local command if needed. |
| Restart/reboot/stop | `POST /api/frames/:id/{restart,reboot,stop}` | Backend only | Alias via events/reload where meaningful | Partial via events/reload where meaningful | Avoid exposing unsupported power controls in local mode. |
| Deploy | `POST /api/frames/:id/deploy` | Backend only | N/A | N/A | Backend-only orchestration. |
| Fast deploy | `POST /api/frames/:id/fast_deploy` | Backend only | N/A | N/A | Backend-only orchestration. |
| Deploy plan | `GET/POST /api/frames/:id/deploy_plan` | Backend only | N/A | N/A | Backend-only planning. |
| Remote deploy/restart | `POST /api/frames/:id/{deploy_remote,restart_remote}` | Backend only | N/A | N/A | Backend-only SSH/agent operations. |
| Cancel deploy | `POST /api/frames/:id/cancel_deploy` | Backend only | N/A | N/A | Backend-only worker operation. |
| Build zip downloads | `POST /api/frames/:id/download_*_zip` | Backend only | N/A | N/A | Backend-only generated artifacts. |
| Buildroot SD image | `GET/POST /api/frames/:id/buildroot/sd_image`, download route | Backend only | N/A | N/A | Backend-only image generation. |
| TLS generation | `POST /api/frames/:id/tls/generate` | Backend only | N/A | N/A | Backend-owned certificate management. |
| SSH keys | `POST /api/frames/:id/ssh_keys` | Backend only | N/A | N/A | Backend-only SSH operation. |
| Embedded firmware status/build/download/OTA | `/api/frames/:id/embedded/firmware...` | Backend only | N/A | N/A as local API | Backend creates artifacts; ESP32 consumes OTA download through device routes. |
| Embedded USB deploy complete | `POST /api/frames/:id/embedded/usb_deploy_complete` | Backend only | N/A | N/A | Backend bookkeeping after USB flashing. |
| Embedded render fetch | `GET /api/frames/:id/embedded/render` | Device-facing backend route | N/A | Full consumer | ESP32 pulls packed bitmap from backend. Requires bearer auth. |
| Embedded scene fetch | `GET /api/frames/:id/embedded/scenes` | Device-facing backend route | N/A | Full consumer | ESP32 pulls canonical deployed scenes JSON. Requires bearer auth. |
| Embedded settings fetch | `GET /api/frames/:id/embedded/settings` | Device-facing backend route | N/A | Full consumer | ESP32 pulls device settings. Requires bearer auth. |
| Embedded OTA manifest/download | `GET/HEAD /api/frames/:id/embedded/ota/...` | Device-facing backend route | N/A | Full consumer | ESP32 checks and downloads firmware. Requires bearer auth. |
| Local setup | `POST /api/setup` | N/A | N/A | Full | ESP32 captive portal setup route. Target: eventually mirror enough canonical save behavior for local UI. |
| Local scene metadata | `GET /api/scenes`, `GET /api/scene-state` | N/A | Alias/legacy equivalents exist through canonical state routes | Full simple routes | Keep for simple portals and diagnostics. Shared UI should use canonical state routes. |
| Legacy upload | `POST /uploadScenes` | N/A | Alias | Alias | Keep as frame runtime compatibility target; backend forwards hot uploads here internally. |
| Legacy reload | `POST /reload` | N/A | Alias | Alias | Keep as compatibility route. Prefer `/api/frames/:id/event/reload`. |
| Legacy state/image | `GET /state`, `/states`, `/image` | N/A | Alias | Alias | Keep for lightweight viewers and old clients. Prefer canonical frame routes. |
| Web admin shell | `/admin`, `/login`, `/ws/admin` | N/A | Full | Planned/separate portal | Pi serves the shared admin shell. ESP32 currently has a simpler portal/UI. |

## Canonical Payloads

Frame list/detail:

```json
{
  "frame": {
    "id": 1,
    "name": "Kitchen",
    "mode": "rpios",
    "frame_host": "frame.local",
    "frame_port": 8787,
    "frame_access_key": "",
    "frame_admin_auth": { "enabled": true },
    "server_host": "backend.local",
    "server_port": 8989,
    "server_send_logs": true,
    "width": 800,
    "height": 480,
    "device": "inky.auto",
    "scenes": []
  }
}
```

Frame save:

```json
{
  "name": "Kitchen",
  "interval": 300,
  "frame_admin_auth": { "enabled": true, "user": "admin", "pass": "secret" },
  "https_proxy": { "enable": false },
  "error_behavior": { "mode": "show_error_retry", "retry_seconds": 300 },
  "scenes": [],
  "next_action": "render"
}
```

Pi maps this into runtime config:

- `frame_admin_auth` -> `frameAdminAuth`
- `https_proxy.certs.server` -> `httpsProxy.serverCert`
- `https_proxy.certs.server_key` -> `httpsProxy.serverKey`
- `error_behavior.retry_seconds` -> `errorBehavior.retrySeconds`
- `timezone_updater` -> `timeZoneUpdates`
- `scenes` -> active `scenes.json` or `scenes.json.gz`
- Original API fields -> `frameApi` in `frame.json` for sync/adoption fidelity

Scene/state:

```json
{ "sceneId": "weather", "state": {} }
```

```json
{ "sceneId": "weather", "states": { "weather": {} } }
```

Hot upload:

```json
{
  "sceneId": "weather",
  "scenes": [
    { "id": "weather", "name": "Weather", "data": {} }
  ]
}
```

## Frontend Rules

- Feature code calls `apiFetch("/api/...")`.
- Backend mode lets `apiFetch` resolve `/api/...` to `/api/projects/:project_id/...`.
- Frame-control mode skips project discovery and sends `/api/...` directly to the frame origin.
- Shared editor saves use `POST /api/frames/:id`; local Pi persistence is handled by the Pi adapter.
- Shared preview/state/assets reads use canonical `/api/frames/:id/...` routes.
- Template and backend-only build/deploy UI should be hidden or disabled in frame-control mode.
- The frontend should treat unsupported fields as absent, not fatal.

## Current Gaps

- ESP32 `POST /api/frames/:id` persists embedded-owned fields and scenes, but it does not yet support every backend/Pi field such as full asset management, timezone updater config, or backend build/deploy settings.
- ESP32 image routes currently return BMP previews. Shared UI should continue to use browser image loading and avoid assuming PNG.
- Pi asset mutation has admin routes, but the canonical `/api/frames/:id/assets/...` mutation aliases are not complete. Add them before enabling full local asset management in the shared UI.
- Standalone adoption should be explicit: backend should discover/read local `GET /api/frames` and `GET /api/frames/:id`, import scenes/config, then write backend server credentials back to the local frame through `POST /api/frames/:id`.
- Backend embedded device routes are bearer-authenticated device-consumer routes, not local admin UI routes. Do not make the shared frontend depend on them directly.
