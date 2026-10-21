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

The Pico is a thin client by hardware, not by choice — the Inky Frame's PSRAM
is on plain SPI and cannot be memory-mapped (`embedded/pico/README.md`) — and
since 2026-09-19 it is a complete one: `usb_api` provisioning from the deploy
panel, setup hotspot + captive portal, settings pull, device HTTP API + mDNS,
log ring + upload, unchanged-frame refresh skip, battery sleep, signed release
UF2s that the backend lists and serves. The four items that used to be here
(stale http-only comment, chunked responses, SSIDs with spaces, sub-minute
sleep) are fixed and host-tested. Still open:

- **Hardware: half the checklist.** Steps 1–6 of the README's "First
  power-on checklist" pass on an Inky Frame 7.3" Spectra 6 (2026-10-21:
  USB provisioning from the drawer, setup screen, render, unchanged-frame
  skip, device API, rotation, scene switch, preview and deploy from the
  backend). Not yet run: battery sleep and restart-on-battery (7–8), an
  `https://` backend with the 16 KB stack under a TLS handshake (9), a
  Pico W board, the 4.0" / 5.7" panels.
- **No command queue.** The backend pushes events, scene switches, previews
  and deploys to the Pico's HTTP server (`embedded_frame_pulls_commands` is
  false for the `pico` family). Its scenes and state already live on the
  backend, so a push only asks it to render now, and a board asleep on
  battery shows the change on its next wake; what it misses is the "waiting
  for the frame" bookkeeping an ESP32 gets. A queue client
  (`POST /embedded/commands`, `render` and `reboot` are the verbs that mean
  anything here) is also what a cloud link would carry.
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
