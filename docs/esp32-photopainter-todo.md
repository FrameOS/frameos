# ESP32 13.3" (ESP32-S3-ePaper-13.3E6) — remaining TODO

Goal: the 13.3E6 frame works standalone over Wi-Fi with OTA, against both the
self-hosted backend and FrameOS Cloud; fast deploy and full deploy both work;
assets and logs work; and when connected over USB serial, every
control/upload/download has a serial path.

Hardware facts (Waveshare docs): 32 MB flash, 16 MB PSRAM, ETA6098 charge IC
(not an I2C PMIC — no telemetry), MX1.25 battery header, no RTC chip, no user
buttons (BOOT/Reset only), TF slot on SPI3. The existing
`waveshare_esp32_s3_epaper_13_3e6` preset is correct; no new preset needed.

## Status 2026-08-09

The parity push is essentially done, all hardware-verified on the bench
13.3E6: assets over HTTP/cloud-WS/USB, full deploy (backend build → OTA),
restart/reboot, logs + metrics, live `/embedded/settings`, USB provisioning
UI, on-device scene scheduler (#301–#302); signed cloud OTA (#303); C3
thin-client stub parity + dual-control-plane fix (#304); file-backed
streaming decode for spilled PNGs (pixie `17512ae`), forced-spill validation
(`set spill_force <bytes>`), scene refreshInterval/nextSleep cadence fixes,
and per-profile backend build dirs (#305).

## Remaining

Nothing tracked. The last item — end-to-end verification of the `image_get`
cloud verb — was closed 2026-08-09: a cloud-managed ESP32 acked it against
production, so the device → cloud → UI path is exercised, not just the
device-side BMP pack. Note the frame that did it was a PhotoPainter 7.3"
(`waveshare_esp32_s3_photopainter`), not this 13.3E6; the verb and the BMP
pack are board-independent, so this is the verb proven rather than this
board re-proven.

## Note 2026-08-09: the memory picture changed under this board

Anything here (or in bench notes elsewhere) that reasons about "a dozen
scenes loaded" eating the internal-RAM headroom predates two changes that
landed in 2026.8.13:

- the Nim heap allocates from PSRAM explicitly, instead of falling into
  internal RAM via `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL`, and
- scenes are stored one file per scene and only the active one is resident.

On a PhotoPainter that moved internal free from ~12.5 KB to ~109 KB with the
same scene set. The 13.3E6 was previously measured at ~16-19 KB internal free
with a dozen scenes — that figure is stale and should be re-measured before
any conclusion is drawn from it.

## P2 — later / nice-to-have

- Battery: 13.3E6 has a battery header but no telemetry IC; check the
  schematic for a voltage-divider ADC pin and set `battery_pin` if present.
- Deep-sleep improvements (GPIO wake is moot — no buttons).
- Portal: Wi-Fi scan list in the HTML form, AP password.
- mDNS advertisement.
- Log persistence across offline periods.
- Firmware artifact GC.
- API-key rotation without reflash (the bench unit's stuck NVS `api_key` is
  the live example — `set api_key` cannot unset a value).
- Parallel firmware builds: build dirs are per-profile now, but
  `main/generated_config.h` and the Nim `nimcache` are still shared in-tree,
  so builds serialize under the global build lock.
