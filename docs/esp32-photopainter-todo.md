# ESP32 13.3" (ESP32-S3-ePaper-13.3E6) — remaining TODO

Goal: the 13.3E6 frame works standalone over Wi-Fi with OTA, against both the
self-hosted backend and FrameOS Cloud; fast deploy and full deploy both work;
assets and logs work; and when connected over USB serial, every
control/upload/download has a serial path.

Hardware facts (Waveshare docs): 32 MB flash, 16 MB PSRAM, ETA6098 charge IC
(not an I2C PMIC — no telemetry), MX1.25 battery header, no RTC chip, no user
buttons (BOOT/Reset only), TF slot on SPI3. The existing
`waveshare_esp32_s3_epaper_13_3e6` preset is correct; no new preset needed.

## Status 2026-08-08

The parity push is essentially done, all hardware-verified on the bench
13.3E6: assets over HTTP/cloud-WS/USB, full deploy (backend build → OTA),
restart/reboot, logs + metrics, live `/embedded/settings`, USB provisioning
UI, on-device scene scheduler (#301–#302); signed cloud OTA (#303); C3
thin-client stub parity + dual-control-plane fix (#304); file-backed
streaming decode for spilled PNGs (pixie `17512ae`), forced-spill validation
(`set spill_force <bytes>`), scene refreshInterval/nextSleep cadence fixes,
and per-profile backend build dirs (#305).

## Remaining

1. **`image_get` cloud verb**: end-to-end verification (the verb exists and
   is wired; nobody has confirmed the full path against a live frame).

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
