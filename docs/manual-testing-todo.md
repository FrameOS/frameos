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

- [ ] **2FA end-to-end (#377):** on `/account/security` enroll TOTP **and** a
  passkey → sign out → sign in lands on `/login/verify` and both factors
  work; also try "Sign in with a passkey" directly on `/login`. Then open a
  cloud frame and confirm the new Activity (audit trail) panel populates.
  Passkeys need a secure context: `localhost` or HTTPS.
- [ ] **Re-auth click-through (#378):** with a session older than 15 min,
  revoke device access / grant a scope → `/login/reauth` appears; verify at
  least the password proof and one of TOTP/passkey/recovery-code proofs
  complete and the action then succeeds. (Integration-tested only, never
  clicked through in a browser.)
- [ ] **Two-tier re-auth windows (#382):** a ~20-min-old session can still
  **approve** a pending frame but is refused on **revoke**; past 2 h both
  prompt for re-auth.

## 2. Pi / Buildroot bench — cloud-managed frames

- [ ] **Auto-confirm enrollment (#382):** flash a personalized SD card, boot
  it, watch the frame appear **active with no Confirm step** in the cloud
  workspace (single-use card born active; a multi-use card's first boot is
  active, later cards pending).
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
