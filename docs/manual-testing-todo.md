# Manual testing todo — pre-release sweep (compiled 2026-08-20, refreshed 2026-09-02)

Everything below shipped with green automated suites but an unticked manual
checkbox, or a "Not verified — needs hardware" note. Releases since
v2026.8.31 carry most of it; anything merged after the last release needs
firmware/images built from `main`. **Tick items as they pass; delete
sections when empty; delete the file when done.**

Suggested order: §1 is done, so one Pi session covering §2+§3 (those tests
share a bench), then one ESP32 session for §4. The riskiest untested
surfaces left are the Pi-side items no bench has run since their PRs
(DNSSEC-off enrollment from a composed SD card, scheduled reboot, the
hardware-settings batch) and the battery ADC rounds of #426.

## 1. Browser only — cloud auth (no hardware, ~30 min)

- [x] **2FA end-to-end (#377):** passed 2026-08-20 — enrolled TOTP + passkeys,
  signed out; direct passkey sign-in on `/login` worked; Google sign-in
  correctly demanded a second factor (passkey or TOTP).
- [x] **Activity panel (#377):** passed 2026-08-20 — account activity feed
  populates with sign-ins (google, passkey), passkey added, TOTP enabled
  (with IPs) and frame `connection_lost` events.
- [x] **Re-auth click-through (#378):** passed 2026-08-20 — revoke on the
  backends page → `/login/reauth` → proof accepted → back on the page. Found
  and fixed: the revoke itself was *not* replayed after returning (the user
  had to find the button and confirm again). Revoke/install-revoke buttons
  now stash the pending action and finish it on return; a Cancel on the
  reauth page leaves the frame untouched. Re-check once deployed: after the
  proof the frame should show as revoked without a second click.
- [x] **Two-tier re-auth windows (#382):** verified from code 2026-08-20
  rather than the clock: `recent-auth.ts` has 15 min (`requireRecentAuth`
  default → `/api/frames/{id}/revoke`, `/api/device/revoke`) and 2 h
  (`recentApprovalMaxAgeSeconds` → `/api/device/authorize` + the `/device`
  page pre-check); both branches are pinned by
  `reauth.integration.test.ts` ("approving rides the wider window; revoking
  does not", session aged 20 min). Note: `/api/frames/{id}/confirm`
  (pending → active frame) has no re-auth gate at all by design — the
  2 h window is for device-link/scope approvals, not frame confirm.

## 2. Pi / Buildroot bench — cloud-managed frames

- [x] **Auto-confirm enrollment (#382):** passed 2026-08-22 — a Pi Zero 2 W
  SD card (v2026.8.33, HDMI/framebuffer, WiFi + passwordless sudo) from
  cloud.frameos.net booted and the workspace showed "Frame “uus2w” joined.
  Open frame" with no Confirm step. The HDMI panel said "standalone (no
  server configured)" for a few minutes before flipping to "FrameOS Cloud
  (cloud.frameos.net, connected) / Remote control enabled over HTTPS" — the
  index scene only refreshed on its 5-minute interval. Fixed on
  `cloud-admin-overhaul`: the system screens re-render on every cloud link
  change, and the whole boot (network check included) now draws on HDMI.
  Both gaps from that boot are fixed on the branch (browser time zone +
  slugified name ride `frameos-cloud.txt` into `frame.json` / `/etc/hostname`).
- [ ] **Re-flash check (this branch):** HDMI boot screen draws during the
  network check; `frame.json` ends up with the display's native mode (4K on
  a Pi 4/5, 1080p on a Zero 2 W) and the cloud workspace shows it; panel
  says the cloud frame name + Europe/Brussels; hostname is the slugified
  name; a scheduled 01:02 reboot logs `scheduler:fire` at 01:02 *local*.
- [ ] **HDMI status screen, animated (this branch):** on a framebuffer
  frame the mark's three squares cycle the brand colours during the boot
  network check and on `system/index` (no scenes); `top` on the Pi should
  show frameos well under a core — the frame rate is paced to ~20% duty
  (`render_stats.pacedRenderInterval`), so a Zero 2 W at 1080p steps every
  second or two while a Pi 5 glides. The index screen shows a live clock
  (seconds on HDMI, minutes elsewhere) and, after a GPIO press, "Last
  button: <label> (GPIO n) at hh:mm:ss" in the grey bottom band.
- [ ] **Cloud SD card with SSH keys (this branch, needs a buildroot release
  image built from it):** add a key under Settings → SSH Keys on the cloud,
  tick it in the SD image builder, boot the card → `ssh root@<frame>` works
  with that key. Older images log "Ignoring unknown key 'authorized_key'"
  and boot without it.
- [ ] **ESP32 time zone (#388 + #416, needs firmware built after
  2026-08-30):** set Europe/Brussels from the cloud settings panel → weather
  scene hours match local time (a code node's `format()` too), schedule
  entries fire in local time, `config` on the console shows it.
- [ ] **First-boot cloud enrollment on a router that strips DNSSEC (#384,
  #420):** 2026-08-20 a Pi 5 card booted, joined WiFi, then every lookup
  failed with `systemd-resolved: DNSSEC validation failed ... no-signature`;
  the 30 s network check expired, the setup hotspot took over and the frame
  never enrolled. #384 added the `DNSSEC=no` drop-in, a 90 s window and
  `frameos set-display` for the cloud-chosen display — but the drop-in was
  only staged by the full base-image build, so SD cards composed from a
  cached base kept validating (a Pi Zero W hit it again on 2026-08-30).
  #420 stages it on both build paths and `frameos setup` retrofits it on
  every deploy/OTA. The diagnosis is confirmed on the affected frame (the
  drop-in applied by hand healed it); the fixed image is hardware-unverified.
  Re-flash from `main`, boot behind the GL-BE3600, confirm: enrolled within
  ~1 min, no hotspot, `frame.json` carries the chosen device, postboot log
  shows `Applied display device`.
- [ ] **Panel link code (#379):** boot an unclaimed frame in cloud mode with
  no claim code → the panel renders the link code + QR → complete the claim
  from an account, and confirm the code retires once connected.
- [ ] **Scheduled reboot on Pi (#376):** add a `reboot` schedule entry from
  the cloud and watch a real Pi reboot at the scheduled time. Floor is
  2026.8.32 — needs the new firmware.
- [ ] **Hardware settings batch (#374):** push palette / partial-refresh
  `device_config` / `gpio_buttons` from the cloud panel → runtime restarts
  (not just reloads) and the settings apply. Also confirm the panel only
  shows fields the reported hardware can use, and shows disabled-with-reason
  on pre-2026.8.31 firmware.
- [ ] **Generic image still adopts with no Remote on it (`docs/buildroot-privileges.md` §4):**
  release images no longer ship FrameOS Remote at all — flash a *generic*
  Buildroot card, adopt it into a self-hosted backend, and verify the
  backend's first deploy installs and enables the remote itself
  (`deploy_remote` uploads the binary and unit; `frameos setup` enables it)
  and that everything works after. The deploy also flips the frame back to
  a root `frameos.service`, so check the unit's `User=` before and after.

## 2b. Privilege separation bench (`docs/buildroot-privileges.md` §4)

Nothing below has run on hardware. Flash a **fresh generic
`raspberry-pi-64` release image** unless a step says otherwise.

- [ ] **It boots and renders as `frameos`.** `systemctl show -p User
  frameos.service` says `frameos`, `ps -o user= -C frameos` agrees, and a
  scene renders. Check the panel you have: framebuffer (Pi 5 / HDMI) and at
  least one SPI e-ink (Waveshare 7.5" or 13.3E, Inky) — the SPI path is the
  one most likely to trip on `/dev/spidev*` or `/dev/gpiochip*` permissions.
  `DEV_Config.c` falls back to *bit-banged* SPI when it cannot open spidev,
  so a panel that works but refreshes slowly means the group is wrong; look
  for that, do not just trust a picture.
- [ ] **The GPIO button and evdev input still fire** (groups `frameos` /
  `input`), and the framebuffer console is claimed (no getty text over the
  image — that is `CAP_SYS_TTY_CONFIG` working).
- [ ] **The door answers.** `journalctl -u frameos-privileged` after a
  reboot from the cloud/admin ("Reboot" button): one `executing reboot` line,
  then the reboot. `systemctl status frameos-privileged.path` is active.
- [ ] **Hotspot and portal through the door.** Boot with no Wi-Fi
  credentials → `FrameOS-Setup` hotspot appears, the portal lists networks,
  joining one works and survives a reboot. Every one of those is an
  `nm-*` verb now; the journal shows them.
- [ ] **OTA from a root-only release (the migration).** Flash an image from
  the *previous* release, let it enroll, then trigger "Upgrade FrameOS".
  Expect: the upgrade succeeds, `/etc/passwd` gains `frameos:x:990:990`,
  the installed unit becomes the hardened one, `/srv/frameos` ownership is
  root-code/`frameos`-state, and the frame renders after the restart.
- [ ] **OTA on an already-migrated frame** (unprivileged → door →
  `install-release`): the status file goes `running` → `success`, the log
  shows the signature verified *twice* (once unprivileged, once as root),
  and the frame comes back on the new version.
- [ ] **The runtime cannot escalate.** As `frameos` on the device (`su -s
  /bin/sh frameos`): writing `/srv/frameos/current/frameos` fails, writing
  `/etc/systemd/system/frameos.service` fails, and a queue file with
  `{"id":"manual-shell","verb":"shell","args":{}}` is refused in the
  journal rather than run. Also verify
  `stat -c '%U:%G %a'` reports `root:frameos 1770` for `state`, `logs`,
  `staging`, and `privileged/queue`, `root:frameos 2750` for
  `privileged/results`, and that neither a hostile result-path symlink nor a
  runtime-created `scenes/*.so` is followed by the root worker. After joining
  Wi-Fi, confirm `journalctl -u frameos-privileged` does not contain the PSK.

## 3. Backend (self-hosted) bench

- [ ] **Adopt a running standalone frame (#380):** point the backend at a
  real standalone Pi → full adopt: scene imports, API-key takeover,
  credential push, frame keeps rendering afterwards. Unit-tested (107 pass)
  but never run against real hardware.

## 4. ESP32 bench

- [ ] **C3 render-failure counting (#368):** flash a C3 (XTEINK X4), make
  the server unreachable, force two failed renders → **no reboot, no pause**
  (previously every failure counted as a PSRAM rescue). Then OTA a
  currently-paused C3 → it comes up rendering. Eyeball the new `heap ...`
  lines on X4 boot.
- [ ] **Thin-client framebuffer reserve (#366):** in the X4 boot log, find
  `framebuffer reserved: 96000 bytes held for the panel, N internal bytes
  left` — N should land near 190 KB, and a frame that previously OOMed
  should now render.
- [x] **E1004: scenes over USB after a flash (this branch):** verified on
  the bench 2026-08-26. The board ships `deep_sleep_on_battery=1` and has
  no VBUS sense (cell at 4.17 V = "on battery"), so it deep-slept right
  after its first render — mid `upload-scenes` handshake, which then timed
  out and the CH340 vanished. Every console line now arms the 3-minute
  keep-awake HTTP mutations already use (`fos_console.c`); with the fixed
  build `usb_api upload-scenes` answered `__FRAMEOS_USB_READY__` well after
  `render:done`. Re-check the full browser flow (flash → push scenes) once
  a release carries it.
- [x] **reTerminal E1004 first light (#375):** passed 2026-08-26 in #398,
  debugged over serial on the board — the T133A01 refresh completes (CCSET
  before DTM), a streamed 1.67 MB gallery PNG rendered and the panel
  updated; the frame has run the Weather scene on a 15-minute cycle since.
- [x] **1200×1600 PSRAM low-water measurement (#375):** taken in #428 on
  2026-09-01 on the 8 MB board — low-water free PSRAM was 34 KB with the
  transpiler's three token copies alive and 873 KB after the fix; the
  1.5 MiB reserve stands.
- [ ] **Battery ADC rounds (#426):** hardware-unverified. The misread is
  intermittent (~9 of the E1004's ~400 daily on-battery samples read
  ~2 V instead of ~3.95 V), so confirming it means watching
  `batteryRawMillivolts` appear without `batteryMillivolts` moving for a
  day or two on a frame on battery, and no spurious "critical" parking.
- [ ] **Sleep-aware cloud side (#409):** the device half was captured over
  three boots on the E1004; the hub half — the frame's `render`
  announcement → a queued `image_get`, and command TTLs stretched past
  `next_wake_at` — was not exercised before deploy. On a deep-sleeping
  E1004: the fleet tile's image updates after a wake, and an `image_get`
  queued mid-sleep survives the 15-minute nap instead of expiring.
- [ ] **Scheduled reboot on ESP32 (#376):** same schedule-entry test as the
  Pi, on a board.
- [ ] **WPA2 provisioning AP (#443):** erase Wi-Fi on a board → the portal
  screen shows "Wi-Fi: FrameOS-XXXX" and a "Password:" line; a phone joins
  with it (WPA2, no PMF prompt) and reaches the portal; `config` over USB
  prints the same `ap_psk`; `set ap_psk ""` mints a new one at the next
  portal start. Then confirm the backend's frame sync shows no "changed on
  frame" for Wi-Fi password / admin password / API key after a deploy (the
  device now answers `""` for them).
- [ ] **Layout-matched release image (#442; release 2026.9.2 carries the
  six images):** on the XTEINK X4 (16 MB C3), "Flash latest release" picks
  `esp32-c3-16mb`, the "4MB layout / no OTA" warnings are gone, the board
  boots and later takes an OTA; on a 13.3E6 (32 MB S3) the same with
  `esp32-s3-32mb`.
- [ ] **The backend flashes what the cloud flashes (needs firmware built
  after 2026-09-03):** on a blank board, "Flash latest release" from the
  self-hosted deploy drawer provisions everything — `status` shows the
  hostname, `admin_auth: enabled`, and after the first settings sync the
  `https:` line says `cert=yes key=yes` (with HTTPS enabled on the frame)
  and the API answers on 8443; "Apply frame settings" under USB setup
  replays the same plan on a board flashed by hand with esptool. Then
  "Update over the air" / Full deploy: the log shows `ota:backend`
  `downloading … verified`, the board reboots into the release, and a
  second request answers `up-to-date`. Finally a board still on a
  per-frame image from before this change must OTA onto the release image
  from the new manifest (the legacy `sha256` field) and verify from then on.
- [ ] **Cloud flasher picks the layout (follow-up to #447):** on a 16 MB
  XIAO the cloud "Connect & flash" log says `Flash size 16MB: using the
  esp32-s3-16mb image built for that layout`, the board boots, and its first
  OTA check asks for `platform=esp32-s3-16mb`. On an 8 MB board it stays on
  `esp32-s3-generic`. Also: "Flash latest release" / "Apply frame settings"
  against a board still on 2026.9.2 firmware logs "does not know hostname
  yet" and finishes instead of stopping there.
- [ ] **Dual console — reTerminal E1002 over its CH340:** the cloud flasher
  on the "USB Single Serial" port must flash, see `frameos>` and provision
  (this board has no USB-Serial/JTAG port at all). Then on a XIAO ESP32-S3
  confirm the "USB JTAG/serial debug unit" path still provisions and that
  `usb_api` uploads/previews work there. Partial pass 2026-08-26: frame 59
  (13.3E6) answered `frameos>` + `status` over its CH343 "USB Single Serial"
  port with a locally built image; opening that port through pyserial/WebSerial
  resets the chip (DTR/RTS auto-reset circuit), so open once with DTR/RTS
  low and keep the port open while waiting for the prompt.

## 5. Older pending hardware item

- [x] **13.3" E hardware SPI fix:** closed 2026-08-22 — frame 62 was built,
  delivered and worked on the `spi0-0cs` dual-CS overlay; the frame is long
  gone, nothing left to validate.

## 6. CI / the release itself

- [x] **EPYC runner pool (#381):** several **FrameOS cross compilation**
  runs have gone through the self-hosted pool since (latest 2026-08-21,
  success).
- [x] **The release run is a test (#381):** `docker-publish-multi` has run
  twice since #381 (2026-08-20, both success) — `epyc-32` and the Depot
  esp32-ci path are validated.
- [x] **First release after #442 + #444:** release 2026.9.2 (2026-09-03)
  carries the six per-layout ESP32 images with signatures and the signed
  wasm bundle. Still to eyeball: the npm publish downloaded the bundle and
  the cloud preview shows "runtime 2026.9.2".

## Not on the list, deliberately

- PR #351's lone `- [ ] CI` box — CI has run dozens of times since; stale.
- #371 (thin-client dithering), #367 (chunked uploads), #364/#365, #369/#370
  — landed with fully-ticked test plans and no outstanding manual items; the
  C3/X4 session in §4 exercises the dithering and chunked-upload paths
  incidentally.
