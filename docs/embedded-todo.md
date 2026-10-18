# Embedded firmware — what is still open

The ESP32 and Pico firmware under `embedded/`. Reference material lives in
`docs/esp32-memory.md`, `docs/esp32-image-size.md`, `docs/esp32-progressive-jpeg.md`
and `docs/cloud-frames.md`; the cross-plane settings contract is
`docs/cloud-frames-contract.json`. This file only carries the work.
**When an item ships, delete it.** The firmware is careful, defensive C —
path sanitisation, the netguard, the contract walker, the power and battery
logic and the verify-before-switch OTA all hold up; what is left is the
Pico's gaps and its missing test harness.

Building note: ESP-IDF firmware cannot be built locally; it compiles with
`-Werror`, so every firmware edit costs a CI round-trip on "Build and boot
ESP32 firmware image".

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
