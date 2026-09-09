# Embedded firmware — what is still open

The ESP32 and Pico firmware under `embedded/`. Reference material lives in
`docs/esp32-memory.md`, `docs/esp32-image-size.md`, `docs/esp32-progressive-jpeg.md`
and `docs/cloud-frames.md`; the cross-plane settings contract is
`docs/cloud-frames-contract.json`. This file only carries the work.
**When an item ships, delete it.** Seeded from the 2026-09-09 full-repo
review (`docs/review-todo.md` §14), whose verdict was: careful, defensive C —
path sanitisation, the netguard, the contract walker, the power and battery
logic and the verify-before-switch OTA are all correct as far as they can be
traced. What is left is parity gaps, authenticated-peer DoS, one privacy gap
and doc drift.

Building note: ESP-IDF firmware cannot be built locally; it compiles with
`-Werror`, so every firmware edit costs a CI round-trip on "Build and boot
ESP32 firmware image".

## ESP32 — low

- `require_protected_access` decides "on the hotspot" by peer IP range
  rather than by the interface the request arrived on.
- `/api/setup` skips the panel and `assets_path` validation the console
  applies to the same values.
- Cloud OTA and backend OTA share no mutex; both can run at once.
- A too-long provisioning line runs its tail as a second command.
- The asset job queue sits in scarce internal RAM.
- `wake_schedule` aligns to UTC, not local time.
- The status JSON still reports retired OTA fields.
- Wi-Fi accepts WPA1 and mixed mode.
- `usb_api upload-asset` / `asset-op` / `get-asset` are implemented but
  nothing calls them.

## Pico

The Pico does authenticate the server for https (root bundle plus SNI
hostname check, with a build-time validity floor), so that open question is
answered. Still open:

- `pk_http.h:9-11` still says v1 is http-only.
- No chunked transfer-encoding handling.
- An SSID with spaces cannot be provisioned.
- A 15–59 s interval rounds to zero minutes.

## Tests

The ESP32's IDF-free security code has host tests (`embedded/esp32/host_tests`,
run in CI). The Pico has no host-test harness at all.
