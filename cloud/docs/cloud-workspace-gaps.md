# Cloud workspace: the road to full frame control

Goal: an owner controls **both esp32 and buildroot frames entirely from the
cloud** — upload/assign scenes, see the current image and per-scene
previews, read logs, deploy changes, update FrameOS itself. The gaps were
mapped from a live bench session (one PhotoPainter esp32 + one Pi Zero 2 W)
and worked through in `cloud-workspace-richness` → `-fixes` → `-next`.
Numbered items are referenced from code comments, so the numbers are
stable. Consolidated tracker: `docs/todo.md` at the repo root.

## Remaining

- **6. FrameOS updates (OTA) from the cloud — buildroot half.** The esp32
  half shipped (see the ledger); on buildroot/Pi the Nim client answers
  `notify_update_available` with an audit log and nothing else, while the
  signed upgrade flow it should trigger already exists on-device
  (`frameos/src/frameos/upgrade.nim`, `POST /api/upgrade`). Wire the verb
  (or a cloud UI action) to that flow so cloud-managed Pi frames can
  actually update. The esp32 path was confirmed against production on
  2026-08-13: a real frame OTA'd to release 2026.8.19 (download → signed
  apply → reboot → `frameos_version` reported from the running app
  descriptor).

## Shipped (ledger — item numbers referenced from code)

1. **Current frame image** — `image_get` wire verb +
   `GET /api/frames/{id}/image`; full loop verified against production by
   frame 02e05f35 (a cloud-managed PhotoPainter) on 2026-08-09.
2. **Scene previews** — `GET /api/frames/{id}/scene_images/{sceneId}`
   serves the device's own per-scene snapshot (the runner writes
   `{assets}/.frameos/scene_images/{name}-{md5}.png` on every scene
   switch; fetched via `asset_get` + the `frame_asset_files` cache,
   `?thumb=1` riding the device's 320×320 thumbnailer), falling back to
   store covers.
3. **Deploy** — cloud Save & Deploy saves edited scenes to the account
   (new versions via `/api/account/scenes/{id}/content`, new scenes via
   `POST /api/account/scenes`), updates the assignment list and pushes it;
   `/deploy` and `/fast_deploy` are never called in cloud mode; the ad-hoc
   uploadScenes push is only the fallback when persistence fails.
4. **Scene upload events** — `POST /api/frames/{id}/event/{name}` shim
   maps render / setCurrentScene / uploadScenes onto queue verbs.
5. **`GET /api/cloud/status`** — handled by `cloudEmptyCatalogs`.
6. **FrameOS updates (OTA), esp32 half** — `notify_update_available`
   triggers a signed cloud OTA on-device (`main/fos_ota.c`: fetch the
   manifest, verify the minisign signature, apply); `unsupported_verb`
   retired with it. Buildroot half + real-release confirmation remain,
   above.
7. **Live updates in dev** — the shell injects the LAN hub origin and the
   hub accepts private-network browser origins outside production.
8. **Scene tiles** hydrate from `GET /api/frames/{id}/scenes`.
9. **Metrics** — `frame_metrics` retention, `/metrics` +
   `/metrics/recent` in the panel's shape, live samples merged from
   `new_metrics`.

Beyond the original list: **wasm fleet previews** (2026-08-13) — when a
fleet tile's device snapshot and store cover both fail, the assigned scene
renders in-browser via the frameos-wasm worker and the captured bitmap
fills the tile (`frontend/src/models/wasmPreviewModel.tsx` +
`utils/wasmScenePreview.ts`; serial one-worker queue, 30-entry bitmap cache
with failure tombstones, "Preview" badge; device-sourced images always win,
cloud mode only, no proxies beyond the existing
`/api/store/preview-proxy`). Renders ONLY on the tile's explicit
"Preview in browser" click, never automatically — a scene render runs data
apps with the account's real settings and can hit paid APIs (OpenAI image
nodes), so bulk auto-rendering would spend the owner's money. The Assets panel is read-write on cloud
(`asset_put` / `asset_mkdir` / `asset_delete` / `asset_rename` wire verbs
— `docs/cloud-frames.md` — behind `/api/frames/{id}/assets/*` routes;
dot-directories refused, 2.5 MiB single-frame upload cap), asset browsing
(`assets_list` / `asset_get`, verified against a 51-entry SD listing with
a 1.1 MB BMP streamed in 24 KiB chunks), wasm live-preview external
fetches proxied through `/api/store/preview-proxy`, and Monaco + builtin
app sources working in the cloud workspace.
