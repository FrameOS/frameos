# Cloud workspace: the road to full frame control

> Status (2026-08-03, this branch): items **4** and **5** are done, item **8**
> is done (tiles hydrate from the server), and asset browsing shipped as a new
> surface: `assets_list`/`asset_get` wire verbs (docs/cloud-frames.md), hub
> caching (`frame_assets` + `frame_asset_files`), `GET /api/frames/{id}/assets`
> + `GET /api/frames/{id}/asset`, and a read-only Assets panel in cloud mode —
> verified end-to-end against the bench PhotoPainter (51-entry SD listing,
> 1.1 MB BMP streamed in 24 KiB chunks). Item **1** shipped as the
> `image_get` verb + GET /api/frames/{id}/image (device-side verified for
> the ESP32 BMP pack; awaiting a re-enrolled frame for the full loop).
> Item 4 shipped as the
> `POST /api/frames/{id}/event/{name}` shim (render / setCurrentScene /
> uploadScenes → queue verbs), so "preview on frame" and the Assets panel's
> run-image-scene buttons work unchanged. Item **2** shipped (scene_images
> serves store covers, resolving runtime scene ids through the assigned
> versions' scenes.json). Item **3** shipped client-side: cloud
> Save & Deploy pushes the frame form's scenes through the uploadScenes
> shim — /deploy and /fast_deploy are never called in cloud — and the scene
> editor opens for cloud frame scenes (the "Open editor" row no longer
> requires a backend-saved scene; controlLogic derives state from
> last_state instead of the backend-only /states route). Item **7** shipped
> (dev-only: the shell injects the LAN hub origin and the hub accepts
> private-network browser origins outside production). Item **9** shipped
> (frame_metrics retention + /metrics and /metrics/recent in the panel's
> shape; live samples merge from new_metrics in cloud). Item **6** (signed
> OTA) remains the one open item — blocked on the signing design in
> CLOUD-TODO.md. The gallery-OOM fix has a design doc + inert prototype in
> cloud/docs/esp32-large-image-spill.md (main.c wiring + hardware
> validation left). Known cosmetic issue: the ESP32
> reports 8.3 FAT short names (`02_SYS~1`) — enable long filenames in the FAT
> config. Separate bench finding: the PhotoPainter's gallery scene now OOMs
> downloading a ~3 MB image (`total=2686976 psram_free≈894k` at failure, 12
> scenes resident eat the old headroom); the fix is spilling large HTTP bodies
> to SD/flash + streaming decode, not proxy resizing (see
> frameos-memory-aware-rendering notes).

Goal: an owner controls **both esp32 and buildroot frames entirely from the
cloud** — upload/assign scenes, see the current image and per-scene previews,
read logs, deploy changes, update FrameOS itself. This maps every gap between
what the workspace UI calls and what the cloud implements, gathered from a
live bench session (dev stack, one PhotoPainter esp32 + one Pi Zero 2 W).
Each item lists the observed failure, then the work. Build on
`cloud-workspace-richness`.

## 1. Current frame image — `GET /api/frames/{id}/image` → 404

The frame page's preview panel calls a backend-mode endpoint that has no
cloud counterpart; nothing in the wire contract uploads a rendered image.

- Device→cloud: after each successful render, the frame pushes a downscaled
  snapshot (JPEG/PNG; esp32: pack from the framebuffer before sleep — mind
  PSRAM; buildroot: reuse the backend snapshot path in
  `frameos/src/frameos/`) over the hub WS (new `frame_image` message) or
  `POST /api/frames/{id}/image` with the bearer token.
- Storage: one row/object per frame (latest only), size-capped like
  `frame_logs`, counted into account storage.
- Serve: implement the exact route the UI already calls; placeholder in the
  UI until the frame has pushed once.

## 2. Scene previews — `GET /api/frames/{id}/scene_images/{sceneId}` → 404

Same class as (1) but per scene. Short-term: serve the store scene's cover
image for store-installed scenes (the data exists in `store_scene_images`).
Long-term: per-frame scene snapshots pushed on scene change.

## 3. Deploy — `POST /api/frames/{id}/deploy?...` → 404 ("Failed to start deploy")

Backend deploys rebuild+flash over SSH; the cloud equivalent is different per
platform and mostly *already speakable* through existing verbs:

- esp32: "deploy" = `set_scenes` push (exists) + OTA for firmware (the
  console `ota` exists; a cloud `ota` verb does not — see 6).
- buildroot: `set_scenes` push (exists via `POST /api/frames/{id}/scenes`).
- Work: a thin `/deploy` route that maps to assign+push and reports task
  progress in the shape the UI's task tracker expects, or teach
  `saveAndDeployFrame` a cloud path that calls the scenes API directly
  (partially done in `cloud-workspace-richness`; the dashboard's Save flow
  still hits `/deploy`).

## 4. Scene upload events — `POST /api/frames/{id}/event/uploadScenes` → 404

The scene editor's "preview on frame" and upload paths post backend events.
Cloud path: translate to the durable command queue (`render` /
`set_current_scene` / `set_scenes` verbs). Needs a small event→verb shim
route or client-side branching in cloud mode.

## 5. `GET /api/cloud/status` → 404

The backend's own cloud-link status endpoint, meaningless inside the cloud.
Add to `cloudEmptyCatalogs` (pattern established in
`cloud-workspace-richness` for `/api/settings` and `/api/assets`).

## 6. FrameOS updates (OTA) from the cloud

`notify_update_available` is answered `unsupported_verb` on esp32 and no
update flow exists for buildroot frames. Work: signed OTA (already the
blocker noted in CLOUD-TODO.md), an `ota` verb (esp32: pull the published
generic image; buildroot: release tarball swap via the frameos binary), and
an Update button gated on a version comparison (the fleet already reports
`frameos_version`).

## 7. Live updates in dev — browser WS to the hub fails

`ws://10.4.0.47:3100/api/frames/updates` fails (LAN-origin browser vs
CSP/auth cookie domain). Devices are fixed via enrollment `ws_url`; the
browser falls back to the 15 s poll from `cloud-workspace-richness`. Work:
make the hub accept the dev session cookie for LAN origins (or proxy the WS
through the Next dev server), then drop the poll to a fallback.

## 8. Scene tiles vs server state

Dashboard scene tiles reflect client-side form state only; assigned scenes
should hydrate from `GET /api/frames/{id}/scenes` so they survive reload.
(Noted as the "next systemic step" in the richness branch.)

## 9. Metrics

No `/metrics/recent` in cloud mode. Devices already send metrics events
(buildroot); esp32 refuses `get_metrics` but could push. Store capped
per-frame metrics like logs; then enable the panel.

## Suggested batch order

1. (5) + (4): kill the 404 noise; scene control end-to-end for both
   platforms (esp32 verbs already exist — this is the "control an esp32
   scene from the cloud" goal).
2. (3): cloud-native deploy mapping, so Save & Deploy works.
3. (1) + (2): images (device push + serve); biggest visible win.
4. (8): server-hydrated tiles.
5. (6): OTA (needs signing design).
6. (7) + (9): live sockets in dev; metrics.
