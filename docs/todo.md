# FrameOS — remaining work

One tracker for everything still open across the repo. Reference material —
principles, permission scopes, store decisions, threat models, wire
protocols, measurements — lives in the linked docs; this file only lists
what is left to do. When an item ships, delete it here.

Standing rule (also in AGENTS.md): frame-facing features and fixes land on
BOTH control planes (self-hosted backend and cloud) unless explicitly
one-sided. Doctrine in `docs/cloud-frames.md`, parity matrix in
`docs/api-triality.md`. Terminal / ping / debug panels are backend-only by
design — the cloud protocol has no shell verbs.

## Cloud launch — operator follow-ups

- **Fill in `FRAMEOS_LEGAL_*` in prod** (company name, address, KBO/BCE
  number, VAT number, representative, contact email). The legal pages show
  a visible `[TO BE COMPLETED]` warning and `/admin` lists it as a required
  setting until this is done. Have a lawyer read `/legal/terms`,
  `/legal/privacy` and `/legal/imprint` before broad signup.
- **Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`** from a
  Cloudflare Turnstile widget. The site key is inlined at build time, so it
  must be present on the machine that runs the build, not only on the
  server; `/admin` → Live checks reports a half-configured deploy.
- **Remove the Discord webhook path** (`DISCORD_REPORTS_WEBHOOK_URL`,
  `signup-notifications.ts`, `discord.ts`) — notifications go through
  PostHog. The privacy policy already omits Discord, so leave the env var
  unset until the code is gone.
- **Second transactional email provider** — Postmark is a single point of
  failure gating every login; its failure is visible (`/admin` live check,
  error tracking) but not survivable. Add a second provider with automatic
  failover, or at least a documented manual cutover. Before charging, not
  before signups.
- **Telemetry scope backfill** — frames enrolled before 2026-08-03 predate
  the telemetry scope and ship no logs. Known SQL fix on `linked_clients` +
  a reconnect; no UI for it. Run the one-off in prod.
- **Seed `verified_publisher_at`** in prod for the accounts that should
  have it (SQL one-off; no admin toggle yet — see below).
- **Bootstrap already-deployed buildroot frames on ≤ 2026.8.21** once by
  hand (scp the release tarball and stage it) — their cloud OTA downloader
  cannot fetch https, so they cannot self-upgrade into the fixed binary.
- Disposable-email blocking was considered and skipped: Turnstile plus the
  rate limiter covers the automated case. Revisit only if abuse is observed.

## Cloud-managed frames

- **Cloud frame settings parity + an honest Settings panel** — cloud-managed
  Linux/Pi frames render nearly the full self-hosted per-frame form, but
  cloud save/diff/readback only support the declarative base keys (`name`,
  `debug`, `interval`, `rotate`, `scaling_mode`, `timezone`; schedule and
  service secrets use their own paths). Most visible controls are therefore
  unsaveable and may appear to save while being dropped. First make the
  surface honest: hide unsupported sections or disable them with an
  explanation, and never render an editable field the active device profile
  cannot round-trip.

  Then widen `set_settings` in small, validated batches, keeping the shared
  SPA payload list, auth-web validator/readback, Pi/Nim allowlist, ESP32
  handler (where applicable), docs, and drift tests in lockstep:

  - Straightforward Pi/Linux candidates: `flip`, `error_behavior` (mode and
    retry timings), `control_code` (enable, placement, size/padding,
    offsets, colors).
  - With explicit bounds/policy: `metrics_interval` (with a working
    disabled value), platform-capped `max_http_response_bytes`,
    `save_assets` (boolean/per-app, respecting disk quotas). For
    `timezone_updater`, expose only enabled/hour; keep the download endpoint
    fixed — never accept an arbitrary update URL from the provider.
  - Hardware-aware: custom display `palette` colors, the strict
    partial-refresh subset of `device_config` (`partial`,
    `partialMaxAreaPercent`, `partialMaxRefreshesBeforeFull`), `gpio_buttons`
    (pin + label). Validate against the reported panel/platform, advertise
    capability/version requirements, restart the runtime when the driver
    only reads them at init. Never allow the whole `device_config` object.
  - ESP32: `max_http_response_bytes`, debug logging, GPIO buttons are
    plausible (NVS fields exist); add only what the firmware consumes and
    keep the whole-payload rejection contract. The cloud power controls stay
    their own ESP32-only subset.
  - Automatic reboot: implement as a real cloud-safe scheduler capability
    (possibly via the schedule verb), not a persisted inert object.
    Brightness once the runtime and drivers gain a real setting.

  Do **not** add `image_engine` to the cloud allowlist — remove ImageMagick
  instead: converge on Pixie, migrate/ignore old `imagemagick` values, drop
  the Settings selector and ImageMagick-specific paths, test that existing
  frames degrade cleanly.

  Keep provisioning, credentials, and host authority local: deployment
  mode, panel/driver/VCOM/dimensions, flash and GPIO wiring, SD-card wiring,
  Wi-Fi/hotspot credentials, private-network elevation, frame
  HTTP/admin/TLS access and keys, SSH/backend/agent configuration,
  mountpoints, HTTP-upload URLs/headers, arbitrary update URLs, and service
  API secrets must not ride `set_settings`. Do not expose raw `assets_path`
  or `log_to_file` paths; if wanted remotely, redesign as bounded toggles on
  fixed FrameOS-owned directories. Hardware identity reported by the frame
  stays authoritative.

- **Cloud AI chat follow-ups** — app-code chat (`/api/ai/apps/chat` answers
  501); a settings UI for the `chatModel` / `chatReasoningEffort` overrides
  and the verified-publisher admin toggle (both API-only); letting the chat
  save/fork scenes directly (today it delivers to the editor and the user
  saves).
- **Power section for backend-managed ESP32 frames** — the wire is done
  (settings poll sends deepSleepOnBattery/wakeCheckSeconds/batteryPin/
  batteryDivider from device_config, firmware applies them) but only the
  esp32 CLOUD profile renders the Power UI; backend users configure via USB
  console / device_config.
- **Account hardening** — passkeys/TOTP 2FA, re-authentication for sensitive
  actions (revoking frames, bulk assignment changes, scope grants), per-frame
  audit trail surfaced in the UI.
- **Panel-displayed link code** — show the enrollment code/QR on the e-ink
  panel itself (proof of possession), not just the portal/admin page.
- **Backend↔cloud promotion/demotion ceremony** — an explicit local action
  that moves a frame between control planes without a reset (UX open).
- **Free-tier quotas** — pick numbers (frame count, backup size, private
  scene count) when provisioning starts, not before.

## ESP32

Memory measurements, the emergency-reserve decision, boot/render cost
numbers and the measurement tooling live in `docs/esp32-memory.md`.

- **Surface memory over a channel that survives the link being down** — the
  workspace advisory reads device metrics, so a frame too low on internal
  RAM to connect reports nothing and cannot be flagged. A frame already over
  the edge is visible over USB and nowhere else.

## Buildroot images

Three Raspberry Pi platforms ship with published base images:
`raspberry-pi-64` (Zero 2 W / Pi 3 / Pi 4, the default), `raspberry-pi-32`
(every ARMv6 board: Zero, Zero W, Pi 1, CM1) and `raspberry-pi-5` (Pi 5 /
CM5).

- **Deferred models** — Pi 500 and CM5 Lite need `bcm2712-rpi-500` /
  `bcm2712-rpi-cm5l-*` DTBs that entered rpi-6.6.y after the kernel commit
  Buildroot 2025.02.13 pins; the next Buildroot (or kernel-pin) bump adds
  them to `raspberry-pi-5` for free — widen
  `BR2_LINUX_KERNEL_INTREE_DTS_NAME` then. Pi 2 (BCM2836, ARMv7) is
  deliberately unsupported: it is the only Pi needing its own 32-bit
  `kernel7.img` and Buildroot builds one kernel per image.

## Cloud services (scope table in CLOUD-TODO.md)

- **Apps in the store** (not just scenes) — needs a code-review/signing
  story first: signing, provenance, maybe human review before listing.
- **Photo gallery service** (`gallery:read`) — curated feeds usable as image
  sources in scenes, quota-limited free tier.
- **Asset backup** (`backup:assets`) — client-side encryption (key never
  leaves the user), content-addressed chunks, resumable.
- **Remote access** (`remote:access`) — persistent outbound WebSocket tunnel
  from backend/frame to a cloud relay (pattern in
  `app/ws/remote_bridge.py`); explicit local toggle, visible "tunnel open"
  status.
- **Direct frame login from the cloud** via that relay (`/admin` handoff).
- **Observability for linked backends** (`telemetry:logs` /
  `telemetry:metrics`) — log shipping + retention, metrics dashboards,
  uptime/offline alerts. Backend-link side only; cloud-managed frames are
  covered.

## Store

- Move blobs to object storage + CDN when size demands it; drop the
  20-version prune. Deferred on purpose: ~100 MB/account caps make Postgres
  fine for launch; stored sha256 + size_bytes make the move mechanical
  (`cloud/STORE-TODO.md`).

## Cloud service (auth-web)

- Operator-facing audit/event export — only when there is an operator
  surface.
- Keep out until there is a concrete product design (scope names already
  reserved in the device-flow allowlist): organizations, projects,
  memberships/invitations, hosted backend lifecycle, billing and metered
  quotas, placeholder service/UI packages (`cloud/TODO.md`).

## Security (open in docs/cloud-security-review.md)

- The frame stores its link token in plaintext (`state/cloud_link.json`,
  0600) — fix when there is hardware-backed key storage, or by redaction if
  the state file ever travels (support bundles, backups).
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
  pre-review for risky (shell-app) scenes? Currently automated moderation +
  badges + post-moderation only.
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
- Thin-client frames on the cloud (ESP32-C3, embedded Pi/Pico): serving
  them means the cloud renders every frame for them, i.e. free cloud
  rendering forever for everyone. Decide before building; until then C3
  boards stay out of the cloud flasher.

## Ideas parking lot (unscheduled)

- **SVG `<text>` support in render/svg** (~1–2 days, ~150–250 lines).
  Today any `<text>` tag makes the whole SVG fail, and the AI scene prompt
  tells models to layer render/text instead. Pixie has the parts: the
  fork's SVG parser (`pixie/src/pixie/fileformats/svg.nim`) turns tags into
  `(Path, SvgProperties)` pairs and `fonts.nim` does text→path (`typeset`,
  `getGlyphPath`, private `computePaths`). A `"text"` case in
  `parseSvgElement` typesets the inner text and appends glyph paths
  translated by `(x, y − ascent·scale)`; fill, stroke, gradients,
  transforms and banded rendering then work for free. Design question: font
  resolution — `parseSvg` needs a `resolveTypeface(family)` hook, FrameOS
  plugs in `getTypeface()` from `frameos/utils/font.nim`; unknown families
  degrade to the default, never fail. v1 cuts: no `<tspan>`, no
  `textLength`/`letter-spacing`, minimal `dominant-baseline`, no complex
  shaping, no emoji (color glyphs are bitmaps). Preferred home: the pixie
  fork. Follow-ons: update BOTH cloud AI prompt copies
  (`cloud/apps/auth-web/src/lib/ai/prompts.ts` + the ai-scene prompt).
- **quickts: parse TypeScript straight into QuickJS** — strip TS syntax at
  parse time so apps ship `.ts` source and the separate transpiler pass, and
  the transpiled copy every runtime keeps, disappear.
- **ESP32: parse/transpile scenes at deploy time** — shelved: cold-boot
  transpile is only ~3.3 s and shipping readable TS source is a feature.
  Revisit only if boot time or flash budget becomes a real constraint.
- Fleet features: one cloud account administering many backends
  (installer / digital-signage); cloud-side "all my frames" dashboard.
- Shared household access: invite a second account to a backend with a
  role (the `cloud_membership` table anticipates this).
- Notifications: deploy finished / frame offline → push/email.
- Community scene of the day / featured gallery as an opt-in feed.
- Hosted backends: run the whole backend in the cloud (out of scope for the
  cloud-frames design; separate product if ever).
- E-ink-friendly weather/calendar data proxy (normalized upstream APIs, one
  key, cached) so users don't need per-service API keys.
- Fleet extras: offline alerting/notifications, backups integration,
  paid-tier gating.
- ESP32 spill follow-ups: proactive Content-Length trigger; URL+ETag decode
  cache.
- ESP32 board nice-to-haves: parallel firmware builds (shared
  `generated_config.h` + nimcache serialise under the build lock), portal
  Wi-Fi scan list + AP password, mDNS advertisement, log persistence across
  offline periods, firmware artifact GC, deep-sleep improvements.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384`) and
  cJSON likewise (`cJSON_InitHooks`; measure first).
