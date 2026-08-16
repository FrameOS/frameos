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

## Cloud-managed frames

A cloud frame talks to `frame-hub` over one outbound WebSocket. The provider
can push scenes, a short allowlist of declarative settings and a handful of
commands; everything else stays local to the device.

- **Cloud frame settings parity + an honest Settings panel.** Cloud-managed
  Linux/Pi frames render nearly the full self-hosted per-frame form, but cloud
  save/diff/readback only support the declarative base keys (`name`, `debug`,
  `interval`, `rotate`, `scaling_mode`, `timezone`; schedule and service
  secrets use their own paths). Most visible controls are therefore unsaveable
  and may appear to save while being dropped.

  First make the surface honest: hide unsupported sections or disable them with
  an explanation, and never render an editable field the active device profile
  cannot round-trip. Then widen `set_settings` in small validated batches,
  keeping the shared SPA payload list, the auth-web validator/readback, the
  Pi/Nim allowlist, the ESP32 handler where applicable, the docs and the drift
  tests in lockstep:

  - Straightforward Pi/Linux candidates: `flip`, `error_behavior` (mode and
    retry timings), `control_code` (enable, placement, size/padding, offsets,
    colors).
  - With explicit bounds/policy: `metrics_interval` (with a working disabled
    value), platform-capped `max_http_response_bytes`, `save_assets`
    (boolean/per-app, respecting disk quotas). For `timezone_updater`, expose
    only enabled/hour and keep the download endpoint fixed — never accept an
    arbitrary update URL from the provider.
  - Hardware-aware: custom display `palette` colors, the strict
    partial-refresh subset of `device_config` (`partial`,
    `partialMaxAreaPercent`, `partialMaxRefreshesBeforeFull`), `gpio_buttons`
    (pin + label). Validate against the reported panel/platform, advertise
    capability/version requirements, restart the runtime when the driver only
    reads them at init. Never allow the whole `device_config` object.
  - ESP32: `max_http_response_bytes`, debug logging and GPIO buttons are
    plausible (the NVS fields exist); add only what the firmware consumes and
    keep the whole-payload rejection contract. The cloud power controls stay
    their own ESP32-only subset.
  - Automatic reboot: implement as a real cloud-safe scheduler capability
    (possibly via the schedule verb), not a persisted inert object. Brightness
    once the runtime and drivers grow a real setting.

  What must stay local, whatever else moves: deployment mode,
  panel/driver/VCOM/dimensions, flash and GPIO wiring, SD-card wiring,
  Wi-Fi/hotspot credentials, private-network elevation, frame HTTP/admin/TLS
  access and keys, SSH/backend/agent configuration, mountpoints, HTTP-upload
  URLs and headers, arbitrary update URLs, and service API secrets. Do not
  expose raw `assets_path` or `log_to_file` paths; if they are wanted remotely,
  redesign them as bounded toggles on fixed FrameOS-owned directories. Hardware
  identity reported by the frame stays authoritative.

- **Cloud AI chat: fork with lineage.** `save_scene` writes whatever scene the
  chat is holding into the account as a new private scene. That covers forking
  a store scene in practice, but records none of the lineage the dedicated fork
  route does: source scene id in the audit event, carried-over preview image,
  tags, description. Extract that route's body into a lib and have `save_scene`
  call it with a `source_scene_id`. *Small, self-contained.*

- **Account hardening.** Passkeys/TOTP 2FA, re-authentication before sensitive
  actions (revoking frames, bulk assignment changes, scope grants), and a
  per-frame audit trail surfaced in the UI.

- **Panel-displayed link code.** Show the enrollment code/QR on the e-ink panel
  itself, as proof of possession, rather than only on the portal and admin
  pages. The private-network elevation already does exactly this ceremony
  (`frameos/local_access.nim`) and is the model to copy.

- **Backend↔cloud promotion/demotion ceremony.** An explicit local action that
  moves a frame between control planes without a factory reset. UX is open.

---

## Frame privileges and FrameOS Remote

Audited 2026-08-16; findings and the full reasoning in
`docs/buildroot-privileges.md`. The short version: a stolen cloud account
already cannot get a shell, cannot reach the LAN from the frame (default-deny
lifted only by a code read off the panel) and cannot install unsigned software.
What is left is that everything on the device runs as root, and that FrameOS
Remote — the root agent with `shell`, a PTY and arbitrary file write — is
enabled by default on images that have no backend to talk to.

- **Stop shipping FrameOS Remote enabled on generic release images.** The
  published `frame.json` has `agentEnabled: true` with an *empty*
  `agentSharedSecret` and an empty `serverHost`, so on a cloud frame the unit
  runs forever as root reconnecting to nothing. Ship `agentEnabled: false`; a
  backend's first deploy turns it on, which is the moment it becomes useful.
  Verify on hardware that backend adoption of a generic card still works.
  *Small.* (The companion item, minting a secret at first boot, was withdrawn
  on 2026-08-16: the agent refuses to handshake at all with an empty secret, so
  minting one would create a dial-out rather than close a hole. Reasoning in
  the audit, observation 2.)
- **Run `frameos.service` as a `frameos` user.** The plan, the privileged call
  sites and the suggested sequencing are in `docs/buildroot-privileges.md` §3.
  Privileged work moves behind one narrow enum-only door (`apply-setup`,
  `apply-network-profile`, `reboot`, `install-ota <staged-dir>`) so OTA stays
  smooth: download and signature verification are already unprivileged, and
  only the final install crosses the line. Blocked on hardware time, not on a
  decision. The SPI/GPIO panel drivers are the part to measure first.

---

## Drivers

There are two ways to build a frame: `static` (everything in one binary) and
`precompiled` (the published release binary plus its driver `.so`s, scenes
interpreted). The `shared` and `shared-scenes` modes were removed on
2026-08-16, and with them the largest unaudited ABI surface.

- **Let a driver ask for an earlier retry.** Render hints travel host→driver
  only (`driver_render_hint.nim` tells the driver how long until the next
  pass); nothing travels back. So a driver that cannot draw yet — the
  framebuffer waiting for a KMS modeset is the live example — is re-probed
  only when the next render comes round, which on an hour-long interval means
  an hour of blank panel after a boot that was seconds from working. The
  driver knows it wants to be called back sooner and has no way to say so.
  Wants a return channel through the `.so` ABI, so it is not a one-liner.

- **Audit driver code for refs it did not allocate.** The rule and its
  reasoning now live at the top of `frameos/src/frameos/driver_abi.nim`: every
  shared library carries its own ORC runtime, so a ref allocated by one and
  incref'd/decref'd by the other crashes the host inside `unregisterCycle` as
  soon as ORC considers the type cyclic. The boundary itself is fixed — log and
  event payloads cross as `cstring` JSON, the driver context is bound
  `{.cursor.}` and its types are `{.acyclic.}` — but the *drivers* have not been
  read with this in mind. What to look for: a driver storing the `Image` it is
  handed in a field or a global, or keeping any part of the `DriverContext`
  past the call that gave it. `frameBuffer`, `inky`, `waveshare` and the
  HyperPixel path are where a violation would hurt.

---

## Buildroot images

Three Raspberry Pi platforms ship with published base images: `raspberry-pi-64`
(Zero 2 W / Pi 3 / Pi 4, the default), `raspberry-pi-32` (every ARMv6 board:
Zero, Zero W, Pi 1, CM1) and `raspberry-pi-5` (Pi 5 / CM5).

Nothing scheduled.

---

## ESP32

Memory measurements, the emergency-reserve decision, boot/render cost numbers
and the measurement tooling live in `docs/esp32-memory.md`; the flash breakdown
is in `docs/esp32-image-size.md`.

Nothing scheduled.

---

## Store

The scene store lives in Postgres today: blobs, versions and all.

- **Move blobs to object storage + CDN when size demands it**, and drop the
  20-version prune. Deferred on purpose — the ~100 MB/account cap makes
  Postgres fine, and the stored sha256 + `size_bytes` make the move mechanical
  (`cloud/STORE-TODO.md`).

---

## Cloud service (auth-web)

- **Operator-facing audit/event export** — only once there is an operator
  surface to put it on.
- Deliberately not built, though the scope names are already reserved in the
  device-flow allowlist: organizations, projects, memberships/invitations,
  hosted backend lifecycle, billing and metered quotas, placeholder service/UI
  packages (`cloud/TODO.md`).
- Disposable-email blocking was considered and skipped: Turnstile plus the rate
  limiter covers the automated case. Revisit only if abuse is observed.

---

## Security

Open items from `docs/cloud-security-review.md`.

- **The frame stores its link token in plaintext** (`state/cloud_link.json`,
  0600). Fix when there is hardware-backed key storage, or by redaction if the
  state file ever travels — support bundles, backups.

---

## Canonical API gaps

Matrix in `docs/api-triality.md`.

- ESP32: fonts list/file routes, full web admin shell parity.
- Frame import/adoption: standalone export/source payloads, and a backend
  adoption flow for standalone frames.

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
- Fleet-previews doctrine: is browser-side wasm rendering the permanent answer,
  or is an opt-in end-to-end-encrypted screenshot path ever acceptable?
- Thin-client frames on the cloud (ESP32-C3, embedded Pi/Pico): serving them
  means the cloud renders every frame for them — free cloud rendering forever,
  for everyone. Decide before building; until then C3 boards stay out of the
  cloud flasher.

---

## Parking lot (unscheduled, and fine as it is)

**New cloud services are not being built.** The scope names below are reserved
and the designs are sketched, but none of them is planned work:

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
- ESP32 board nice-to-haves: parallel firmware builds (shared
  `generated_config.h` and nimcache serialise under the build lock), a portal
  Wi-Fi scan list and AP password, mDNS advertisement, log persistence across
  offline periods, firmware artifact GC, deep-sleep improvements.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384`) and cJSON
  likewise (`cJSON_InitHooks`). Measure first.
