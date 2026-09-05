# Manual testing todo

Everything here shipped with green automated suites but needed a bench.
**Open** lists every box still unticked, grouped by bench; **Done** keeps the
evidence for what passed, in the original section order, because the open
boxes point into it. Tick a box by moving its entry from Open to the matching
Done section with the date and what was seen; delete the file when Open is
empty. Last refreshed 2026-09-05 after release 2026.9.8.

## Open

### Pi / Buildroot bench — cloud-managed frames

- [ ] **Generic image still adopts with no Remote on it (`docs/buildroot-privileges.md` §4):**
  release images no longer ship FrameOS Remote at all — flash a *generic*
  Buildroot card, adopt it into a self-hosted backend, and verify the
  backend's first deploy installs and enables the remote itself
  (`deploy_remote` uploads the binary and unit; `frameos setup` enables it)
  and that everything works after. The deploy also flips the frame back to
  a root `frameos.service`, so check the unit's `User=` before and after.

- [ ] **uus2w `/etc/timezone` after the next release (661abf5d):** on 2026.9.8
  it still reads `Etc/UTC` because `setupTimezone` returned at "already
  Europe/Brussels" before the sync ran (fixed on main: the early return syncs
  too). After the OTA: `cat /etc/timezone` on uus2w says `Europe/Brussels`.

- [ ] **Door-upgrade device half (50fcbcc2) at the next OTA from 2026.9.8:**
  on a door frame (uus2w, Cloud-5) the `"status":"scheduled"` line must
  follow `cloud:updateAvailable` within a second and the hub must log no
  `device.heartbeat_timeout` for it. The 9.7 → 9.8 OTA could not show this —
  the 9.7 binary ran it and uus2w still timed out once. Hub half (no
  redelivery) is already verified, see the 2026.9.8 entry below.

### Privilege separation bench (`docs/buildroot-privileges.md` §4)

Bench context (frames, what each step is for, the door's design) is in the
Done section for this bench below.

- [ ] **7. Regressions:** deploy from localhost:8616 to one Waveshare frame
  (still root, still renders); after the HA add-on has the 9.3 image, deploy
  to one HA frame. Neither should have a `frameos` user or the door active.

- [ ] **9. Afterwards:** tick the boxes here, move anything that broke into
  `docs/todo.md`, and delete this section once everything passed. If a
  migrated frame ends up unusable, reflash it with the 9.3 image — the
  FRAMEOS partition layout is stamped by the composer, so a fresh card is
  always the known-good state.

### Backend (self-hosted) bench

- [ ] **Adopt a running standalone frame (#380):** point the backend at a
  real standalone Pi → full adopt: scene imports, API-key takeover,
  credential push, frame keeps rendering afterwards. Unit-tested (107 pass)
  but never run against real hardware.

### ESP32 bench

- [ ] **C3 render-failure counting (#368):** flash a C3 (XTEINK X4), make
  the server unreachable, force two failed renders → **no reboot, no pause**
  (previously every failure counted as a PSRAM rescue). Then OTA a
  currently-paused C3 → it comes up rendering. Eyeball the new `heap ...`
  lines on X4 boot.

- [ ] **Thin-client framebuffer reserve (#366):** in the X4 boot log, find
  `framebuffer reserved: 96000 bytes held for the panel, N internal bytes
  left` — N should land near 190 KB, and a frame that previously OOMed
  should now render.

- [~] **Battery ADC rounds (#426):** day 1 of the watch, 2026-09-05 00:00 UTC: E1004's 96 samples over the previous 24 h (15-min naps, 2026.9.6) sit at 3988–4020 mV, drifting down ~30 mV over the day, `onBattery: true` on every one, **no `batteryRawMillivolts` on any sample**, no critical parking. At the old ~2 % misread rate ~2 rejected reads were due in 96 samples, so zero is either the fix filtering silently or chance (p≈0.14) — needs the second day. The board moved to 2026.9.7 at 00:02 UTC; keep counting from there. Earlier: partial 2026-09-04 — E1004's 45 metrics samples since midnight (3.3 h of them on 2026.9.4) show `batteryMillivolts` steady at 4006–4020 mV, no `batteryRawMillivolts` field on any sample, no critical parking. Needs the day-or-two watch below to count as verified. Original text: hardware-unverified. The misread is
  intermittent (~9 of the E1004's ~400 daily on-battery samples read
  ~2 V instead of ~3.95 V), so confirming it means watching
  `batteryRawMillivolts` appear without `batteryMillivolts` moving for a
  day or two on a frame on battery, and no spurious "critical" parking.

- [ ] **Layout-matched release image (#442; release 2026.9.2 carries the
  six images):** *(2026-09-04: E1002 is still on the generic 8 MB layout —
  `flashBytes 8388608`, `otaSlotBytes 3604480`, OTA check asks for
  `esp32-s3-generic`; "Update firmware" keeps whatever layout the board has,
  so only "Add frame" → Connect & flash exercises this. The 8 MB half of the
  USB *update* path passed on 2026.9.5 — see the dual-console box.)* on the XTEINK X4 (16 MB C3), "Flash latest release" picks
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

- [ ] **E1004 first render after a cold boot (2026.9.8):** the 02:36 render
  fills the hourly cell, but the cloud capture of the very first render after
  the OTA reboot (02:06, ~30 KB less PSRAM headroom) still showed the small
  chart. Catch one cold boot (a battery swap or a reset) and check the first
  render's capture; if it is small, look for a `render:degraded` line with
  `"source":"svg"` — its absence would mean both rungs refused silently.

- [ ] **Portal SSID field keeps grabbing focus (recorded 2026-09-04, not
  fixed):** re-check the hotspot portal from a normal browser tab rather than
  a phone's captive-portal helper; nothing in the page sets focus, so the
  helper is the suspect. Details in the WPA2 provisioning AP entry below.

## Done

### Browser only — cloud auth

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

### Pi / Buildroot bench — cloud-managed frames

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

- [x] **Re-flash check (this branch)** — PASSED on attempt 2, 2026-09-04 19:41 local, on the cloud-composed 2026.9.6 `raspberry-pi-64` card: first boot read `frameos-cloud.txt` (`Installing NetworkManager WiFi connection from cloud personalization`, `Setting hostname from cloud personalization: uus2w`, `Applied display device 'framebuffer' to frame.json`, `Installing authorized keys`, `Wrote cloud enrollment state`), `networkCheck attempt 1 success`, `cloud:enroll:boot` → `cloud:enroll:personalization` applied `{name: uus2w, timezone: Europe/Brussels}` → `cloud:hub:connected`; the SAME frame record re-adopted (no duplicate). `frame.json` = framebuffer 1920×1080, `hostname` = `uus2w`, the workspace shows it on 2026.9.6 / Europe/Brussels, and the user confirmed the panel itself shows Europe/Brussels on the index screen (the runtime's own zone from frame.json — which is why the `/etc/localtime` finding below was invisible from the panel). Scheduled reboot: a `reboot` entry at 19:49 Europe/Brussels pushed from the cloud → `scheduler:loaded entries 1 nextDue Fri 19:49 reboot` → `scheduler:fire id bench-reboot action reboot localTime 2026-09-04 19:49 timeZone Europe/Brussels` at 17:49:00 UTC → `Rebooting the device` → `bootup` 25 s later, `/` now `ro`, `scheduler-last-fired` persisted (nextDue moved to *Sat* 19:49, no re-fire in the same minute). **Found and fixed on main the same evening (needs the next release):** the runtime's post-enrolment `timedatectl set-timezone` runs as uid 990 under `NoNewPrivileges` → `sudo: The "no new privileges" flag is set` → `/etc/localtime` stayed `Etc/UTC` although frame.json, the scheduler (`scheduler:loaded timeZone Europe/Brussels`) and the cloud all say Europe/Brussels; anything reading the OS zone (journal stamps, QuickJS `Date` in scenes) is on UTC until a root `frameos setup` (an OTA) runs. Now a `set-timezone` door verb (`setupTimezone` asks the door when not root; `test_setup.nim`, `test_privileged.nim`, verb table in `docs/buildroot-privileges.md`). **Verified on 2026.9.7, 2026-09-05 01:20-02:25 local on uus2w** (OTA'd 9.6 → 9.7 by the user, then over SSH): the 9.7 OTA's root `frameos setup` set `/etc/localtime` → `Europe/Brussels` at 01:20:23 (`FrameOS setup: checking timezone` → `timedatectl set-timezone` as uid 0), and the door verb itself was then exercised on the path that actually failed — a cloud `set_settings` `{timezone: Europe/Helsinki}` reached the uid-990 runtime, which logged `FrameOS setup: timezone: set Europe/Helsinki through the privileged door` after `FrameOS privileged: executing set-timezone (1788564295693-…)` / `set-timezone ok in 1.60s` in the root worker; `/etc/localtime` flipped, `date` read `EEST`, `scheduler:loaded timeZone Europe/Helsinki` followed, and a push back to Europe/Brussels did the same in reverse (frame left on Brussels). **Minor, fixed on main 2026-09-05 (`baee5f85`, needs the next release):** `/etc/timezone` still read `Etc/UTC` on both paths — `setupTimezone`'s `timedatectl` branch returns before the `withWritableMount` block that writes it, so only the no-timedatectl fallback keeps that file in step (`lib/tz.nim` only falls back to it when `/etc/localtime` cannot be read, so nothing on the frame is wrong today). **The enrolment half then passed on a fresh card, 2026-09-05 01:38-01:40** (uus2w reflashed with the cloud-composed 2026.9.7 `raspberry-pi-64` image): first boot came up with `frame.json` still on `timeZone: UTC` (the `bootup` line at 01:38:58), `networkCheck attempt 1 success`, `cloud:enroll:boot ok` → `cloud:enroll:personalization {name: uus2w, timezone: Europe/Brussels}` → the uid-990 runtime asked the door (`FrameOS privileged: executing set-timezone …` / `set-timezone ok in 1.53s`) → `FrameOS setup: timezone: set Europe/Brussels through the privileged door` → `/etc/localtime` → `Europe/Brussels`, `date` = CEST, panel shows Europe/Brussels. No sudo refusal anywhere in the boot. The rest of that boot, same card: `frameos-firstboot-setup.service` `Result=success` / `ExecMainStatus=0` with no `frameos-setup.json` left behind (the `daemon-reload` failure did not recur; it succeeded first try, so the retry itself was not exercised), `/etc/systemd/resolved.conf.d/10-frameos.conf` present with a compose-time stamp (2026-09-04 23:50:21, before first boot) and **zero** `DNSSEC` lines in `journalctl -b`, `User=frameos` / `Uid: 990` / `Groups: 28 108 990` / `CapEff: …04000000`, hostname `uus2w` through the `set-hostname` verb, the same frame record re-adopted (no duplicate, workspace shows 2026.9.7 / Europe/Brussels), `system/index` rendering 165-167 ms once a second. `/etc/timezone` still reads `Etc/UTC` on this card, as expected — the fix for that is on main, not in 2026.9.7. *(attempt 1, 2026-09-04 18:48: the
  card came up "standalone", no cloud, no scenes — because it had been flashed
  with `~/Downloads/frameos-5-raspberry-pi-64-lpoollssypuv 2.img`, the
  self-hosted HA backend's 2026.9.0 image for "Vannituba" (hyperpixel2r
  480×480), not the cloud download. The cloud image
  `frameos-raspberry-pi-64-uus2w-2026.9.6.img.gz` was opened on the Mac and
  its 4096-byte region is correctly patched: claim_token, name=uus2w, wifi,
  wifi_country=GB, device=framebuffer 1920×1080, time_zone=Europe/Brussels,
  one authorized_key. Found in that wrong card's `frameos-setup-reset.log`
  and fixed on main the same evening: first-boot setup aborted at
  `systemctl daemon-reload` with exit -1 (our timeout/spawn code, ~100 s into
  boot while systemd was still starting tmpfiles/resolved/timesyncd) and
  `frameos-firstboot-setup.service` ended `failed` with
  `frameos-setup.json` left on the card — `setup.nim` ran that one
  `daemon-reload` fatally while every sibling call tolerated failure. Now
  `runSetupCommandRetrying` (3 attempts, 2 s apart, tests in
  `test_device_setup.nim`) wraps both `daemon-reload` and `systemctl enable`.
  Re-flash with the `.img.gz` and run the box as written; a release after
  2026.9.6 carries the retry.)* HDMI boot screen draws during the
  network check; `frame.json` ends up with the display's native mode (4K on
  a Pi 4/5, 1080p on a Zero 2 W) and the cloud workspace shows it; panel
  says the cloud frame name + Europe/Brussels; hostname is the slugified
  name; a scheduled 01:02 reboot logs `scheduler:fire` at 01:02 *local*.

- [x] **HDMI status screen, animated (this branch)** — passed 2026-09-04 on
  uus2w (2026.9.6, Zero 2 W, 1080p HDMI, no scenes assigned so it sits on
  `system/index`). **Eyeballed by the user on the panel:** the mark's squares
  cycle colour every second and the clock ticks live. **Measured over SSH:**
  `render:done sceneId system/index` once a second at 165-182 ms scene +
  ~372 ms framebuffer write, and `top` put the runtime at 14-23% of one core
  across two samples on a 4-core board — well under a core, as the box
  expects. Not covered: the "Last button: <label> (GPIO n)" band, which needs a
  button fitted (uus2w has none — same wire caveat as the GPIO/evdev box in
  §2b). Original text: on a framebuffer
  frame the mark's three squares cycle the brand colours during the boot
  network check and on `system/index` (no scenes); `top` on the Pi should
  show frameos well under a core — the frame rate is paced to ~20% duty
  (`render_stats.pacedRenderInterval`), so a Zero 2 W at 1080p steps every
  second or two while a Pi 5 glides. The index screen shows a live clock
  (seconds on HDMI, minutes elsewhere) and, after a GPIO press, "Last
  button: <label> (GPIO n) at hh:mm:ss" in the grey bottom band.

- [x] **Cloud SD card with SSH keys** — passed 2026-09-04 19:43 on the fresh uus2w card: the cloud-account RSA key ticked in the SD builder rode `authorized_key=` in `frameos-cloud.txt` (`Installing authorized keys from cloud personalization`) and `ssh root@10.8.0.62` from the Mac's agent worked at once; the image ships dropbear's host key under `/srv/frameos/state/dropbear/` (the hand fix from step 5, now in the release). Original text: (this branch, needs a buildroot release
  image built from it): add a key under Settings → SSH Keys on the cloud,
  tick it in the SD image builder, boot the card → `ssh root@<frame>` works
  with that key. Older images log "Ignoring unknown key 'authorized_key'"
  and boot without it.

- [x] **ESP32 time zone (#388 + #416)** — closed 2026-09-04: the word-clock and weather scenes have run around the house on the 2026.9.x releases with correct local time (user-verified), which covers the scene-hours half; the console/scheduler half below. Original 2026-09-04 note on 2026.9.4: console `status` on E1002 shows `time_zone: Europe/Brussels` / `tz_data: CET-1CEST,M3.5.0,M10.5.0/3`; a schedule entry on Wood7.3 fired at 12:53 *local* (`schedule:fire hour 12 minute 53` at 10:53 UTC). Not eyeballed: weather-scene hours and a code node's `format()` (E1004, the weather frame, has no zone set). A private "Time zone check" scene (code node: `format(now(), "{hour/2}:{minute/2}:{second/2}")` + `Date` UTC on one text node; server preview showed 15:04 local / 13:04 UTC) was installed and activated on E1002 at 13:05 UTC 2026-09-04 while the board slept; after a button wake it rendered at 13:24:13 UTC and the panel capture read `Local (format): 15:24:13` / `UTC (Date): 13:24:13` — the code node's `format()` is on Europe/Brussels on the device (2026.9.4). Original text (needs firmware built after
  2026-08-30): set Europe/Brussels from the cloud settings panel → weather
  scene hours match local time (a code node's `format()` too), schedule
  entries fire in local time, `config` on the console shows it.

- [x] **First-boot cloud enrollment on a router that strips DNSSEC (#384,
  #420)** — closed 2026-09-04 19:41 on the fresh uus2w card composed from 2026.9.6: `/etc/systemd/resolved.conf.d/10-frameos.conf` present with a compose-time stamp (2026-09-04 15:28:15 UTC, before first boot), `journalctl -b | grep -c DNSSEC` = 0 on both the first and the second boot, `networkCheck attempt 1 success`, enrolled within seconds, no hotspot. Earlier half: half verified 2026-09-04 on the Zero W `Cloud-W`
  (`raspberry-pi-32`, 2026.9.2 card composed 2026-09-03 from the 2026.8.33
  cached base): network check passed on attempt 7 (23 s of 30 s, all
  station-repair retries), enrolled 2 s later, personalization applied
  (name, Europe/Brussels, hostname `cloud-w`, `Applied display device
  'framebuffer'`), no hotspot. **But the card did not ship the resolver
  drop-in**: `/etc/systemd/resolved.conf.d/10-frameos.conf` only appeared at
  00:40 from the first OTA's `frameos setup`, and the first-boot journal has
  42 `DNSSEC validation failed … signature-expired` lines (the Zero W's clock
  was still at 2025-06 — the router-strips-RRSIG case reads `no-signature`).
  Cause: `_patch_root_partition` staged both drop-ins but its debugfs write
  list never included them, so only fresh base builds (rootfs overlay) had
  them. Fixed on main 2026-09-04 (the compose path now writes the resolver
  and `network.service` drop-ins; `test_buildroot_image.py` pins it). Still
  to verify on a card composed after that fix: drop-in present at first boot
  (`ls -la --time-style=full-iso /etc/systemd/resolved.conf.d`), zero
  `DNSSEC` lines in `journalctl -b`. The other Zero W (2026-08-30) also
  recovered on its own later, consistent with `allow-downgrade` eventually
  coping — the drop-in is belt and braces, not the only thing between a
  frame and the cloud.

- [x] **First-boot driver setup actually runs** — passed 2026-09-04 19:41 on the fresh uus2w card (framebuffer): `Running driver setup for device 'framebuffer'` → `FrameOS setup: driver setup: starting` → `FrameOS setup: driver setup: complete`, no `cannot open: ./frame.json`. The SPI-panel half (`dtoverlay`/`dtparam` in `/boot/config.txt` on the very first boot) still wants a fresh card in an e-ink frame. Original text: (fixed on main 2026-09-04):
  the same Zero W boot logged `Running driver setup for device 'framebuffer'`
  → `FrameOS fatal: cannot open: ./frame.json` → `Warning: driver setup
  failed; run it again from the setup portal` (`frameos-setup-reset.sh`
  ran the binary from `/`, and it reads `./frame.json`). Harmless for a
  framebuffer, but an SPI panel on a fresh cloud card got its overlays only
  from the portal's driver setup. Verify on a card composed after the fix:
  the first-boot journal shows `FrameOS setup: driver setup: complete`
  (and, for an SPI panel, `dtoverlay`/`dtparam` lines in `/boot/config.txt`
  on the very first boot).

- [x] **Panel link code (#379)** — PASSED 2026-09-04 ~22:35 local on uus2w.
  The user claimed the code shown on the panel from the workspace:
  `cloud:enroll:linkCode ok:true` → `cloud:hub:connected`, link state
  `mode: managed, status: connected, frame_id 7cae8131-…`, the code left the
  panel, and the workspace shows the new record connected. (The claim came
  while the previous run's 12th code had just lapsed — `linkCode:gaveUp
  starts:12` — and a restart from SSH had minted `start:1` again, which is
  the code that was claimed.) **Three more findings, all fixed on main:**
  (4) the record enrolled as **"FrameOS Setup"** — the release image's
  `frame.json` name (`tools/buildroot-images/buildroot_images.py:301`)
  went up as the frame's name; now `frameDisplayName()` treats the image
  placeholders as no name and falls back to the hostname first boot gave
  the card (`uus2w`), for the enrol request and both device-flow starts
  (`test_enrollment.nim`). (5) the queued marker
  `state/cloud_link_code_pending.json` **survived the successful claim** —
  the tick that would retire it never runs once this thread has become the
  hub session — and a stale marker restarts a link code on a managed frame
  whose socket is merely down; now the managed-enrol success clears it and
  the tick refuses to start a code while `mode` is `managed`
  (`test_device_flow.nim`). (6) not fixed, recorded: with no claim token the
  first-boot script drops the card's `name=` and `time_zone=` entirely
  (only the hostname survives), so this frame's record has `timezone: null`
  and its frame.json no zone — the no-token path should still apply the
  card's personalisation locally. Also for the operator: the earlier
  `uus2w` record (9d67a9fe-…) is now orphaned by this card and the new one
  is named "FrameOS Setup" until renamed. Earlier notes: IN PROGRESS 2026-09-04 21:45 local on
  uus2w: a cloud-builder card with the `claim_token=` line blanked
  (`~/Downloads/…-linkcode.img.gz`, region kept at 4096 bytes) booted
  standalone on Wi-Fi with the SSH key (`no claim_token in
  frameos-cloud.txt; skipping cloud enrollment state`, as the first-boot
  script says). **Two findings on the way:** (1) the panel said "Open
  http://frame.local:8787 to add one" — `system/index/scene.nim` prints
  frame.json's `frameHost`, still the image default, while the card's mDNS
  name is `uus2w.local`; fixed on main: the index derives `<hostname>.local`
  from `/etc/hostname` when `frameHost` is the default and the hint carries
  the plain IP URL too. (2) that URL answers a bare `401 Unauthorized` from
  the LAN with no way in: `frameAccess: private` + a minted `frameAccessKey`
  + no admin credentials → the admin panel is disabled, `/` has nowhere to
  redirect (`web_routes.nim:78`), and `/setup` GET/POST are served **only
  while the hotspot is active** — so nothing on the LAN can queue the panel
  link code the box asks for. User's decision (the key must stay; an
  untrusted LAN gets nothing without it): the index screen prints the
  `/?k=<accessKey>` link in the "open this" hint while the frame is still
  unconfigured (no admin login); fixed on main in the same scene. For this
  run the link was queued over SSH by writing the file the portal writes
  (`state/cloud_link_code_pending.json` = `{"provider_url": …, "starts": 0}`,
  owned by `frameos`); the hub thread started the device flow within
  seconds (`cloud:linkCode:shown start:1`, `verification_uri_complete:
  https://cloud.frameos.net/device?user_code=6XGN-Q8B4`), and the panel
  code rotates every ~10 minutes (`LINK_CODE_MAX_STARTS` = 12) while nobody
  claims it — start 8 by 21:57. **Finding 3, fixed on main (`39f80d83`):** the
  code + QR were painted by the runner *over* the index screen, on top of the
  rows ("it looks bad" — user). The status-screen model now has an `aside`;
  `system/index` fills it from `activeLinkCode()` and draws the QR itself in a
  right-hand column (under the notes on portrait panels), and the runner
  only overlays real scenes. Claim + retire still to be observed.
  Original text: boot an unclaimed frame in cloud mode with
  no claim code → the panel renders the link code + QR → complete the claim
  from an account, and confirm the code retires once connected.

- [x] **Scheduled reboot on Pi (#376)** — passed 2026-09-04 on uus2w (2026.9.4, `frameos` user): a `reboot` entry for 12:15 Europe/Brussels pushed from the cloud → `scheduler:loaded … nextDue Fri 12:15 reboot` → at 12:15:00 local `scheduler:fire {id, action: reboot}` → door `executing reboot` → the Pi rebooted and came back. Original text: add a `reboot` schedule entry from
  the cloud and watch a real Pi reboot at the scheduled time. Floor is
  2026.8.32 — needs the new firmware.

- [x] **Hardware settings batch (#374)** — passed 2026-09-04 12:12 on uus2w (2026.9.4, migrated `frameos` user): `gpio_buttons: [{pin: 17, label: Bench}]` pushed from the cloud → `event:restart` → systemd "Scheduled restart job, restart counter is at 1" (a real restart, new pid) → `driver:gpioButton Listening on GPIO 17 (Bench)` loaded from the release's `gpioButton.so` as the unprivileged user (`/dev/gpiochip0` is `root:frameos`). Palette / partial-refresh `device_config` need an e-ink frame; the disabled-with-reason display on pre-2026.8.31 firmware was not checked (no such frame left). Original text: push palette / partial-refresh
  `device_config` / `gpio_buttons` from the cloud panel → runtime restarts
  (not just reloads) and the settings apply. Also confirm the panel only
  shows fields the reported hardware can use, and shows disabled-with-reason
  on pre-2026.8.31 firmware.

### Privilege separation bench (`docs/buildroot-privileges.md` §4)

Steps 0–6 and 8 ran on hardware 2026-09-04 (uus2w, Cloud-5, Cloud-W); steps
7 and 9 are in Open above. A fresh generic `raspberry-pi-64` release image is
the known-good starting point for any of them.

#### Context for picking this up cold (written 2026-09-03, PR #415 green, not yet merged)

**What ships in #415:** generic Buildroot images (`raspberry-pi-64`,
`raspberry-pi-5`) run `frameos.service` as `frameos` (uid 990) behind the
enum-only root door; `raspberry-pi-32` (armv6, wpa_supplicant) and every
backend-personalized image (self-hosted backend, Home Assistant add-on) stay
root on purpose. Releases up to and including **2026.9.2 are root-only**;
the first release containing the door is the one cut after the merge
(**2026.9.3**). A Buildroot frame that OTAs from 9.2 to 9.3 performs the
root→`frameos` migration inside that upgrade (`docs/buildroot-privileges.md`
§4 "OTA and migration").

**Surfaces and what each one is for here:**

| Surface | Frames | Role in this bench |
| --- | --- | --- |
| cloud.frameos.net (production) | 2 Buildroot frames (SPI e-ink — note the panels here: ______), 2 ESP32 | the two Buildroot frames are the **migration** test (9.2 → 9.3 over the air, one at a time); ESP32 frames are untouched by #415 |
| cloud.frameos.net bench HDMI frames | piw (`raspberry-pi-32`), pi2w (`raspberry-pi-64`), pi5 (`raspberry-pi-5`) | pi2w + pi5: **fresh-image** tests (flash 9.3, reflashable = safe to break) and the framebuffer/`CAP_SYS_TTY_CONFIG` check; piw: **stays root** regression |
| localhost:8616 self-hosted backend | 2 Waveshare frames | **regression only**: backend deploys its own build from the checkout as root; a deploy after the merge must still work and `User=` must still be root |
| Home Assistant add-on | a few Waveshare / Pimoroni frames | **regression only**, after the add-on picks up the 9.3 docker image (`docker-publish-multi.yml` publishes it); one frame is enough |

**Sequence (each step is a checkbox further down or here):**

- [x] **0. Baseline on 2026.9.2, before merging** — **obsolete, closed
  2026-09-04.** It served its purpose (step 1 was found while doing it) and
  there is no longer anything to baseline: every cloud Buildroot frame is on
  2026.9.6 and migrated, and the one remaining "root-only" record in the
  workspace (`Cloud-2W`, 2026.8.26, offline since 2026-08-21) is a **stale
  duplicate of `uus2w`** — the same SD card, reflashed and re-enrolled under
  the new name. No root-only frame exists on the bench. Original text:
  Upgrade the two cloud
  Buildroot frames and the three bench HDMI frames to **2026.9.2** (the last
  root-only release) via "Upgrade FrameOS". Reason: 9.2 is exactly the
  "previous release" the migration test needs, and a plain OTA on every
  frame first separates "OTA is broken" from "the migration is broken".
  Do **not** jump the Buildroot frames to 9.3 by any other route first — a
  frame that never ran 9.2 → 9.3 OTA has not tested the migration. ESP32
  frames: irrelevant to #415, upgrade whenever. Local backend / HA frames:
  nothing to do now.

- [x] **1. Merge #415** — merged 2026-09-04 as `67a1884a`. Found while
  doing step 0: the 2026.9.2 archive ships a runtime still stamped
  `2026.9.1` (the release only touched the workflow, and the runtime is
  compiled with versions.json's per-component `frameos` entry), so frames
  that "upgraded" to 9.2 report 9.1 and the cloud keeps offering the update.
  Fixed on main (`2f29a309`, the release workflow now forces `frameos` to the
  release version). For this bench it changes nothing: 9.1 and 9.2 are the
  same root-only binary, and 9.3 will be the first properly stamped release,
  so the migration test is still "whatever the frame runs now → 9.3".

- [x] **2. New Buildroot base images from main** — done 2026-09-04, manifest commit `0a2a9927` (all three platforms, fresh builds). Original notes:
  `gh workflow run buildroot-base-image.yml --ref main -f platform=all`.
  The base build is where `BR2_ROOTFS_USERS_TABLES` creates the `frameos`
  user natively; a release composed from an *older* cached base gets the
  user through `buildroot_user_merge.py` in `patch-root.sh` instead. Both
  paths are tested — keep the manifest commit the workflow makes. If the
  base build is slow or fails for one platform, the release can still be
  cut from the old bases (the merge path); note which path 9.3 used.

- [x] **3. Cut the release** — 2026.9.3 failed to compose (read-only $service_root in the user merge, fixed 4827756e); 2026.9.4 is the first published door release. Original notes: — started 2026-09-04 00:57 UTC from `a3e7e0bf`
  (run 33815437078). Note: the release commit predates `4337e51d`, so 9.3
  cards still carry the first-boot driver-setup cwd bug (framebuffer cards
  unaffected; an SPI panel on a *fresh* 9.3 card gets its overlays from the
  portal/cloud driver setup, not first boot). DNSSEC is fine on 9.3 cards
  because the 9.3 bases are fresh builds (overlay carries the drop-in).
  Original notes: `gh workflow run docker-publish-multi.yml --ref main`
  (bumps `versions.json` as frameos-bot, builds the binaries, Buildroot SD
  images, ESP32 firmware, wasm, and publishes the GitHub release). Check the
  release page has `frameos-2026.9.3-*.tar.gz` + `.minisig` for
  `debian-bookworm-arm64` (that is what the Buildroot 64-bit frames pull)
  and the `raspberry-pi-64` / `raspberry-pi-5` `.img.gz`.

- [x] **4. Fresh image first (reflashable)** — BOTH halves passed 2026-09-04.
  **`raspberry-pi-5` half, 20:02 local, Cloud-5 reflashed from the cloud
  builder (2026.9.6, framebuffer 800×480, Europe/Brussels, SSH key):** first
  boot read `frameos-cloud.txt` (Wi-Fi, `hostname cloud-5`, display applied,
  keys, enrolment state), `driver setup: complete`, the card's clock started
  at the 2025 floor (no persisted timesync file yet on a fresh card) so
  `networkCheck` attempts 1-2 failed on name resolution, timesyncd's `Initial
  clock synchronization` landed at +4 s and attempt 3 succeeded — **no
  `sync-clock` storm, no hotspot**, `cloud:enroll:boot` → `personalization`
  applied `{name: Cloud-5, timezone: Europe/Brussels}` → connected, same frame
  record re-adopted. Runs as uid 990 (`User=frameos`, `/etc/passwd`), door
  `.path` active, state/queue `1770`, results `2750`, all three persistent
  bind mounts up from fstab, dropbear key under state, "cannot escalate"
  re-run (`Permission denied`, `refusing manual-shell.json: Unknown
  privileged verb: shell`). Door answers: cloud Reboot → runtime `cloud:audit
  verb reboot ok:true` at 18:09:06 UTC → back with uptime 15 s at 18:09:34,
  `/` **ro** on the second boot, reconnected on attempt 3 again (Pi 5 Wi-Fi
  bring-up timing, not the clock: `DNSSEC validation` lines 0, no cert
  errors), scheduler on Europe/Brussels. Not on this frame: `/dev/fb0` does
  not exist without an HDMI cable (`render:driver` 0.03 ms no-op) — known,
  predates everything. **Found on this card: (1)** the same `/etc/localtime`
  = UTC as uus2w — the runtime's `withWritableMount` + `install /etc/timezone`
  + `timedatectl` ladder all died on `sudo: no new privileges` (fixed on main
  earlier tonight, `set-timezone` door verb); **(2) cloud-side:** the frame
  record kept `timezone: null` although the builder minted the bound token
  with Europe/Brussels — `rebindEnrollment` (re-flash of an existing frame)
  only re-keyed the row, while a fresh enrolment stores and pushes
  `token.timezone`. Fixed on main the same evening: rebind merges the token's
  zone into `settings` and queues the same `set_settings` push
  (`frames.integration.test.ts` "takes the bound token's time zone onto the
  existing frame"). `raspberry-pi-64` half, earlier: PASSED 2026-09-04 on the fresh 2026.9.6 uus2w card (Zero 2 W): boots and renders as `frameos` (uid 990 in `/etc/passwd`, `User=frameos`, index screen on HDMI), `frameos-privileged.path` active, state/queue `root:frameos 1770`, results `2750`, the scheduled reboot executed through the door while the runtime was uid 990 (see the §2 re-flash box), `/` `ro` from the second boot on (`rw` on the first, by design), all three persistent bind mounts (`/etc/NetworkManager/system-connections`, `/var/lib/NetworkManager`, `/var/lib/systemd/timesync`) active from fstab on both boots, and "runtime cannot escalate" re-run: writes to `current/frameos` and the unit → `Permission denied`, a `shell` verb in the queue → `refusing manual-shell.json: Unknown privileged verb: shell`, `handled 1 request(s)`. Not re-run on this card: hotspot/portal (verified 12:39 the same day on this frame type after the bind-mount fix, which this card ships). **Still open: the `raspberry-pi-5` half** — Cloud-5 was migrated by hand, never flashed fresh; reflash it from the cloud builder and run the same boxes. Original text: flash `raspberry-pi-5` 9.3 on
  pi5, enroll into the cloud, run the "boots and renders as `frameos`",
  "door answers", "hotspot and portal" and "runtime cannot escalate"
  boxes below. Then `raspberry-pi-64` 9.3 on pi2w for the same boxes.

- [x] **5. Migration to the `frameos` user on a NetworkManager frame** —
  **CLOSED 2026-09-04.** Both NM bench frames are migrated (uus2w by OTA,
  Cloud-5 by hand), both run 2026.9.6 as `frameos` and are connected. The last
  open item — the Pi 5 cold boot — **passed on a user-triggered reboot of
  `Cloud-5` at 15:44:02 UTC**, and better than the box asked for:
  `/var/lib/systemd/timesync` is bind-mounted from
  `/dev/mmcblk0p3[/state/timesync]` (so is
  `/etc/NetworkManager/system-connections`, matching uus2w), timesyncd logged
  `System clock time unset or jumped backwards, restored from recorded
  timestamp: Fri 2026-09-04 15:44:02 UTC` — the correct *date*, not the old
  Aug-16 floor — so TLS validated on the first try. `networkCheck` succeeded on
  attempt 3 at +6 s (attempts 1-2 failed only on `Temporary failure in name
  resolution`, i.e. DNS not up yet, **not** on `certificate verify failed`),
  and `cloud:hub:connected` landed at +7 s. **Zero** `syncing clock` /
  `sync-clock` lines in the boot journal and **zero** hotspot lines — the
  restart storm that used to park this frame on `system/wifiHotspot` for an
  hour cannot happen now, because the clock never needs fixing. NTP then
  corrected the ~1 h staleness of the recorded timestamp at 16:44:23
  (`Initial clock synchronization to …16:44:23`), which is the expected
  behaviour of timesyncd's periodically-written clock file, not a fault.
  **Recorded, not fixed:** `/etc/NetworkManager/system-connections` on Cloud-5
  still holds litter from the failed 08:11 hotspot attempt on read-only root —
  a **0-byte** `frameos-hotspot.nmconnection` (NM logs `failed to load
  connection: invalid connection: connection.type: property is missing` on
  every boot), two leftover `.nmconnection.XXXXXX` write temps, and a
  UUID-suffixed duplicate. Harmless but noisy; delete them on the next bench
  visit. Original note: IN PROGRESS 2026-09-04 on `Cloud-5` (Pi 5, `raspberry-pi-5`, framebuffer
  800×480, NetworkManager). It took the OTA 2026.9.1 → 2026.9.4 at
  07:49 UTC (`cloud:upgrade running`, target `debian-bookworm-arm64`), the
  runtime restarted and reported 2026.9.4 with one metrics packet, then the
  frame went **disconnected at 07:49:40** and stayed off for minutes while
  every other 9.4 frame was connected — SSH verification pending. (It was
  already logging `render:driver:retry` for the framebuffer every 60 s for
  hours on 9.1, so an unlit HDMI there predates the migration.) Other NM
  Buildroot frames: `uus2w` on 2026.9.4 and connected (second candidate —
  needs SSH to confirm `User=frameos`, uid 990,
  `/srv/frameos/privileged/queue` present, door `.path` active), `Cloud-2W`
  on 2026.8.26 offline since Aug 21.
  **uus2w verified offline 2026-09-04** (its SD card read on a Mac with
  debugfs, no SSH on the card yet): it OTA'd 2026.9.1 → 2026.9.4 at
  07:43 UTC; `state/upgrade-status.json` = `success` ("FrameOS upgraded to
  2026.9.4. Restarting services."); `/etc/passwd` has
  `frameos:x:990:990:FrameOS runtime:/srv/frameos:/bin/false`, `/etc/group`
  `frameos:x:990:`; `/etc/systemd/system/frameos.service` is the hardened
  unit (`User=frameos`, `Group=frameos`, `SupplementaryGroups=video input`,
  `AmbientCapabilities=CAP_SYS_TTY_CONFIG`, `ProtectSystem=strict`, the
  `ExecStartPre=+` chgrp/chmod pass); `frameos-privileged.service` +
  `.path` installed and the `.path` linked from `multi-user.target.wants`;
  `60-frameos-devices.rules` present; on `/srv/frameos`: `state`, `logs`,
  `staging`, `runtime`, `tmp`, `privileged/queue` = `root:990 1770`,
  `privileged/results` = `root:990 2750`, `privileged` = `root:990 0755`,
  `releases/` + `current` root-owned. The post-boot journal capture
  (`/boot/frameos-postboot-2min.log`) of the 08:11 UTC reboot shows the
  unprivileged runtime booting, the network check passing, `nm-connections`
  answered through the door (`portal:privileged ok`), the console claimed
  (`driver:frameBuffer:consoleClaimed graphicsMode:true` — the keyboard is
  swallowed with it, so a USB keyboard cannot reach the tty1 getty), and it
  rendering + reconnecting to the cloud. Still to do over SSH once the key
  works: `ps -o user= -C frameos`, `journalctl -u frameos-privileged`, the
  link cases. Found on the way: `/etc/dropbear` on that card is empty and
  dropbear closes every connection at key exchange (`-R` never generated
  a host key); a `dropbear.service.d/10-hostkey.conf` drop-in running
  `dropbearkey` was added by hand — and failed the same way, because
  **the root filesystem is read-only on these images** (`withWritableMount`
  in setup.nim is how `frameos setup` writes /etc): dropbear's `-R` can
  never write `/etc/dropbear/`, so SSH on a generic Buildroot card only
  works if the host key happened to be generated during a boot where root
  was rw (Cloud-W: the first-boot script's `mount -o remount,rw /` is never
  undone). Fix applied to both bench cards by hand and to be shipped: keep
  the host key under `/srv/frameos/state/dropbear/` (`DROPBEAR_ARGS="-s -g
  -r …"` + a `dropbear.service.d` drop-in that runs `dropbearkey` there).
  **`Cloud-5` (Pi 5) took the same OTA at 07:49 UTC and has been
  disconnected since — explained by its card's post-boot capture of the
  08:30 UTC reboot:** the clock was still at 2025-06 (no RTC battery;
  timesyncd's clock file cannot persist on the ro root), the network check
  hit `certificate verify failed`, and the runtime's `syncClock()` → door
  `sync-clock` → `systemctl restart systemd-timesyncd` was fired every 3 s,
  nine times in 27 s, so timesyncd never completed a sync before the 30 s
  budget ran out → `No network. Starting the setup hotspot…` →
  `system/wifiHotspot` with a 3600 s sleep. The frame is alive (metrics in
  its file log 08:16–08:32 UTC) but off the cloud for an hour at a time.
  FIXED on main 2026-09-04 (after 2026.9.4, commit 1b3ad730): the door's
  `sync-clock` leaves a running timesyncd alone, starts it only if it is
  down, and waits up to 45 s for `/run/systemd/timesync/synchronized`; the
  network check syncs once per check and gives the wait back to its 30 s
  budget (`test_privileged.nim` sync-clock block). Verify on the next
  release with a cold-booted Pi 5: `networkCheck attempt 1 success` after
  one `syncing clock` line, no hotspot.
  **Cloud-5's card read offline (11:20 local):** it never migrated at all —
  no `frameos` user, unit `User=root`, no `/srv/frameos/privileged`,
  `upgrade-status.json` stuck at `running` although `current` points at
  the installed 9.4 release dir. Cause 1 (by the code's rule, wrong for
  this frame): its `frame.json` carries `agent.agentEnabled=true` with an
  empty `agentSharedSecret` (the Aug-16 image default; `frameos-remote.service`
  is enabled on that card), and `buildrootServiceUser` treats any enabled
  agent as backend-managed → keeps the installed user (root). A cloud frame
  from a generic card must not be classified that way — tightened to
  require a shared secret (a backend cannot use an agent without one).
  Cause 2 (why the status never finalised): `upgrade.log` ends with the
  9.1 runtime's `FRAMEOS_SERVICE_USER='root' ./frameos setup` of the 9.4
  binary and not one line of that setup's output — the upgrade child was
  killed when the service restarted, so the status stayed `running` and
  no unit was rewritten; the runtime that came up was 9.4 as root.
  Mitigated on main 2026-09-04 (commit 1b3ad730): at runtime start a
  `starting`/`running` status older than 10 min is rewritten to `failed`
  ("interrupted", release details kept; `test_upgrade.nim` "interrupted
  upgrade status"), so the workspace stops reporting a phantom upgrade and a
  new one can be triggered. Why that particular child died is still unknown. Cause 3
  (why it then fell off the cloud): its boot clock. The Pi 5 has no RTC
  battery and timesyncd's clock file on the ro root is 0 bytes dated
  Aug 16, so every cold boot floors at Aug 16 → the cloud's current TLS
  cert is "not yet valid" → the sync-clock restart loop above → hotspot
  for an hour, then 5 min of index, then hotspot again (runtime log
  08:06–08:10 UTC). Hand fix on the card: the clock file's mtime bumped to
  now. Real fix: keep timesyncd's clock file on the persistent partition
  (bind mount or `SystemdTimesyncClockFile`-style drop-in), and the
  sync-clock fix above. Both bench cards also got `/root/.ssh/authorized_keys`
  and the dropbear host-key drop-in by hand.
  **Cloud-5 migrated by hand 2026-09-04 11:56 local** (over SSH, after
  `agentEnabled` was set to false in its frame.json on the card): a
  `frameos.service.d/10-wait-clock.conf` drop-in (hold the runtime up to
  90 s until `date +%Y` ≥ 2026) fixed the cold boot — timesyncd synced at
  09:54:25 UTC, the runtime started at :26, network check attempt 1 =
  success, no hotspot. Then `./frameos setup` from `/srv/frameos/current`
  ran the whole migration ladder (`frameos.service runs as frameos`,
  `creating user frameos (uid 990)`, door units enabled, ownership applied,
  the legacy `frameos-remote.service` wants link removed) and after
  `daemon-reload` + `restart`: `User=frameos`, `ps` = `frameos 1090
  frameos`, `.path` active + enabled, state/logs/staging/queue `root:frameos
  1770`, results `2750`, `/` still `ro`, `cloud:hub:connected` at 09:57:21
  UTC and the workspace shows it connected on 2026.9.4. So both NM bench
  frames are migrated; the OTA-driven path did it on uus2w, the manual
  `frameos setup` (same ladder) on Cloud-5. Still unlit: `/dev/fb0` does not
  exist on this Pi 5 without an HDMI cable (`render:driver:retry` every
  60 s) — predates everything above.
  **Cloud reboot verb replays (found on uus2w 11:51):** the frame acks
  `reboot` then reboots 2 s later through the door, but the hub kept the
  command in `sent` and re-delivered it on every reconnect → a reboot loop
  until the command's 5-min TTL (cancelled by hand via
  `frame_command_cancel`). FIXED on the hub 2026-09-04 (`redeliverSentCommands`,
  commit 1b3ad730): a `reboot` / `restart_runtime` already written to a
  socket is expired as `delivered_once` instead of requeued, pinned by the
  "does not redeliver a reboot after the socket it was sent on died"
  integration test. Applies as soon as the hub is deployed, no firmware
  needed.
  When run: watch `upgrade-status.json`, then SPI panel refresh time
  (slow = bit-banged fallback = wrong device group), `journalctl -u
  frameos-privileged`, `/etc/passwd` has `frameos:x:990:990`,
  `systemctl show -p User frameos.service` = `frameos`.

- [x] **6. armv6 stays root** — verified 2026-09-04 on Cloud-W (Zero W,
  raspberry-pi-32) after the fleet OTA to 2026.9.4. `systemctl show -p User
  frameos.service` = `root`, runtime + udhcpc run as root, no `frameos`
  user in /etc/passwd, `/srv/frameos/privileged` does not exist. The door
  units and udev rule are installed but `frameos-privileged.path` is
  `disabled`/`inactive` — exactly the root-frame shape. Binary stamped
  `2026.9.4+9a032fcb` and reports 2026.9.4 (the version fix works end to
  end). Renders on framebuffer after the restart. Still to try on a real
  bench piw: the hotspot/portal round trip through supplicant.nim.

- [x] **8. Link cases** — done 2026-09-04 on uus2w over SSH; see the
  "Root follows none of the runtime's links" box below for the full record
  (all four cases passed, plus the restore-and-retry upgrade).

- [x] **It boots and renders as `frameos`** — uus2w live 2026-09-04 11:48 (SSH after the dropbear fix): `User=frameos`, `ps` shows `frameos 262 frameos`, `/` mounted `ro`, `/srv/frameos` `rw`, `/dev/fb0` `/dev/tty1` `/dev/gpiochip0` are `root:frameos 660`, framebuffer renders (172 ms scene + 481 ms driver at 1080p). SPI panel not yet checked (no SPI frame with SSH). Original text: `systemctl show -p User
  frameos.service` says `frameos`, `ps -o user= -C frameos` agrees, and a
  scene renders. Check the panel you have: framebuffer (Pi 5 / HDMI) and at
  least one SPI e-ink (Waveshare 7.5" or 13.3E, Inky) — the SPI path is the
  one most likely to trip on `/dev/spidev*` or `/dev/gpiochip*` permissions.
  `DEV_Config.c` falls back to *bit-banged* SPI when it cannot open spidev,
  so a panel that works but refreshes slowly means the group is wrong; look
  for that, do not just trust a picture.

- [x] **The GPIO button and evdev input still fire** — passed 2026-09-04
  18:11-18:13 on uus2w (2026.9.6). The runtime's supplementary groups are real:
  `/proc/<pid>/status` on the running service shows `Uid: 990`, `Groups: 28 108
  990` (`video`, `input`, `frameos`) and `CapEff: 0000000004000000` =
  `CAP_SYS_TTY_CONFIG` and nothing else. **evdev, end to end:** uus2w has no
  input hardware, so a virtual one was made — `modprobe uinput` plus a small
  static aarch64 uinput injector (cross-built in an arm64 alpine container,
  streamed over ssh, since the frame has no compiler or interpreter) created
  "FrameOS bench virtual keyboard" at `/dev/input/event0` (`root:input 0660`
  from eudev's default rules). After a `systemctl restart frameos`, the
  unprivileged runtime enumerated it and delivered real events into the scene
  loop: `{"event":"event:keyDown","payload":{"key":"KEY_A","code":30}}` /
  `event:keyUp` once a second for the life of the device — so uid 990 reaching
  `/dev/input/event*` through group `input` works. Removing the device was
  handled cleanly too (`read error -19, closing device` → `All input devices
  gone, stopping evdev driver`). Bench left clean: injector killed, `uinput`
  rmmod'd, `/dev/input` back to `mice`. **gpioButton:** its privilege-sensitive
  half was already proven on 2026-09-04 12:12 — as uid 990 the driver opened
  `/dev/gpiochip0` (`root:frameos 0660` from the udev rule),
  `lgGpioClaimInput` + `lgGpioClaimAlert` both succeeded on GPIO 17 and it
  logged `Listening on GPIO 17 (Bench)` with no claim error. What is left is
  purely electrical (short GPIO 17 / physical pin 11 to GND / pin 9 and watch
  for a `button` event); uus2w has no button fitted and that is not a
  permissions question. **Console claim:** verified —
  `driver:frameBuffer:consoleClaimed graphicsMode:true`, no getty text over the
  image, and a USB keyboard cannot reach the tty1 getty while frameos holds it
  (see step 5). Original text: (groups `frameos` /
  `input`), and the framebuffer console is claimed (no getty text over the
  image — that is `CAP_SYS_TTY_CONFIG` working).

- [x] **The door answers** — uus2w 2026-09-04 11:51: cloud Reboot → `FrameOS privileged: executing reboot (…)` → `> sh -c '(sleep 2; systemctl reboot || reboot) …'` → connection closed; `.path` active before and after. Original text: `journalctl -u frameos-privileged` after a
  reboot from the cloud/admin ("Reboot" button): one `executing reboot` line,
  then the reboot. `systemctl status frameos-privileged.path` is active.

- [x] **Hotspot and portal through the door** — PASSED 2026-09-04 12:39–12:44 on uus2w once the `/var/lib/NetworkManager` bind mount (the fix below) was applied by hand: Wi-Fi profile deleted → reboot → door `nm-radio-on`, `nm-device-status`, `nm-hotspot-start ok in 2.48s` → `FrameOS-Setup` on the air (Cloud-5's radio: channel 11, WPA) → phone joined, portal listed networks via `nm-wifi-list` (twelve calls while browsing) → `POST /setup` → `nm-hotspot-stop` → `nm-wifi-connect` "Device 'wlan0' successfully activated" → `networkCheck success` → `cloud:hub:connected`; profile saved as `frameos-wifi.nmconnection` on the persistent partition; reboot → rejoined on its own, mounts up from fstab, check attempt 1 success. The door journal shows no PSK; the runtime's `portal:http post /setup` line logs the Wi-Fi password masked (`le****…`, the existing masking keeps the first two characters). First attempt the same day FAILED on stock 2026.9.4 (uus2w,
  2026-09-04 12:30): with the Wi-Fi profile deleted the door ran
  `nm-radio-on`, `nm-device-status`, `nm-hotspot-start` (all `ok`,
  `managed,add,modify,up`), the portal screen rendered, and NetworkManager
  logged `Started Wi-Fi Hotspot "FrameOS-Setup"` … `Activation: successful`
  — then `dnsmasq: cannot open or create lease file
  /var/lib/NetworkManager/dnsmasq-wlan0.leases: Read-only file system`,
  `dnsmasq exited with error`, `activated -> failed (ip-config-unavailable)`,
  `AP-DISABLED` two seconds after `AP-ENABLED`. No SSID on the air (two other
  frames' radios confirmed). Cloud-5's 08:30 capture has the same dnsmasq
  line, so the setup hotspot has only ever worked on a card's *first* boot
  (the first-boot script leaves `/` remounted rw). The door path itself is
  fine. Fixed on main 2026-09-04: `/var/lib/NetworkManager` (and
  `/var/lib/systemd/timesync`, for the clock floor) are bind-mounted onto
  `/srv/frameos/state/…` via fstab in new images, the compose path, and a
  `frameos setup` "persistent state mounts" step. Recovery of the bench frame:
  the deleted profile was restored from `state/wifi-backup/` on the card. To
  re-run once the mount is on the frame: Boot with no Wi-Fi
  credentials → `FrameOS-Setup` hotspot appears, the portal lists networks,
  joining one works and survives a reboot. Every one of those is an
  `nm-*` verb now; the journal shows them.

- [x] **OTA from a root-only release (the migration)** — closed 2026-09-04
  on the evidence already recorded in step 5: `uus2w` took the OTA
  2026.9.1 → 2026.9.4 at 07:43 UTC and came out migrated — `upgrade-status.json`
  `success`, `/etc/passwd` gained `frameos:x:990:990`, the installed unit is
  the hardened one (`User=frameos`, `SupplementaryGroups=video input`,
  `AmbientCapabilities=CAP_SYS_TTY_CONFIG`, `ProtectSystem=strict`), ownership
  came out root-code / `frameos`-state (`state`/`logs`/`staging`/`queue`
  `root:990 1770`, `results` `2750`, `releases/` + `current` root-owned) and it
  rendered and reconnected after the restart. The second run of the same path,
  `Cloud-5`, failed three separate ways (agent-classification, the killed
  upgrade child, the Pi 5 boot clock) — **all three fixed on main in
  `1b3ad730` and shipped in 2026.9.5/9.6, but the migration has not been
  re-run end to end on a frame carrying those fixes**, because no root-only
  frame is left: `Cloud-2W` is a stale cloud record for the card that is now
  `uus2w`. To re-test it properly you need a card flashed from a ≤2026.9.2
  image; carry that into the §A fresh-card session if you want it re-proven,
  otherwise this is closed on the uus2w run. Original text: Flash an image from
  the *previous* release, let it enroll, then trigger "Upgrade FrameOS".
  Expect: the upgrade succeeds, `/etc/passwd` gains `frameos:x:990:990`,
  the installed unit becomes the hardened one, `/srv/frameos` ownership is
  root-code/`frameos`-state, and the frame renders after the restart.

- [x] **OTA on an already-migrated frame** — PASSED on 2026.9.6, 2026-09-04 17:44 local on uus2w (9.5 → 9.6 through the door): `upgrade.log` `signature OK … asking the privileged door to install`; door journal `verifying the staged release signature as root` → `signature OK (key 27c4c7f5df300370)` (the second verification) → ownership sweep → `install-release ok in 33.72s`; the release dir came out `drivers/` `0755`, `*.so` `0644`, unit copy `0644`; the runtime logged `driver:shared … loaded: true` for frameBuffer.so and evdev.so and `consoleClaimed`; `upgrade-status.json` `up_to_date` / `compiled_version 2026.9.6+35d34e6f…`. The 9.5 run below is what found the bug. Original 9.5 run: 2026-09-04 16:49 local on uus2w (9.4 → 9.5, the first release OTA'd *through the door*): `upgrade.log` shows `verifying the release signature` → `signature OK (key 27c4c7f5df300370); asking the privileged door to install`; the door journal shows `install-release ok in 32.05s`, release activation, the ownership sweep and `Restarting services`; `upgrade-status.json` ended `up_to_date` / `compiled_version 2026.9.5+e0ee71ef…`; the cloud saw `cloud:upgrade success` then a replayed `scheduled` → `up_to_date` from the new binary. **Found: the frame came back blind.** The door worker runs with `UMask=0027`, so `tar --no-same-permissions` + `copyDir` left `drivers/` `0750` and every `*.so` `0640`, then the ownership sweep chowned them `root:root` → the `frameos` runtime logged `driver:shared:error … Unable to load driver library` for `frameBuffer.so` and `evdev.so`, `render:driver` became a 0.01 ms no-op and the status screen spun at ~4 renders/s ("Rendering fast"). 9.4 had escaped because it was installed by the root-only 9.2 runtime (umask 022). Hand-fixed on the bench (`chmod -R u=rwX,go=rX drivers vendor scenes; chmod 0644 frameos.service; systemctl restart frameos` → `consoleClaimed`, 371 ms framebuffer writes); fixed on main by making `buildrootOwnershipScript` set the code-root modes explicitly (`chmod -R u=rwX,go=rX` after the root chown, `0644` on the unit copy) — every migrated frame self-heals on its next setup run. Re-run this box on the release after 2026.9.5. Recorded, not fixed: with no display driver loaded the status screen re-renders every ~230 ms. Original text: (unprivileged → door →
  `install-release`): the status file goes `running` → `success`, the log
  shows the signature verified *twice* (once unprivileged, once as root),
  and the frame comes back on the new version.

- [x] **The runtime cannot escalate** — uus2w 2026-09-04 11:49: as `frameos`, appending to `/srv/frameos/current/frameos` → `Permission denied`; to `/etc/systemd/system/frameos.service` → `Read-only file system`; queue file `{"id":"manual-shell","verb":"shell","args":{}}` → journal `refusing manual-shell.json: Unknown privileged verb: shell` (a malformed file is refused too: `input(1, 3) Error: { expected`); `stat` = `root:frameos 1770` for state/logs/staging/queue, `2750` results; door journal has 0 `psk`/`password` hits after the Wi-Fi join; `ln -s /etc …/queue/x.json` → worker ran once (`handled 0 request(s)`), removed it, settled `inactive`. Not yet: the result-path symlink and runtime-created `scenes/*.so` cases. Original text: As `frameos` on the device (`su -s
  /bin/sh frameos`): writing `/srv/frameos/current/frameos` fails, writing
  `/etc/systemd/system/frameos.service` fails, and a queue file with
  `{"id":"manual-shell","verb":"shell","args":{}}` is refused in the
  journal rather than run. Also verify
  `stat -c '%U:%G %a'` reports `root:frameos 1770` for `state`, `logs`,
  `staging`, and `privileged/queue`, `root:frameos 2750` for
  `privileged/results`, and that neither a hostile result-path symlink nor a
  runtime-created `scenes/*.so` is followed by the root worker. After joining
  Wi-Fi, confirm `journalctl -u frameos-privileged` does not contain the PSK.

- [x] **Root follows none of the runtime's links (2026-09-03 review)** —
  PASSED 2026-09-04 18:04-18:10 on uus2w (2026.9.6, `User=frameos`, uid 990),
  all four cases.
  **(1) The symlink at `scenes.json.gz`.** As `frameos` in
  `/srv/frameos/current` (the release dir is `drwxrwxr-t root:frameos`, and
  `scenes.json.gz` is runtime-owned, so the swap is genuinely available to a
  compromised runtime): `mv scenes.json.gz scenes.json.gz.bak` then
  `ln -s /srv/frameos/state/NetworkManager/system-connections/frameos-wifi.nmconnection
  scenes.json.gz`. The runtime cannot read that keyfile itself (`Permission
  denied`; it is `root:root 0600` under a `0700` dir) — the whole point is to
  make root read it on the runtime's behalf. Then an upgrade was triggered.
  It **failed** exactly as designed: `upgrade.log` ends
  `FrameOS upgrade failed: refusing to follow the symlink at
  /srv/frameos/releases/release_upgrade_20260904174415_2026_9_6/scenes.json.gz`,
  `upgrade-status.json` = `failed` with that same message and `exit_code: 1`,
  and `current` still pointed at the old release. The staged release directory
  was left with `all_scenes.json.gz` (copied just before the raise) and **no
  `scenes.json.gz` at all**; a `grep -rF` for the PSK across the staged release
  and the staged remote dir found nothing. `readFileNoFollow`'s `O_NOFOLLOW`
  is what fires (ELOOP), inside `copyScenePayloads` →
  `assembleReleaseFromArchive`.
  **(2) Restore and retry.** `mv scenes.json.gz.bak scenes.json.gz` then the
  same upgrade: `success`, "FrameOS upgraded to 2026.9.6. Restarting services."
  The frame came back healthy — `User=frameos`, `drivers/` `0755`, `*.so`
  `0644`, `frameos.service` `0644` (the post-9.5 ownership fix, applied by the
  *new* binary's `frameos setup` during activation), framebuffer writes at
  ~372 ms, connected to the cloud on 2026.9.6.
  **(3) `ln -s /etc scenes`** — refused, and by a better mechanism than the box
  predicted. `scenes` already exists as a root-owned directory, so the shell
  resolved the link *into* it and got `ln: failed to create symbolic link
  '.../scenes/etc': Permission denied`. Either way the runtime cannot replace a
  code root, so the "if it succeeds the composer left the code roots out" bug
  condition does not hold here.
  **(4) Hardlinks.** `sysctl fs.protected_hardlinks` = **1** (and
  `fs.protected_symlinks` = 1), so per this box the `apply-driver-setup`
  sub-case does not apply. Confirmed the kernel is what stops it:
  `ln /srv/frameos/current/frameos evil.json` as `frameos` →
  `Operation not permitted`, no file created.
  **(5) `ln -s /etc /srv/frameos/privileged/queue/x.json`** — the `.path` unit
  woke the worker, which logged `pruned 3 stale result(s)` then
  `done, handled 0 request(s)`, deleted the link, and
  `frameos-privileged.service` settled `inactive` within 3 s while
  `frameos-privileged.path` stayed `active`. Root never opened `/etc` as a
  request.
  *Method note:* the trigger was `frameos upgrade` run from the 9.5 binary
  still on the card (`installedFrameOSVersion()` is the compiled-in constant,
  so the 9.5 binary sees 9.6 as an update while the frame stays on 9.6). That
  runs the assembly as root directly rather than through the door, but it is
  the identical `assembleReleaseFromArchive` the door's `install-release`
  calls, so the guard under test is the same one. Bench left clean: aborted
  release dirs removed, payload restored, temp files deleted.
  Original text: As
  `frameos`, in `/srv/frameos/current`: `mv scenes.json.gz scenes.json.gz.bak
  && ln -s /srv/frameos/state/NetworkManager/system-connections/frameos-wifi.nmconnection
  scenes.json.gz`, `ln -s /etc scenes` (expect `ln: File exists`; if it
  succeeds the composer left the code roots out — a bug), then trigger
  "Upgrade FrameOS" (or `frameos upgrade`). Expect the upgrade to **fail**
  with `refusing to follow the symlink at …scenes.json.gz` in
  `upgrade-status.json` / the journal, no keyfile bytes anywhere under the
  new release directory, and the old release still `current`. Restore the
  payload, upgrade again, and expect success. Also `sysctl
  fs.protected_hardlinks` — note the value in the PR; with `0`, additionally
  `ln /srv/frameos/current/frameos evil.json` then drive an
  `apply-driver-setup` (portal display setup) and confirm
  `stat -c %U evil.json` stays `root` with a "refused to hand a hard-linked
  file" line in the setup log. Finally `ln -s /etc
  /srv/frameos/privileged/queue/x.json` and confirm the worker deletes it
  within a few seconds instead of restarting forever
  (`systemctl status frameos-privileged.service` settles).

### ESP32 bench

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

- [x] **Sleep-aware cloud side (#409)** — passed 2026-09-04 on E1004 (2026.9.4, on battery, 15-min naps): an `image_get` queued at 10:51:27 UTC while asleep got `expires_at` 11:01:18 = `next_wake_at` (10:59:18) + 2 min instead of the plain 5-min TTL; the frame woke at 10:59:21 (`cloud:session_ready`), the command was delivered and acked (queue empty), the log shows `sleep:held reason: image` after `render:done` and the board slept again 30 s later. Original text: the device half was captured over
  three boots on the E1004; the hub half — the frame's `render`
  announcement → a queued `image_get`, and command TTLs stretched past
  `next_wake_at` — was not exercised before deploy. On a deep-sleeping
  E1004: the fleet tile's image updates after a wake, and an `image_get`
  queued mid-sleep survives the 15-minute nap instead of expiring.

- [x] **Scheduled reboot on ESP32 (#376)** — fired 2026-09-04 on Wood7.3 (2026.9.4, Europe/Brussels): entry 12:53 → `schedule:fire {hour 12, minute 53, name reboot}` at 10:53:00 UTC → `cloud:session_ready uptimeSeconds 9`. **Found: it fired twice.** The board was back at 10:53:13, still inside minute 12:53, and fired the same entry again at 10:53:52 → second reboot at 10:54:03. The ESP32 keeps its last-fired marker in RAM, so a reboot/restart entry re-fires for the rest of its minute (a slower board could loop 2–3 times). The Pi (uus2w, 12:15) came back at 12:15:57 and did not re-fire — three seconds from the same bug. Fixed on main 2026-09-04: both schedulers persist the minute a reboot/restart entry fired in (NVS `sched_fired` on ESP32, `state/scheduler-last-fired` on the Pi) and honour it for up to 3 minutes at start (`test_scheduler.nim`). Also covers the ESP32 time-zone box's scheduler half: the entry fired at the local time. Original text: same schedule-entry test as the
  Pi, on a board.

- [x] **WPA2 provisioning AP (#443)** — verified 2026-09-04 on E1002 (2026.9.4) over the CH340 console + Cloud-5's radio + a phone: `wifi <bogus>` → portal → `status` shows `ap_psk: 9z5zpugcz5` (`config` is not a command; `status` is where it prints); the AP is `FrameOS-9F39` (station MAC + 1), 192.168.4.1, **WPA2-PSK CCMP, no PMF flag** (nmcli RSN flags), phone joined without a prompt; the portal listed networks and the saved network came back; `status` printed the same `ap_psk`; `set ap_psk ""` + the next portal start minted `akufe4xujn`. The backend "changed on frame" check was not run (no self-hosted deploy in this session). **Found on the way, fixed on main 2026-09-04 (next release):** (1) in APSTA retry mode (stored Wi-Fi failing) every station retry is an all-channel scan that takes the AP off the air — one scan in three saw it and the phone lost it mid-join → retries now every 30 s; (2) with admin auth on, the hotspot portal demanded Basic auth, which the phone's captive browser cannot show ("Authentication required" and nothing else) — hotspot requests (192.168.4.0/24) are exempt now, the minted PSK is the credential and secrets are write-only since #443; (3) the form pre-selected "Enabled with admin username/password" whenever none was configured, so a Wi-Fi-only save was refused until an admin login was invented — now it reflects the current setting. **Also fixed on main 2026-09-04 (next release):** the render loop now holds while the portal is up, so the hotspot name and passphrase stay on the panel instead of the first scene render painting over them (`on_portal_exit` renders when the stored network answers); the Wi-Fi password field says "No password saved: enter it" when there is nothing to keep (the console `wifi <ssid>` with no password blanks it, and the blank form then kept the empty password → `no_ap_found_with_compatible_security`); the render-mode selector only appears when the image has no Nim runtime or the frame is already a thin client. **Recorded, not fixed:** the SSID field kept grabbing focus on the phone — nothing in the page sets focus (no `autofocus`, no `focus()`, the only timer refreshes a preview image), so this is most likely the captive-portal helper re-opening the page; re-check on the next release from a normal browser tab. Original text: erase Wi-Fi on a board → the portal
  screen shows "Wi-Fi: FrameOS-XXXX" and a "Password:" line; a phone joins
  with it (WPA2, no PMF prompt) and reaches the portal; `config` over USB
  prints the same `ap_psk`; `set ap_psk ""` mints a new one at the next
  portal start. Then confirm the backend's frame sync shows no "changed on
  frame" for Wi-Fi password / admin password / API key after a deploy (the
  device now answers `""` for them).

- [x] **Dual console — reTerminal E1002 over its CH340** — verified 2026-09-04 on 2026.9.4. Console half: `/dev/cu.wchusbserial10` at 115200 with DTR/RTS held low answers `frameos>`, `status`, `help`, `buttons` (the board deep-sleeps between renders on USB too — `onBattery: true`, no VBUS sense — so catch it on a timed wake or a button press; the first console line arms the 3-min keep-awake). Browser half, 14:54 local: the cloud workspace's "Update firmware" over that port wrote the release image around NVS (head at 0x0, tail at 0xd000, 3148512 bytes in 72 s), the board came back on USB in 12 s (`cloud:session_ready` 11 s after reset), answered `version=2026.9.4 panel=EPD_7in3e scenes=1/9 wifi=vaarikad`, took `upload-scenes` (289624 bytes → `stored`/`pending-apply`, 35 s) and kept its Wi-Fi and cloud identity; render #2 refreshed the panel. Not run on this port: enrolment from blank ("Add frame" → Connect & flash), which is the flow the layout boxes below need. **Found, all three fixed on main 2026-09-04 (next release / next cloud deploy):** (1) the cloud's "Update firmware" always wrote the per-chip *generic* image — `releaseFirmwarePlatformForFrame` fell back to `esp32-s3-generic` because the provisioning route only exists on the self-hosted backend — so a board enrolled on a layout-matched image (16/32 MB) was refused with "partitioned differently … re-enroll". Now the flow reads the board's partition table first and fetches the image built for that layout (`layoutPlatformForPartitions`, logs "The board is partitioned for 32MB: updating with the esp32-s3-32mb image"); the provisioning answer / generic image only when the table cannot be read. (2) On the generic 8 MB layout (`stateBytes` 1 MiB) the interpreter's disk tier could never fit an 800×480 RGBX spill: render #1 after every boot logged `interpreter:cache:imageSpill:refused … storage write failed; disk tier disabled until scenes reload` after filling the state partition. Now the spool asks the filesystem first (`fos_vfs_free_bytes` → `spoolHeadroomShortfall`, 256 KB margin) and refuses with the real reason without disabling the tier; on the 16/32 MB layouts the spill lands under `/state/spool`. (3) The first "Update firmware" click in this session failed with `Failed to execute 'open' on 'SerialPort': The port is already open` because a timed-out USB API `restart` still held the port; both flashers now wait for the USB command queue to drain (`waitForEmbeddedUsbApiIdle`) and take the port back from the log stream it resumes. **Verified on 2026.9.5, 2026-09-04 17:04 local (E1002 over the same CH340 port, cloud "Update firmware"):** the flasher read the partition table first — `Flash ID: 1940ef` → `The board is partitioned for 8MB: updating with the esp32-s3-generic image` — downloaded `frameos-2026.9.5-esp32-s3-generic.bin`, wrote head at `0x0` and tail at `0xd000` (3151392 bytes in 74 s, NVS kept), the board was back on USB 12 s after "Leaving" with `cloud:session_ready version=2026.9.5 bootedFrom=ota_0`, took `upload-scenes` (290999 bytes → `stored`/`pending-apply`) and kept Wi-Fi + cloud identity; the flasher logged `[USB API] waiting for previous USB command to finish` before `upload-scenes` (the queue wait, exercised by the `image` probe rather than a `status` one). Spill half: three "Visited World Map" renders on 9.5 (timer + two RIGHT presses) logged **no** `imageSpill:refused` at all — the planner put node 47 on `liveCanvas` up front (`headroom 2880K is under 2x the 1500K scratch`), so the 1 MB state partition was never asked; the free-space reason then showed on two button wakes at 15:17 / 15:18 UTC (a wake is a fresh boot, so the world map was render #1 with ~3.1 MB headroom): `imageSpill:refused … 641K free under /state/spool cannot hold the 1089K spill with 256K to spare` — the real reason, no "storage write failed", and the tier was not latched off (the same line again on the next boot; the 1 MB state partition can never take a canvas-sized spill, so this is the generic layout's steady state). A queued switch to "Made in Space" landed while the board was still awake, unloaded the world map (PSRAM back to 4.9 MB) and rendered a 3.2 MB streamed PNG with the canvas-sized case: `641K free … cannot hold the 1500K spill with 256K to spare`. Still open: the 32 MB-layout pick (no board on that layout — E1002 stays on the generic 8 MB layout by design). Original text: the cloud flasher
  on the "USB Single Serial" port must flash, see `frameos>` and provision
  (this board has no USB-Serial/JTAG port at all). Then on a XIAO ESP32-S3
  confirm the "USB JTAG/serial debug unit" path still provisions and that
  `usb_api` uploads/previews work there. Partial pass 2026-08-26: frame 59
  (13.3E6) answered `frameos>` + `status` over its CH343 "USB Single Serial"
  port with a locally built image; opening that port through pyserial/WebSerial
  resets the chip (DTR/RTS auto-reset circuit), so open once with DTR/RTS
  low and keep the port open while waiting for the prompt.

- [x] **E1004 Weather hourly chart at full size (ac99f449 + pixie#7 / 4120fc4d, shipped in 2026.9.8):** verified 2026-09-05 02:36 UTC — E1004 took 9.8 on its 02:04 wake; a debug-mode render at 02:36 shows both `render/image` nodes with `fusion: {applied: true, claimed: true, tier: liveCanvas, fit: center}` and the hourly `weatherPanel` (node 15) returning a **1200×960** image (`valueBytes 2304000`, the 565 cell view) instead of the 286×229 standalone raster; the panel capture shows the chart filling the lower cell, no `render:degraded` line (the cell was painted directly, no rung needed). Caveat: the very first render after the OTA reboot (02:06, freePsram 2.06 MB) still showed the small chart in the cloud capture — either the capture raced the refresh or the tighter post-boot headroom refused both rungs silently; the 02:21 and 02:36 renders are full size, so watch one more cold boot before calling that closed. Original text: on 2026.9.7 the hourly panel — a JS-app SVG in the lower
  `render/split` cell — rendered at 286×229 centred in a 1200×960 cell of
  black (user report 2026-09-05; the browser preview never showed it). Cause:
  since 8f8ea8ef / 2026.9.0 the SVG size went through
  `boundedRequestedDimensions` before the into-target check; with 2 MB PSRAM
  free but an 848 KB largest block the bound hit its 65,536-pixel floor, the
  cell render was skipped, and `render/image` (placement "center") drew the
  small raster as-is. Fixed: the offered cell is painted directly first, with
  a degrade-and-stretch ladder only on refusal. Verify: after the OTA the
  chart fills the lower cell again and the log shows no `render:degraded`
  with `"source":"svg"` (if it does, the panel is soft, not tiny, and the
  line names the headroom). Until then, setting the scene's `render/image`
  placement to `contain` is a working stopgap on 9.7.

### Older pending hardware item

- [x] **13.3" E hardware SPI fix:** closed 2026-08-22 — frame 62 was built,
  delivered and worked on the `spi0-0cs` dual-CS overlay; the frame is long
  gone, nothing left to validate.

### CI / the release itself

- [x] **EPYC runner pool (#381):** several **FrameOS cross compilation**
  runs have gone through the self-hosted pool since (latest 2026-08-21,
  success).

- [x] **The release run is a test (#381):** `docker-publish-multi` has run
  twice since #381 (2026-08-20, both success) — `epyc-32` and the Depot
  esp32-ci path are validated.

- [x] **First release after #442 + #444:** release 2026.9.2 (2026-09-03)
  carries the six per-layout ESP32 images with signatures and the signed
  wasm bundle. Eyeballed on 2026.9.5 (below): the npm publish downloaded the
  run's bundle and the preview says "runtime 2026.9.5".

- [x] **Release 2026.9.5 (2026-09-04, run 33879206436):** every job green;
  75 assets, the same set as 9.4; the runtime in the amd64 archive is
  stamped `2026.9.5+e0ee71ef…` (the forced `frameos` entry works) and the
  ESP32 app images carry `2026.9.5` + their own platform string
  (`esp32-s3-32mb`); npm-publish run 33879498435 used `RUNTIME_RUN_ID`
  33879206436 and published frameos-wasm / frameos-editor 2026.9.5; Discord
  posted; the `workflow_run` cloud deploy (33881094450) went to production
  and `/s/<scene>` shows "runtime 2026.9.5"; the cloud offered the release
  to frames within the 5-min release cache. Rollout: Wood7.3 took it on its
  own OTA check at 14:07 UTC (before anyone pressed anything, ~70 s
  download, `bootedFrom ota_0`, `version 2026.9.5`); Cloud-W (armv6, root)
  `scheduled → running → success` in 2 min; uus2w through the door — see
  §2b for the driver-mode bug it found. Not upgraded: SuurESP, Cloud-5,
  E1004 (battery), E1002 (kept on 9.4 for the USB-update test).

- [x] **Release 2026.9.6 (2026-09-04, run 33888244540, the door-mode patch):**
  green; 75 assets, same set; runtime stamped `2026.9.6+35d34e6f…`; npm,
  Discord and the cloud deploy all ran. The cloud offered it ~10 min after
  publish (in-process 5-min cache behind Next's own 5-min fetch cache).
  Rollout at 15:44 UTC to every frame: Wood7.3, SuurESP, Cloud-W, uus2w
  (door, see §2b), Cloud-5 (9.4 → 9.6 directly through the door — its journal shows
  `driver:shared … loaded: true` for frameBuffer.so and evdev.so from the
  9.6 release dir at 15:44:33, so the fix also heals a frame that skipped
  9.5), E1004 and
  E1002 (both took it on their next battery wake within minutes) — all on
  9.6 by 15:48 UTC; Cloud-2W has been offline since 2026-08-21.

- [x] **Release 2026.9.7 (2026-09-04, run 33921158592):** every job green
  (25/25); 75 assets, the same set as 9.5/9.6; the runtime in the
  bookworm-amd64 archive is stamped `2026.9.7+bb883a31` and matches
  `versions.json` (the forced `frameos` entry still works). npm published
  `frameos-wasm@2026.9.7` (`frameos-editor` stayed 2026.9.5 — `versions.json`
  did not bump it); Discord posted; the `workflow_run` Cloud CI deploy
  (33923510280) went to production and prod `/frameos-wasm/version.json`
  reads 2026.9.7 / commit `fb6f501f`; the cloud offers the release
  (`update_available: true`, all 8 ESP32 layout images + 3 buildroot
  `.img.gz`). **Slower pickup than 9.5:** 80 minutes after publish no frame
  had taken it on its own (9.5 was picked up ~9 min in) and Wood7.3's log had
  no `ota` line since its 20:39 session start; uus2w was updated by hand at
  01:20 CEST. Its upgrade ran through the door — `FrameOS privileged:
  install-release ok in 32.88s`, `release activation` symlinked
  `release_upgrade_20260904231950_2026_9_7`, both `driver:shared` lines
  `loaded: true` off `drivers/*.so` at 0644 — and afterwards `User=frameos`,
  `Uid: 990`, `Groups: 28 108 990`, `CapEff: …04000000`, `frameos --version`
  prints `2026.9.7+bb883a31…` and exits 0 (#2257fc5f), `system/index` renders
  163 ms once a second at 24% of one core. The reworked index screen was
  captured from the cloud: rows `Name uus2w` / `Device framebuffer ·
  1920×1080` / live `Time` with seconds / `Time zone` / `Network 10.8.0.62
  (wlan0)` / `Managed via FrameOS Cloud (cloud.frameos.net, connected)` /
  `Frame http://uus2w.local:8787` / `Remote control enabled — over an
  encrypted HTTPS connection`, footer `FrameOS v2026.9.7`; `uus2w.local`
  resolves from the Mac (10.4.0.47 → 10.8.0.62) so the advertised link is
  real, and its bare 401 is by design (the `?k=` access link is only printed
  for an unmanaged frame). **Found and fixed on main 2026-09-05 (`eb4d40f0`, needs a cloud deploy):** the cloud `upgrade`
  command ran twice — the upgrade restarts FrameOS before the ack flushes, so
  the hub read it as a lost write and redelivered it; the new runtime re-ran
  `frameos upgrade --yes` at 01:20:28 and answered `up_to_date` at 01:20:34.
  `notify_update_available` now joins reboot/restart_runtime in
  `redeliverSentCommands` — written to a socket once, never requeued.
  **Rollout 2026-09-05 00:44-01:03 UTC (all by hand from the MCP; the ESP32
  periodic check is 24 h — `fos_ota_start_periodic_task` default — so 9.5's
  9-minute pickup was the tick landing by luck):** Cloud-W (armv6, root,
  `systemd-run`) 9.6 → 9.7 in 97 s with exactly one `updateAvailable` /
  `scheduled`; Cloud-5 (Pi 5, door) `install-release ok in 13.65s`, drivers
  loaded, `User=frameos`; Wood7.3 and SuurESP acked within a second and
  came back on 9.7; E1004 took it on its 00:01 wake; E1002 queued for its
  00:41 wake. **Three findings, all fixed on main the same night:** (1) the
  hub fix above had NOT reached production — Cloud CI for `2a17e13d` stood
  down because a docs-only commit (`0c64d38f`) moved main, and a docs-only
  tip gets no run of its own, so prod stayed on `fb6f501f`; the freshness
  step now ships the tip when the commits in between touch none of the
  workflow's inputs. (2) The reason the door frames ever saw a second nudge:
  on the door path `scheduleFrameOSUpgrade` ran `sh -c 'nohup … &'` through
  the *captured* runner, the backgrounded child inherited the runner's stdout
  pipe, and `runProcessPiped` waited for an EOF that only came with the
  restart — the cloud session thread sat there for the whole upgrade (Cloud-5:
  `> sh -c nohup` at 01:52:25.755, no `scheduled` line ever, restart at
  :53; uus2w: `device.heartbeat_timeout` on the hub 36 s after the nudge),
  so the ack never went out and the hub redelivered on reconnect. Root
  frames never had it (`systemd-run` inherits nothing). Now
  `runSetupCommandDetached` (parent streams, `</dev/null`), with a
  `test_upgrade` case that fails at 20 s on the old code. (3) On Cloud-5's
  root setup `timedatectl set-timezone` failed with `Read-only file system`
  and the `ln -sfn` fallback set the zone — handled, and the `/etc/timezone`
  sync now runs on that branch too. Also noted: Cloud-5 shows `in_sync:
  false` because it has no `/dev/fb0` (no HDMI cable), reports
  `scenes_checksum: ""` and sits on `system/index` — bench quirk, not 9.7.

- [x] **Release 2026.9.8 (2026-09-05, run 33936898925, dispatched after the
  a9288f82 CI set was green):** every job green (25/25); 75 assets; runtime in
  the bookworm-amd64 archive stamped `2026.9.8+411cae43` = `versions.json`;
  `frameos-wasm@2026.9.8` on npm; Discord posted; the `workflow_run` Cloud CI
  deploy landed prod on `56a93c5f` at 02:06 UTC; the cloud offered the
  release within a minute. Rollout by hand at 02:02 UTC: uus2w (door,
  `install-release ok in 31.50s`), Cloud-5 (door, 11.00 s), Cloud-W (root),
  Wood7.3, SuurESP at once; E1004 on its 02:04 wake, E1002 on its 02:41 wake.
  **Hub half of the door-upgrade fix verified:** both door frames reconnected
  with `pendingCommands: 0`, no `command.redelivering`, and neither ran a
  second `upgrade --yes`. The device half (50fcbcc2, the un-blocked cloud
  thread) cannot show on this OTA — the 9.7 binary ran it, so uus2w still
  produced one `device.heartbeat_timeout` 52 s after the nudge; verify at the
  9.8 → next OTA: a `"status":"scheduled"` line within a second of
  `cloud:updateAvailable`, no heartbeat timeout. **`/etc/timezone`:** Cloud-5
  now reads Europe/Brussels (set by the 9.7 fallback branch); uus2w still
  `Etc/UTC` — `setupTimezone` returned at "already Europe/Brussels" before the
  sync ran. Fixed on main the same night (the early return syncs too;
  `test_setup` pins it; `661abf5d`, in the next release).

## Not on the list, deliberately

- PR #351's lone `- [ ] CI` box — CI has run dozens of times since; stale.
- #371 (thin-client dithering), #367 (chunked uploads), #364/#365, #369/#370
  — landed with fully-ticked test plans and no outstanding manual items; the
  C3/X4 session in §4 exercises the dithering and chunked-upload paths
  incidentally.
