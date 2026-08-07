# ESP32 13.3" PhotoPainter (ESP32-S3-ePaper-13.3E6) — full-support TODO

Goal: the 13.3E6 frame works standalone over Wi-Fi with OTA, against both the
self-hosted backend and FrameOS Cloud; fast deploy (scenes + reload) and full
deploy (firmware rebuild + upgrade) both work; assets and logs work; and when
connected over USB serial, every control/upload/download has a serial path.

Hardware facts (Waveshare docs): 32 MB flash, 16 MB PSRAM, ETA6098 charge IC
(not an I2C PMIC — no telemetry), MX1.25 battery header, no RTC chip, no user
buttons (BOOT/Reset only), TF slot on SPI3. The existing
`waveshare_esp32_s3_epaper_13_3e6` preset is correct; no new preset needed.

## Already works (verified on device / in code)

- Standalone: captive-portal + serial provisioning, offline render from cached
  `/state/scenes.json`, APSTA fallback, SNTP.
- Local rendering: Nim + pixie + QuickJS interpreter on-device (~14.5 s/render).
- Fast deploy (backend): push `POST /uploadScenes` + `/reload` over LAN, pull
  `GET /embedded/scenes` with ETag; USB `usb_api upload-scenes`; cloud
  `set_scenes` push with `scene_ack`. Hot reload, no reboot.
- OTA (backend): manifest + resumable download, rollback-protected early-boot
  updater, 24 h periodic check, `POST /api/action/ota` poke.
- Cloud: enrollment (FRCT_ claim token / device flow), Ed25519 WS auth,
  verbs `get_state render reboot restart_runtime set_current_scene set_scenes
  set_settings assets_list asset_get image_get`, scope-gated log streaming,
  browser flasher.
- Logs (live): `POST /api/log` to backend, WS `log_batch` to cloud, serial
  console stream into the Logs panel.
- Browser flash over WebSerial (esptool-js, watchdog reset, SPIFFS preserved).

## Status 2026-08-07 (branch esp32-photopainter)

P0 items 1-6 are DONE and hardware-verified on the bench 13.3E6 against a
live local backend: assets round-trip over HTTP/cloud-WS/USB, full deploy
delivered a backend-built image over OTA (device booted from ota_1),
restart/reboot work from backend tasks, logs+metrics ingest within seconds
(two silent-failure bugs found and fixed on the way: the 48K TLS-sized
heap floor muting plain-http log upload, and metrics queued past the last
flush), and /embedded/settings serves the ETag'd frame object the firmware
applies live. P1: usb_api provisioning verbs + structured wifi-scan are
in (with a pre-existing scan-vs-reconnect race fixed); spill dir is wired
(forced-spill render validation pending); 32MB layout is CI-validated.
Remaining: frontend USB provisioning UI, cloud OTA verb + signed OTA,
set_schedule, image_get e2e check.

## P0 — core gaps (this effort)

1. **Land `fix/cloud-frames-ws-watchdog`** (4 unmerged commits: cloud WS
   watchdog in `fos_cloud.c`, readable cloud device logs, ESP32 `set_settings`
   + compact settings surface, USB image hardening, e2e fix). PR + merge first;
   everything below builds on top.

2. **Assets end-to-end** (biggest hole — today the SD card must be moved by
   hand):
   - Firmware: real HTTP asset API on the device (`GET /api/frames/{id}/assets`
     list, file get/upload/mkdir/delete/rename against the SD/`/state` paths).
     `fos_http.c:1735` currently returns hardcoded `{"assets":[]}`.
   - Backend: asset routes (`frames.py:2368-2600`) are SSH/agent-only — add an
     embedded branch that proxies to the device HTTP API instead.
   - Cloud: implement `asset_put/asset_mkdir/asset_delete/asset_rename` verbs
     (currently `unsupported_verb`, `fos_cloud.c:1569`), sharing the same
     firmware asset layer.
   - USB: `usb_api upload-asset` / `list-assets` so photos load over serial.
   - Enable FAT long filenames (8.3 names today).

3. **Full deploy = rebuild + OTA over Wi-Fi**:
   - `_plan_full()` (`frame_deploy_workflow.py:593`) has no embedded branch —
     `POST /frames/{id}/deploy` on an ESP32 dies in SSH. Make full deploy for
     embedded: build firmware (existing `embedded_firmware_task`) → wait ready
     → trigger OTA → confirm via bootup log. Surface as the normal Deploy
     button.
   - Fix firmware-build hygiene while in there: platform metadata hardcodes
     `esp32-s3` (`embedded_firmware.py:1627,1983-1998,2029`), `configHash`
     omits the IDF target so S3↔C3 switches can serve stale images, shared
     in-tree build dir races concurrent builds.

4. **Restart/reboot + control parity (backend mode)**:
   - Firmware: add `POST /api/action/restart` (runtime reload) — reboot exists
     via cloud only; expose both over LAN HTTP and `usb_api`.
   - Backend: `restart_frame_task`/`reboot_frame_task` are systemd-over-SSH
     (`tasks/restart_frame.py`) — add embedded branches; gate `/reset`,
     `/stop`, `/deploy_remote`, `/restart_remote`, `/clear_build_cache` with
     400s for embedded.
   - Frontend: `workspaceSurfaces.ts` only gates panels for `virtual` and
     cloud-ESP32 — extend to backend-mode ESP32 (hide Terminal/Ping, keep
     Assets/Metrics once they work, wire Restart/Reboot to the new endpoints).

5. **Logs at rest + metrics**:
   - Firmware: PSRAM ring buffer of recent log lines → serve
     `GET /api/frames/{id}/logs` (hardcoded empty today, `fos_http.c:1727`),
     cloud `get_logs`, and `usb_api logs`.
   - Firmware: emit a periodic `metrics` log event (heap, PSRAM, RSSI, uptime,
     render ms) → backend `new_metrics` ingests it as-is → Metrics panel and
     cloud `get_metrics` come alive.

6. **Settings without reflash**: firmware pulls
   `GET /embedded/settings` (endpoint exists, never consumed) during scene
   sync; extend the payload beyond HA/immich/openAI/unsplash to
   interval/deep_sleep/render_mode/name so backend saves apply live.

## P1 — cloud + serial completeness

7. **USB serial parity**: `usb_api` lacks machine-framed
   `set`/`wifi`/`wifi-scan`/`restart`/`factory-reset` (browser must scrape
   REPL text); frontend exposes no Wi-Fi re-provisioning over USB and never
   calls existing `reload/scenes-sync/ota/scene-state`. Add subcommands +
   a small USB provisioning UI; prefer USB transport for controls when serial
   is connected.
8. **Cloud OTA**: implement the `ota`/`notify_update_available` verb pulling
   the published generic image; signed OTA (minisign over release assets,
   verify in `fos_ota.c` and `upgrade.nim`) is the named blocker — may split
   into its own effort.
9. **Large-image spill**: wire `fos_nim_http_set_spill_dir()` in `main.c`
   (+ boot sweep of `http-spill-*.tmp`), validate with a ~3 MB gallery JPEG on
   this frame; PNG full-decode OOM on 13.3E6 is the named repro.
10. **Cloud verb stragglers**: `set_schedule` (TODO at `fos_cloud.c:1817`),
    `image_get` end-to-end verification.
11. **CI: validate the 32 MB layout** (`ci_build_image.sh` only checks
    8 MB/4 MB; this board is 32 MB and nobody build-tests that profile).

## P2 — later / nice-to-have

- Battery: 13.3E6 has a battery header but no telemetry IC; check the
  schematic for a voltage-divider ADC pin and set `battery_pin` if present.
- Deep-sleep improvements (GPIO wake is moot — no buttons), portal Wi-Fi scan
  list in the HTML form, portal AP password, mDNS advertisement, log
  persistence across offline periods, firmware artifact GC, API-key rotation
  without reflash, per-frame build dirs.
