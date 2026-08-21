# Manual testing todo — pre-release sweep (compiled 2026-08-20)

Everything below shipped with green automated suites but an unticked manual
checkbox, or a "Not verified — needs hardware" note. PRs #374–#382 are all
unreleased on top of v2026.8.31, so the hardware tests need firmware/images
built from `main`. **Tick items as they pass; delete sections when empty;
delete the file when done.**

Suggested order: §1 first (pure browser), then one Pi session covering §2+§3
(those tests share a bench), then one ESP32 session for §4, and schedule the
release so §6 can be watched live. The riskiest untested surfaces are the
E1004 panel init (never touched hardware) and the enrollment auto-confirm
flow (changes first-boot behavior for every new user).

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
- [ ] **ESP32 time zone (needs 2026.8.34 firmware):** set Europe/Brussels
  from the cloud settings panel → weather scene hours match local time,
  schedule entries fire in local time, `config` on the console shows it.
- [ ] **First-boot cloud enrollment on a router that strips DNSSEC (PR #384):**
  2026-08-20 a Pi 5 card booted, joined WiFi, then every lookup failed with
  `systemd-resolved: DNSSEC validation failed ... no-signature`; the 30 s
  network check expired, the setup hotspot took over and the frame never
  enrolled. Fixes: `DNSSEC=no` drop-in on the image, 90 s check window, and
  the cloud-chosen display is now applied by `frameos set-display` (the
  python3 patcher never ran — Buildroot ships no python3; the log said
  `could not apply display device 'http.upload'`). Re-flash from `main`,
  boot behind the GL-BE3600, confirm: enrolled within ~1 min, no hotspot,
  `frame.json` carries the chosen device, postboot log shows
  `Applied display device`.
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
- [ ] **Generic image still adopts with Remote off (#362, `docs/todo.md`):**
  release images ship `agentEnabled: false` — flash a *generic* Buildroot
  card, adopt it into a self-hosted backend, verify the backend's first
  deploy transparently enables FrameOS Remote (`frameos setup` does the
  `systemctl enable`) and everything works after.

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
- [ ] **reTerminal E1004 first light (#375):** a real render on the E1004 —
  the T133A01 init/tuning values came from the vendor driver via ESPHome and
  have never touched hardware; failure mode is ghosting or a failed refresh,
  not a brick.
- [ ] **1200×1600 PSRAM low-water measurement (#375):** on the 8 MB board —
  the 1.5 MiB reserve was sized at 800×480 and this is the number the PR
  says to take first.
- [ ] **Scheduled reboot on ESP32 (#376):** same schedule-entry test as the
  Pi, on a board.

## 5. Older pending hardware item

- [ ] **13.3" E hardware SPI fix:** validation still pending on frame 62
  (`spi0-0cs` dual-CS overlay; do not claim GPIO 10/11). Close out now if
  frame 62 is on the release path.

## 6. CI / the release itself

- [ ] **EPYC runner pool (#381):** trigger (or watch the next) **FrameOS
  cross compilation** run and confirm the 6 `epyc-8` legs get picked up by
  the self-hosted pool rather than queueing.
- [ ] **The release run is a test (#381):** the first real
  `docker-publish-multi` after #381 validates `epyc-32` and the Depot-built
  esp32-ci path — babysit the release workflow rather than fire-and-forget.

## Not on the list, deliberately

- PR #351's lone `- [ ] CI` box — CI has run dozens of times since; stale.
- #371 (thin-client dithering), #367 (chunked uploads), #364/#365, #369/#370
  — landed with fully-ticked test plans and no outstanding manual items; the
  C3/X4 session in §4 exercises the dithering and chunked-upload paths
  incidentally.
