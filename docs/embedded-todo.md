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

The Pico is a thin client by hardware, not by choice — the Inky Frame's PSRAM
is on plain SPI and cannot be memory-mapped (`embedded/pico/README.md`) — and
since 2026-09-19 it is a complete one: `usb_api` provisioning from the deploy
panel, setup hotspot + captive portal, settings pull, device HTTP API + mDNS,
log ring + upload, unchanged-frame refresh skip, battery sleep, signed release
UF2s that the backend lists and serves. The four items that used to be here
(stale http-only comment, chunked responses, SSIDs with spaces, sub-minute
sleep) are fixed and host-tested. Still open:

- **Nothing has run on hardware yet.** The README's "First power-on
  checklist" is the list; the Spectra init table and the 16 KB stack under a
  TLS handshake are the two things most likely to need a second look.
- **No FrameOS Cloud link** — blocked on the hub rendering for thin clients
  (`docs/convergence-todo.md` §3). When that exists: a WebSocket client over
  altcp TLS, Ed25519 enrollment (Monocypher is portable), and the contract's
  `pico` profile (`docs/cloud-frames-contract.json` has only `linux`/`esp32`).
- Front buttons re-render but never reach the scene as a `button` event. The
  scene runs on the backend, so this needs a device → backend event route and
  the wasm harness accepting events; the ESP32 thin client has the same gap.
- `GET /state` / `/states` on the device 404, so the workspace's state panel
  for a thin client falls back instead of reading the backend's store, which
  is where a thin client's scene state actually lives.
- Battery voltage is not reported: VSYS is on ADC3 behind the CYW43's SPI
  clock pin. `onBattery` comes from VBUS sense only.
- The stack's lower 8 KB shares the top of the heap region (pico-sdk's default
  layout with `PICO_STACK_SIZE=0x4000`). Heap peak is ~110 KB of 143 KB
  (Pico W) / 212 KB (Pico 2 W); a custom linker script would make it a wall
  instead of a margin.
- The device's own HTTP server has no TLS listener.
- Small ones from the pre-hardware review (2026-09-19): `set hardware` /
  `set pins` on the console only take effect after `restart` (SPI is set up
  once); `GET /image` can tear if a render lands mid-download; the 3-minute
  console keep-awake reads true again for 3 minutes every 49.7 days of uptime
  (32-bit ms).

## Tests

The ESP32's IDF-free security code has host tests (`embedded/esp32/host_tests`,
run in CI). The Pico's portable modules have theirs in `embedded/pico/tests`
(`make -C embedded/pico/tests`, ASan + UBSan, run by the `pico-firmware` PR
job); what no test covers on either board is the wiring.
