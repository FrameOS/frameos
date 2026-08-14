# FrameOS — consolidated remaining work

One tracker for everything still open across the repo (last swept
2026-08-14). Reference material — principles, permission scopes, store
decisions, threat models, wire protocols, measurements — stays in the
linked docs; this file only lists what is left to do. When an item ships,
delete it here.

## ESP32 backend→cloud parity (2026-08 push — closing out)

Goal: everything the self-hosted backend can do with an ESP32 frame, the
cloud can too. Standing rule (also in AGENTS.md): frame-facing features and
fixes land on BOTH control planes unless explicitly one-sided. The doctrine
behind this push (cloud installs prebuilt binaries only, do as much as
possible in the browser, the per-surface inventory) lives in
`docs/cloud-frames.md` and the parity matrix in `docs/api-triality.md`;
only the open work is listed here.

Deliberately not gaps: terminal / ping / debug panels are backend-only
because the cloud protocol has no shell verbs — structural, nothing to close.

- **Service settings + cloud OTA: verify the Nim client on hardware** — the
  Linux/Pi client is unit-tested and build-verified only, never run against
  a real provider. (The ESP32 client has been.) The cloud OTA verb wiring
  (2026-08-13) is in the same boat: code-complete, unit-tested, no hardware
  pass. Verifying a full buildroot SD-card cloud install + update covers
  both.

  2026-08-15: the first hardware attempt (buildroot Pi, 2026.8.20 →
  2026.8.21) reported nothing after `cloud:upgrade scheduled` and the
  version never moved. The visibility half is fixed — `frameos upgrade`
  runs detached and only ever wrote `upgrade-status.json`, which the local
  admin page polls and the cloud could not see, so the hub session now
  watches that file and forwards every status change (plus a `stalled`
  line when the child dies silently, and a replay of a terminal status
  written while the frame was restarting). **Whether the upgrade itself
  works on buildroot is still unverified**: re-run it and read the new
  `cloud:upgrade` lines, which now carry the failure message from
  `performFrameOSUpgrade` when there is one.

## Cloud-managed frames

- **Cloud AI chat follow-ups** — the 2026-08-14 chat v2 rebuild (branch
  `cloud-ai-chat-v2`) replaced the ported pipeline with a streaming agentic
  loop (`/api/ai/chat`, NDJSON) with tools for the app catalog, docs,
  GitHub source, frame telemetry, and the store; it added chat persistence
  (`ai_chats`/`ai_chat_messages`), storable `chatModel`/
  `chatReasoningEffort` overrides, and a `verified_publisher_at` account
  flag. Still open: app-code chat (`/api/ai/apps/chat` answers 501), a
  settings UI for the model overrides and the verified-publisher admin
  toggle (both API-only today), letting the chat *save/fork* scenes
  directly (it delivers to the editor; the user saves), and seeding
  `verified_publisher_at` in prod (SQL one-off).
- **Power section for backend-managed ESP32 frames** — the wire is done
  (settings poll sends deepSleepOnBattery/wakeCheckSeconds/batteryPin/
  batteryDivider when set in device_config, firmware applies them) but only
  the esp32 CLOUD profile renders the Power settings UI; backend users
  configure via USB console / device_config for now.
- **Account hardening** (next up) — passkeys/TOTP 2FA, re-authentication
  for sensitive actions (revoking frames, bulk assignment changes, scope
  grants), per-frame audit trail surfaced in the UI.
- **Panel-displayed link code** — show the enrollment code/QR on the e-ink
  panel itself (proof of possession), not just the portal/admin page.
- **Backend↔cloud promotion/demotion ceremony** — the explicit local
  action that moves a frame between control planes without a reset (exact
  UX still an open design question).
- **Free-tier quotas** — pick numbers (frame count, backup size, private
  scene count) when provisioning starts, not before.

## ESP32

Memory measurements, the emergency-reserve decision, boot/render cost
numbers and the measurement tooling live in `docs/esp32-memory.md`.

- **Surface memory over a channel that survives the link being down** — the
  workspace advisory reads device metrics, so a frame too low on internal RAM
  to connect reports nothing and cannot be flagged. Today it is preventive
  only; a frame already over the edge is visible over USB and nowhere else.

## Buildroot images

- **Boot-test the consolidated platforms, then publish base images
  BEFORE the next release** — the registry now has exactly three
  Raspberry Pi platforms: `raspberry-pi-64` (Zero 2 W / Pi 3 / Pi 4 —
  absorbed the old `raspberry-pi-zero-2-w` single-model platform and is
  the new default; old key lives on as an alias and canonicalizes on
  frame create), `raspberry-pi-32` (every ARMv6 board: Zero, Zero W,
  Pi 1 A/A+/B/B+, CM1 — replaced `raspberry-pi-zero-w`, same alias
  treatment), and `raspberry-pi-5` (all BCM2712 boards with a DTB in
  the pinned kernel: Pi 5 C0+D0 and CM5 on either carrier). None has
  booted on hardware yet; minimum coverage is a Zero 2 W regression
  boot for pi-64, a Zero W regression boot for pi-32, ideally plus one
  Pi 1 / Pi 3 / Pi 4 / Pi 5. **Release-blocking**: both old manifest
  entries were removed and no new platform has a base image, so
  `docker-publish-multi.yml` now hard-fails ("No Buildroot platforms
  with cached base images found") until `buildroot-base-image.yml` has
  been dispatched for at least `raspberry-pi-64` and the manifest
  commit landed. Do that before merging this branch to main.
- **Deliberately unsupported Pi models** — Pi 2 (BCM2836, ARMv7) is
  skipped as a conscious decision: it is the only Pi needing its own
  32-bit kernel binary (`kernel7.img`) and Buildroot builds one kernel
  per image. Pi 500 and CM5 Lite are deferred, not declined: their
  `bcm2712-rpi-500`/`bcm2712-rpi-cm5l-*` DTS files entered rpi-6.6.y
  after the 2024-04 kernel commit Buildroot 2025.02.13 pins, and the
  EEPROM bootloader wants the exact model DTB — the next Buildroot (or
  kernel-pin) bump adds them to the `raspberry-pi-5` image for free;
  widen its `BR2_LINUX_KERNEL_INTREE_DTS_NAME` then.
- **Passwordless root is now an explicit choice in the cloud SD builder** —
  the builder requires either a root password (a `root_password` key in
  `frameos-cloud.txt`, applied via `chpasswd` on first boot like the
  self-hosted `frameos-root-password` file, which also re-enables dropbear
  password logins) or ticking an "enable passwordless root" checkbox that
  keeps the image default: console-only root with no password, SSH refusing
  password logins (`dropbear -s -g`, no authorized keys).

## Cloud services (scope table in CLOUD-TODO.md)

- **Apps in the store** (not just scenes) — needs a code-review/signing
  story first: signing, provenance, maybe human review before public
  listing.
- **Photo gallery service** (`gallery:read`) — curated feeds usable as
  image sources in scenes, quota-limited free tier.
- **Asset backup** (`backup:assets`) — client-side encryption (key never
  leaves the user), content-addressed chunks, resumable.
- **Remote access** (`remote:access`) — persistent outbound WebSocket
  tunnel from backend/frame to a cloud relay (pattern exists in
  `app/ws/remote_bridge.py`); explicit local toggle, visible "tunnel open"
  status.
- **Direct frame login from the cloud** via that relay (`/admin` handoff).
- **Observability for linked backends** (`telemetry:logs` /
  `telemetry:metrics`) — log shipping + retention, metrics dashboards,
  uptime/offline alerts. Backend-link side only; cloud-managed frames are
  covered.

## Store

- Move blobs to object storage + CDN when size demands it; drop the
  20-version prune. Deliberately deferred: ~100 MB/account caps make
  Postgres fine for launch; stored sha256 + size_bytes make the move
  mechanical (`cloud/STORE-TODO.md`).

## Cloud service (auth-web)

- Operator-facing audit/event export — only when there is an operator
  surface.
- Keep out until there is a concrete product design (scope names already
  reserved in the device-flow allowlist): organizations, projects,
  memberships/invitations, hosted backend lifecycle, billing and metered
  quotas, placeholder service/UI packages (`cloud/TODO.md`).

## Security (still open in docs/cloud-security-review.md)

- The frame stores its link token in plaintext (`state/cloud_link.json`,
  0600) — worth fixing when there is hardware-backed key storage, or by
  redaction if the state file ever travels (support bundles, backups).
- Frame-side `local_login_enabled` is cosmetic — persist the flag in the
  frame's cloud-link state and enforce it in the admin login before hiding
  local login fields means anything.

## Canonical API gaps (matrix in docs/api-triality.md)

- ESP32: fonts list/file routes, full web admin shell parity.
- Frame import/adoption: standalone export/source payloads; backend
  adoption flow for standalone frames.

## Open questions (decisions, not code)

- Billing mechanics (Stripe? bundled tiers vs per-service metering) —
  decide before anything paid ships.
- `store:publish` human review: always, only for the public store, or
  pre-review for risky (shell-app) scenes? Currently automated moderation
  + badges + post-moderation only.
- Unpublish policy: owners delete outright today; switch to yank-only +
  support-mediated deletion once anything can depend on a scene.
- Usernames / publisher handles — the store works without them; the first
  real need is publisher pages.
- Asset-backup key recovery UX (the answer must be "we cannot read your
  photos").
- One backend link per installation vs per organization/project.
- Fleet-previews doctrine: is browser-side wasm rendering the permanent
  answer, or is an opt-in end-to-end-encrypted screenshot path ever
  acceptable?

## Ideas parking lot (unscheduled)

- **Thin-client frames on the cloud (ESP32-C3, embedded Pi/Pico).** Parked
  2026-08-13 pending a product decision: serving these boards means the
  cloud renders every frame for them, i.e. offering free cloud rendering
  forever to everyone — decide if we want that before building. Technical
  notes: C3 has no on-device render source (the wasm harness is the
  building block); C3 boards stay out of the cloud flasher until then, and
  the pico/Inky streaming thin client would depend on a render host the
  same way.
- **quickts: parse TypeScript straight into QuickJS.** Teach the engine to
  strip/ignore TS syntax while parsing, so apps ship `.ts` source and the
  separate token-transpiler pass — and the transpiled copy every runtime
  keeps for it — disappear entirely. Would obsolete the parked deploy-time
  idea below (and the transpile-cache idea, tried and rejected —
  `docs/esp32-memory.md`).
- **ESP32: parse/transpile scenes at deploy time, not on boot.** Shelved
  2026-08-13: cold-boot transpile is only ~3.3 s and shipping readable TS
  source to the device is a feature (numbers in `docs/esp32-memory.md`).
  Revisit only if boot time or flash budget becomes a real constraint.
- Fleet features: one cloud account administering many backends
  (installer / digital-signage); cloud-side "all my frames" dashboard.
- Shared household access: invite a second account to a backend with a
  role (the `cloud_membership` table anticipates this).
- Notifications: deploy finished / frame offline → push/email.
- Community scene of the day / featured gallery as an opt-in feed.
- Hosted backends: run the whole backend in the cloud (explicitly out of
  scope for the cloud-frames design; separate product if ever).
- E-ink-friendly weather/calendar data proxy (normalized upstream APIs,
  one key, cached) so users don't need per-service API keys.
- Fleet extras (cloud-frames design phase 4): offline
  alerting/notifications, backups integration, paid-tier gating.
- ESP32 spill follow-ups: proactive Content-Length trigger; URL+ETag decode
  cache. (Spilled PNGs stream already; bench numbers in
  `docs/esp32-memory.md`.)
- ESP32 board nice-to-haves: parallel firmware builds (shared
  `generated_config.h` + nimcache serialise under the build lock), portal
  Wi-Fi scan list + AP password, mDNS advertisement, log persistence across
  offline periods, firmware artifact GC, deep-sleep improvements.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384` sends
  sub-16 KB mallocs internal) and cJSON likewise (`cJSON_InitHooks`;
  measure first, it is broad).
