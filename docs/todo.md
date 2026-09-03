# FrameOS — what is still open

Everything left to do across the repo, in one file. It is written to be read
cold: each section says what that part of FrameOS *is* before it says what is
missing from it. Reference material — principles, permission scopes, threat
models, wire protocols, measurements — lives in the linked docs; this file only
carries the work. **When an item ships, delete it.** Larger tracks keep their
own files: security findings in `docs/security-todo.md`, architecture
convergence in `docs/convergence-todo.md`, store
content in `docs/scenes-todo.md`, the JSX widget UI in `docs/ui-todo.md`,
cloud billing in `cloud/docs/accounting-todo.md`.

**Compiled scenes are deprecated (2026-08-30).** No editor action produces
new Nim, every surface that shows a compiled scene warns and points at the
converter (scenes.frameos.net/nim-converter, the editor button, MCP
`scene_convert`, the CLI), deploys install release binaries, and
`last_successful_deploy.build_kind` records which frames still build from
source (`docs/legacy-source-builds.md`). Deleting the source-build path is
item 1 of `docs/convergence-todo.md` — not before October 2026, maybe much
later or never; until then the legacy path keeps working when asked for,
and hardening it (the unsandboxed Nim stage in `docs/security-todo.md`) is
not a priority. The "Both control planes" rule below stands.

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

- **Verify on hardware** (docs/esp32-memory.md, 2026-08-24): the Weather
  scene renders on the 16 MB 13.3" (frame 529463b4) after a reboot with no
  `memory:oomAbort`; post-render idle PSRAM stays near the ~6.9 MB
  baseline; the sky gradient shows no strip seams. The 8 MB half is done:
  the E1004 (565 canvas, strips are the only thing that fits) renders
  Weather with an 873 KB PSRAM low-water mark since the transpiler fix
  (#428, measured on the board 2026-09-01).
- **Verify on hardware** (docs/esp32-memory.md, 2026-08-23): a 24 MP photo
  cover-rendered on the 16 MB 13.3" is sharp (no `render:degraded` in the
  log — the cover window keeps the plan at 2.9 MB inside the RGBX canvas's
  ~5 MB headroom); the 7.3" weather sky renders without bands (RGBX canvas
  now; boot line `canvas: 800x480 rgbx`); the E1004's gradients are
  band-free on its `canvas: 1200x1600 rgb565 (dithered stores)`; after a
  text render idle PSRAM should drop ~0.5 MB, not 1.6 MB; `render:degraded`
  and `memory:oomAbort` appear in the cloud log when provoked (force the
  budget low with an oversized photo); the leak-percent restart fires.

---

## Pre-release manual test sweep

`docs/manual-testing-todo.md` collects every unticked manual checkbox and
"needs hardware" note from PRs #362 onward, grouped by test bench. Work it
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

- **Run `frameos.service` as a `frameos` user.** Implemented in PR #415 (uid
  990 behind the narrow enum-only door from `docs/buildroot-privileges.md` §3:
  `apply-setup`, `apply-network-profile`, `reboot`, `install-ota <staged-dir>`);
  download and signature verification stay unprivileged, only the final OTA
  install crosses the line. Unmerged — blocked on hardware testing time, not on
  a decision. The SPI/GPIO panel drivers are the part to measure first.

---

## Canonical API gaps

Matrix in `docs/api-triality.md`; nothing scheduled — the remaining deltas
(ESP32 field coverage, canonical Pi asset-mutation aliases) live in that
file's "Current gaps".

---

## Open questions (decisions, not code)

- Billing — decided 2026-09-01: postpay AI metering plus a three-plan
  ladder, double-entry ledger, one invoice a month
  (`cloud/docs/accounting-todo.md` §0). Metering is live; nothing is
  invoiced. The payment provider (§8.7 — Stripe or a merchant-of-record),
  the invoicing entity (§8.15) and the plan numbers (§8.13) are parked
  until there are users to invoice (decided 2026-09-03); the integration
  is small once needed.
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
- Thin-client frames on the cloud (ESP32-C3, embedded Pi/Pico) — decided
  2026-09-01: cloud rendering is a paid-plan entitlement, enforced as N
  frames *and* a minimum refresh interval, none on the free tier
  (`cloud/docs/accounting-todo.md` §0.2). C3 boards stay out of the cloud
  flasher until that entitlement is enforced at frame creation — item 3 of
  `docs/convergence-todo.md`.

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
- **Remove the scene-report Discord webhook** (`DISCORD_REPORTS_WEBHOOK_URL`,
  `discord.ts`, used only by the store report route). Reports now also
  capture a `store scene reported` PostHog event (the signup path already
  moved: new-user messages come from a PostHog webhook on
  `cloud user signed up`). Wire a PostHog webhook on the report event, watch
  one real report arrive through it, then delete `discord.ts`, its test, the
  env var and the `/admin` system check.
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
- ESP32 board nice-to-haves: a portal Wi-Fi scan list and AP password, mDNS
  advertisement, log persistence across offline periods, deep-sleep
  improvements.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384`) and cJSON
  likewise (`cJSON_InitHooks`). Measure first.
