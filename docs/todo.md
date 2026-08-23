# FrameOS — what is still open

Everything left to do across the repo, in one file. It is written to be read
cold: each section says what that part of FrameOS *is* before it says what is
missing from it. Reference material — principles, permission scopes, threat
models, wire protocols, measurements — lives in the linked docs; this file only
carries the work. **When an item ships, delete it.**

Two rules that shape most entries:

- **Both control planes.** FrameOS frames are managed either by a self-hosted
  backend or by FrameOS Cloud. A frame-facing feature lands on both unless it
  is explicitly one-sided. Doctrine in `docs/cloud-frames.md`, parity matrix in
  `docs/api-triality.md`.
- **The cloud has no shell verbs, on purpose.** Terminal, ping and debug panels
  are backend-only by design, not by omission. A stolen cloud account must not
  become a shell on someone's LAN. `docs/buildroot-privileges.md` audits how
  close that is to true.

---

## ESP32 memory

- **Scene switch leaks ~1.6 MB of PSRAM** (13.3" 16 MB board, 2026.8.34, log
  2026-08-22T22:04Z): switching "SD card image" → "Unsplash image" (which
  rendered its missing-API-key error frame) dropped idle free PSRAM from
  10.3 MB to 8.7 MB and the largest block from 7.4 MB to 6–7 MB; switching
  back did not recover it. No OOM abort was logged. Find what the old
  scene's teardown keeps (cached image? QuickJS runtime? error-frame
  intermediates?) — with the SD scene's 24 MP photos the headroom is thin
  enough that this leak is what made the next abort possible.
- **Verify on hardware**: `memory:oomAbort` + leak-percent restart and the
  `render:degraded` event (docs/esp32-memory.md, 2026-08-23). Cheapest
  repro: assign a scene that fetches an oversized image with the budget
  forced low, watch the cloud log for both events.

## Pre-release manual test sweep

`docs/manual-testing-todo.md` collects every unticked manual checkbox and
"needs hardware" note from PRs #362–#382, grouped by test bench. Work it
before the next release; delete it when empty.

---

## Frame privileges and FrameOS Remote

Audited 2026-08-16; findings and the full reasoning in
`docs/buildroot-privileges.md`. The short version: a stolen cloud account
already cannot get a shell, cannot reach the LAN from the frame (default-deny
lifted only by a code read off the panel) and cannot install unsigned software.
What is left is that everything on the device runs as root. FrameOS Remote —
the root agent with `shell`, a PTY and arbitrary file write — no longer ships
enabled on images that have no backend to talk to.

- **Verify on hardware that a generic card still adopts.** Release images now
  ship `agentEnabled: false` (the audit's §2 recommendation), so a Buildroot
  frame flashed from a generic image and *then* adopted by a backend needs the
  one `systemctl enable` that the backend's first deploy already does through
  `frameos setup`. The cost looks like zero, and that is worth seeing on a real
  card before believing it.
- **Run `frameos.service` as a `frameos` user.** The plan, the privileged call
  sites and the suggested sequencing are in `docs/buildroot-privileges.md` §3.
  Privileged work moves behind one narrow enum-only door (`apply-setup`,
  `apply-network-profile`, `reboot`, `install-ota <staged-dir>`) so OTA stays
  smooth: download and signature verification are already unprivileged, and
  only the final install crosses the line. Blocked on hardware time, not on a
  decision. The SPI/GPIO panel drivers are the part to measure first.

---

## Canonical API gaps

Matrix in `docs/api-triality.md`; nothing scheduled — the remaining deltas
(ESP32 field coverage, canonical Pi asset-mutation aliases) live in that
file's "Current gaps".

---

## Open questions (decisions, not code)

- Billing mechanics — Stripe? bundled tiers vs per-service metering? Decide
  before anything paid ships.
- `store:publish` human review: always, only for the public store, or
  pre-review for risky (shell-app) scenes? Today it is automated moderation +
  badges + post-moderation only.
- Unpublish policy: owners delete outright today. Switch to yank-only plus
  support-mediated deletion once anything can depend on a scene.
- Usernames / publisher handles — the store works without them; the first real
  need is publisher pages.
- Asset-backup key recovery UX. The answer has to remain "we cannot read your
  photos".
- One backend link per installation, or per organization/project?
- Thin-client frames on the cloud (ESP32-C3, embedded Pi/Pico): serving them
  means the cloud renders every frame for them — free cloud rendering forever,
  for everyone. Decide before building; until then C3 boards stay out of the
  cloud flasher.

---

## Parking lot (unscheduled, and fine as it is)

**New cloud services are not being built.** The scope names below are reserved
in the device-flow allowlist and the designs are sketched, but none of them is
planned work — as with organizations, projects, memberships, hosted backend
lifecycle and metered billing (`cloud/TODO.md`). Disposable-email blocking
belongs on the same list: Turnstile plus the rate limiter covers the automated
case, so it is skipped until abuse is actually observed.

- **Photo gallery service** (`gallery:read`) — curated feeds usable as image
  sources in scenes, quota-limited free tier.
- **Asset backup** (`backup:assets`) — client-side encryption (the key never
  leaves the user), content-addressed chunks, resumable.
- **Remote access** (`remote:access`) — a persistent outbound WebSocket tunnel
  from backend or frame to a cloud relay (pattern in `app/ws/remote_bridge.py`),
  with an explicit local toggle and a visible "tunnel open" status — and direct
  frame login from the cloud over that relay.
- **Observability for linked backends** (`telemetry:logs` / `telemetry:metrics`)
  — log shipping and retention, metrics dashboards, uptime/offline alerts.
  Backend-link side only; cloud-managed frames are already covered.
- **Apps in the store** (not just scenes) — needs a code-review/signing story
  first: signing, provenance, possibly human review before listing.

Everything else parked:

- **Backend↔cloud promotion/demotion ceremony.** An explicit local action
  that moves a frame between control planes without a factory reset. UX is
  open; a half-built attempt was dropped in 2026-08. Today the answer is
  re-enrolling from the other side.
- **ESP32: full web admin shell parity.** The device API is close to
  complete — what is left is the admin UI the Pi serves and the ESP32 does
  not. Parked until someone actually misses it on a board.
- **Operator-facing audit/event export** (auth-web) — only once there is an
  operator surface to put it on.
- **Deferred Pi models.** Pi 500 and CM5 Lite need `bcm2712-rpi-500` /
  `bcm2712-rpi-cm5l-*` DTBs that entered rpi-6.6.y after the kernel commit
  Buildroot 2025.02.13 pins; the next Buildroot (or kernel-pin) bump adds them
  to `raspberry-pi-5` for free — widen `BR2_LINUX_KERNEL_INTREE_DTS_NAME` then.
  Pi 2 (BCM2836, ARMv7) is deliberately unsupported: it is the only Pi needing
  its own 32-bit `kernel7.img`, and Buildroot builds one kernel per image.
- **Remove the Discord webhook path** (`DISCORD_REPORTS_WEBHOOK_URL`,
  `signup-notifications.ts`, `discord.ts`) — notifications go through PostHog
  now. Held deliberately: the PostHog path has not had a live report to prove
  itself on, and deleting the fallback first would mean finding out it does not
  work by missing a report. Delete on the first real notification through the
  new path. The privacy policy already omits Discord, so the env var stays
  unset until then.
- **A second transactional email provider.** Postmark is a single point of
  failure gating every login; its failure is visible (`/admin` live check, error
  tracking) but not survivable. Deferred not because it is hard but because
  doing it properly means failover logic, health checks and a tested cutover —
  real work, for a handful of mails a day. Revisit at dozens of mails a day, or
  before anything paid ships.
- **Surface ESP32 memory over a channel that survives the link being down.**
  The workspace advisory reads device metrics, so a frame too low on internal
  RAM to connect reports nothing and cannot be flagged. A frame already over the
  edge is visible over USB and nowhere else.
- **quickts: parse TypeScript straight into QuickJS** — strip TS syntax at parse
  time, so apps ship `.ts` source and both the transpiler pass and the
  transpiled copy every runtime keeps disappear.
- **ESP32: parse/transpile scenes at deploy time** — shelved. Cold-boot
  transpile is only ~3.3 s and shipping readable TS source is a feature. Revisit
  only if boot time or flash budget becomes a real constraint.
- Fleet features: one cloud account administering many backends (installer /
  digital signage); a cloud-side "all my frames" dashboard.
- Shared household access: invite a second account to a backend with a role
  (the `cloud_membership` table anticipates this).
- Notifications: deploy finished / frame offline → push or email.
- Community scene of the day, or a featured gallery as an opt-in feed.
- Hosted backends: run the whole backend in the cloud. Out of scope for the
  cloud-frames design; a separate product if ever.
- An e-ink-friendly weather/calendar data proxy (normalized upstream APIs, one
  key, cached) so users do not need per-service API keys.
- ESP32 spill follow-ups: a proactive Content-Length trigger; a URL+ETag decode
  cache.
- Publish a 16MB ESP32-C3 release asset. "Flash latest release" provisions a
  XTEINK X4 from the 4MB no-OTA generic image today, which works but leaves
  three quarters of the chip and OTA unused — the flasher warns about exactly
  this. A `esp32-c3-16mb` asset in the release job removes the warning.
- ESP32 board nice-to-haves: parallel firmware builds (shared
  `generated_config.h` and nimcache serialise under the build lock), a portal
  Wi-Fi scan list and AP password, mDNS advertisement, log persistence across
  offline periods, firmware artifact GC, deep-sleep improvements.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384`) and cJSON
  likewise (`cJSON_InitHooks`). Measure first.
