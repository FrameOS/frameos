# Cloud workspace: the road to full frame control

Goal: an owner controls **both esp32 and buildroot frames entirely from the
cloud** — upload/assign scenes, see the current image and per-scene
previews, read logs, deploy changes, update FrameOS itself. The gaps were
mapped from a live bench session (one PhotoPainter esp32 + one Pi Zero 2 W)
and worked through in `cloud-workspace-richness` → `-fixes` → `-next`.
Numbered items are referenced from code comments, so the numbers are
stable. Consolidated tracker: `docs/todo.md` at the repo root.

## Remaining

- **6. FrameOS updates (OTA) from the cloud** — the one open item.
  `notify_update_available` is answered `unsupported_verb` on esp32 and no
  update flow exists for buildroot frames. Work: signed OTA (the standing
  blocker — design in `cloud/docs/cloud-frames.md`, "Signed OTA"), an
  `ota` verb (esp32: pull the published generic image; buildroot: release
  tarball swap via the frameos binary), and an Update button gated on the
  fleet's reported `frameos_version`.

Loose ends:

- Item 1's full loop still awaits a re-enrolled frame — the `image_get`
  verb is device-side verified (ESP32 BMP pack) but the end-to-end
  device → cloud → UI path hasn't been exercised.
- Bench finding: the PhotoPainter gallery scene OOMs downloading a ~3 MB
  image (`total=2686976 psram_free≈894k`; 12 resident scenes ate the old
  headroom). The fix is spilling large HTTP bodies to SD/flash plus
  streaming decode — design + inert prototype in
  `esp32-large-image-spill.md`; firmware wiring and hardware validation
  are left. NOT proxy resizing (hard rule: no image proxies, ever).
- Cosmetic: ESP32 asset listings show 8.3 FAT short names (`02_SYS~1`) —
  enable long filenames in the FAT config.

## Shipped (ledger — item numbers referenced from code)

1. **Current frame image** — `image_get` wire verb +
   `GET /api/frames/{id}/image` (full-loop verification pending, above).
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
6. — remains open, above.
7. **Live updates in dev** — the shell injects the LAN hub origin and the
   hub accepts private-network browser origins outside production.
8. **Scene tiles** hydrate from `GET /api/frames/{id}/scenes`.
9. **Metrics** — `frame_metrics` retention, `/metrics` +
   `/metrics/recent` in the panel's shape, live samples merged from
   `new_metrics`.

Beyond the original list: the Assets panel is read-write on cloud
(`asset_put` / `asset_mkdir` / `asset_delete` / `asset_rename` wire verbs
— `docs/cloud-frames.md` — behind `/api/frames/{id}/assets/*` routes;
dot-directories refused, 2.5 MiB single-frame upload cap), asset browsing
(`assets_list` / `asset_get`, verified against a 51-entry SD listing with
a 1.1 MB BMP streamed in 24 KiB chunks), wasm live-preview external
fetches proxied through `/api/store/preview-proxy`, and Monaco + builtin
app sources working in the cloud workspace.
