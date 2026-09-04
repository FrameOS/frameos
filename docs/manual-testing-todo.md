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
- [x] **ESP32 time zone (#388 + #416)** — closed 2026-09-04: the word-clock and weather scenes have run around the house on the 2026.9.x releases with correct local time (user-verified), which covers the scene-hours half; the console/scheduler half below. Original 2026-09-04 note on 2026.9.4: console `status` on E1002 shows `time_zone: Europe/Brussels` / `tz_data: CET-1CEST,M3.5.0,M10.5.0/3`; a schedule entry on Wood7.3 fired at 12:53 *local* (`schedule:fire hour 12 minute 53` at 10:53 UTC). Not eyeballed: weather-scene hours and a code node's `format()` (E1004, the weather frame, has no zone set). A private "Time zone check" scene (code node: `format(now(), "{hour/2}:{minute/2}:{second/2}")` + `Date` UTC on one text node; server preview showed 15:04 local / 13:04 UTC) was installed and activated on E1002 at 13:05 UTC 2026-09-04 while the board slept (next wake 14:09 UTC, or a button press) — tick this once its screenshot shows local = UTC + 2 h. Original text (needs firmware built after
  2026-08-30): set Europe/Brussels from the cloud settings panel → weather
  scene hours match local time (a code node's `format()` too), schedule
  entries fire in local time, `config` on the console shows it.
- [~] **First-boot cloud enrollment on a router that strips DNSSEC (#384,
  #420):** half verified 2026-09-04 on the Zero W `Cloud-W`
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
- [ ] **First-boot driver setup actually runs (fixed on main 2026-09-04):**
  the same Zero W boot logged `Running driver setup for device 'framebuffer'`
  → `FrameOS fatal: cannot open: ./frame.json` → `Warning: driver setup
  failed; run it again from the setup portal` (`frameos-setup-reset.sh`
  ran the binary from `/`, and it reads `./frame.json`). Harmless for a
  framebuffer, but an SPI panel on a fresh cloud card got its overlays only
  from the portal's driver setup. Verify on a card composed after the fix:
  the first-boot journal shows `FrameOS setup: driver setup: complete`
  (and, for an SPI panel, `dtoverlay`/`dtparam` lines in `/boot/config.txt`
  on the very first boot).
- [ ] **Panel link code (#379):** boot an unclaimed frame in cloud mode with
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

### Context for picking this up cold (written 2026-09-03, PR #415 green, not yet merged)

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

- [ ] **0. Baseline on 2026.9.2, before merging.** Upgrade the two cloud
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
- [ ] **4. Fresh image first (reflashable):** flash `raspberry-pi-5` 9.3 on
  pi5, enroll into the cloud, run the "boots and renders as `frameos`",
  "door answers", "hotspot and portal" and "runtime cannot escalate"
  boxes below. Then `raspberry-pi-64` 9.3 on pi2w for the same boxes.
- [~] **5. Migration to the `frameos` user on a NetworkManager frame** —
  IN PROGRESS 2026-09-04 on `Cloud-5` (Pi 5, `raspberry-pi-5`, framebuffer
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
- [ ] **7. Regressions:** deploy from localhost:8616 to one Waveshare frame
  (still root, still renders); after the HA add-on has the 9.3 image, deploy
  to one HA frame. Neither should have a `frameos` user or the door active.
- [ ] **8. Link cases** (the last box in this section) on whichever
  migrated frame is handiest, over SSH.
- [ ] **9. Afterwards:** tick the boxes here, move anything that broke into
  `docs/todo.md`, and delete this section once everything passed. If a
  migrated frame ends up unusable, reflash it with the 9.3 image — the
  FRAMEOS partition layout is stamped by the composer, so a fresh card is
  always the known-good state.

- [x] **It boots and renders as `frameos`** — uus2w live 2026-09-04 11:48 (SSH after the dropbear fix): `User=frameos`, `ps` shows `frameos 262 frameos`, `/` mounted `ro`, `/srv/frameos` `rw`, `/dev/fb0` `/dev/tty1` `/dev/gpiochip0` are `root:frameos 660`, framebuffer renders (172 ms scene + 481 ms driver at 1080p). SPI panel not yet checked (no SPI frame with SSH). Original text: `systemctl show -p User
  frameos.service` says `frameos`, `ps -o user= -C frameos` agrees, and a
  scene renders. Check the panel you have: framebuffer (Pi 5 / HDMI) and at
  least one SPI e-ink (Waveshare 7.5" or 13.3E, Inky) — the SPI path is the
  one most likely to trip on `/dev/spidev*` or `/dev/gpiochip*` permissions.
  `DEV_Config.c` falls back to *bit-banged* SPI when it cannot open spidev,
  so a panel that works but refreshes slowly means the group is wrong; look
  for that, do not just trust a picture.
- [ ] **The GPIO button and evdev input still fire** (uus2w has no buttons; the console claim itself is verified: `driver:frameBuffer:consoleClaimed graphicsMode:true`, no getty text over the image — and a USB keyboard cannot reach the getty, see step 5) (groups `frameos` /
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
- [ ] **OTA from a root-only release (the migration).** Flash an image from
  the *previous* release, let it enroll, then trigger "Upgrade FrameOS".
  Expect: the upgrade succeeds, `/etc/passwd` gains `frameos:x:990:990`,
  the installed unit becomes the hardened one, `/srv/frameos` ownership is
  root-code/`frameos`-state, and the frame renders after the restart.
- [ ] **OTA on an already-migrated frame** (unprivileged → door →
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
- [ ] **Root follows none of the runtime's links (2026-09-03 review).** As
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
- [~] **Battery ADC rounds (#426):** partial 2026-09-04 — E1004's 45 metrics samples since midnight (3.3 h of them on 2026.9.4) show `batteryMillivolts` steady at 4006–4020 mV, no `batteryRawMillivolts` field on any sample, no critical parking. Needs the day-or-two watch below to count as verified. Original text: hardware-unverified. The misread is
  intermittent (~9 of the E1004's ~400 daily on-battery samples read
  ~2 V instead of ~3.95 V), so confirming it means watching
  `batteryRawMillivolts` appear without `batteryMillivolts` moving for a
  day or two on a frame on battery, and no spurious "critical" parking.
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
- [ ] **Layout-matched release image (#442; release 2026.9.2 carries the
  six images):** *(2026-09-04: E1002 is still on the generic 8 MB layout —
  `flashBytes 8388608`, `otaSlotBytes 3604480`, OTA check asks for
  `esp32-s3-generic`; "Update firmware" keeps whatever layout the board has,
  so only "Add frame" → Connect & flash exercises this.)* on the XTEINK X4 (16 MB C3), "Flash latest release" picks
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
- [x] **Dual console — reTerminal E1002 over its CH340** — verified 2026-09-04 on 2026.9.4. Console half: `/dev/cu.wchusbserial10` at 115200 with DTR/RTS held low answers `frameos>`, `status`, `help`, `buttons` (the board deep-sleeps between renders on USB too — `onBattery: true`, no VBUS sense — so catch it on a timed wake or a button press; the first console line arms the 3-min keep-awake). Browser half, 14:54 local: the cloud workspace's "Update firmware" over that port wrote the release image around NVS (head at 0x0, tail at 0xd000, 3148512 bytes in 72 s), the board came back on USB in 12 s (`cloud:session_ready` 11 s after reset), answered `version=2026.9.4 panel=EPD_7in3e scenes=1/9 wifi=vaarikad`, took `upload-scenes` (289624 bytes → `stored`/`pending-apply`, 35 s) and kept its Wi-Fi and cloud identity; render #2 refreshed the panel. Not run on this port: enrolment from blank ("Add frame" → Connect & flash), which is the flow the layout boxes below need. **Found, all three fixed on main 2026-09-04 (next release / next cloud deploy):** (1) the cloud's "Update firmware" always wrote the per-chip *generic* image — `releaseFirmwarePlatformForFrame` fell back to `esp32-s3-generic` because the provisioning route only exists on the self-hosted backend — so a board enrolled on a layout-matched image (16/32 MB) was refused with "partitioned differently … re-enroll". Now the flow reads the board's partition table first and fetches the image built for that layout (`layoutPlatformForPartitions`, logs "The board is partitioned for 32MB: updating with the esp32-s3-32mb image"); the provisioning answer / generic image only when the table cannot be read. (2) On the generic 8 MB layout (`stateBytes` 1 MiB) the interpreter's disk tier could never fit an 800×480 RGBX spill: render #1 after every boot logged `interpreter:cache:imageSpill:refused … storage write failed; disk tier disabled until scenes reload` after filling the state partition. Now the spool asks the filesystem first (`fos_vfs_free_bytes` → `spoolHeadroomShortfall`, 256 KB margin) and refuses with the real reason without disabling the tier; on the 16/32 MB layouts the spill lands under `/state/spool`. (3) The first "Update firmware" click in this session failed with `Failed to execute 'open' on 'SerialPort': The port is already open` because a timed-out USB API `restart` still held the port; both flashers now wait for the USB command queue to drain (`waitForEmbeddedUsbApiIdle`) and take the port back from the log stream it resumes. To verify on the next release: a USB update of a board on the 32 MB layout picks `esp32-s3-32mb`; E1002 on that layout logs no spill refusal (or a `… free under /state/spool …` reason, never "storage write failed"); a flash started while a `status` probe is running waits instead of failing. Original text: the cloud flasher
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
