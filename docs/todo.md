# FrameOS — consolidated remaining work

One tracker for everything still open across the repo (last swept
2026-08-13). Reference material — principles, permission scopes, store
decisions, threat models, wire protocols — stays in the linked docs; this
file only lists what is left to do. When an item ships, delete it here.

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

## Cloud-managed frames

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

Bench/flash gotchas (wrong app offset fails silently, serial drops lines
under CPU load) moved to `embedded/esp32/README.md` — they are facts, not
work. The photopainter-todo nice-to-haves (parallel builds, portal polish,
mDNS, log persistence, artifact GC, deep sleep) and the optional spill
follow-ups moved to the parking lot.

### Memory

The Weather scene renders on an 8 MB board now (#318, #320, #322). The
resident baseline went 2.72 MB → 1.05 MB, a render starts with 7.1 MB
instead of 5.5 MB, and renders no longer touch the emergency reserve.
Measured on the bench 7.3" PhotoPainter (v2026.8.19 + `-d:memProbe`,
2026-08-14): the first render after a boot no longer dips into the reserve
either — the probed low-water across scene load, both weatherPanel
transpiles and the SVG rasters was **4.17 MB free PSRAM with the 1 MB
reserve still armed** (idle-with-scene 7.14 MB, post-render steady
6.2 MB). That closes the two open measurement items from this section: the
first-render dip is gone, and the reserve stays at 1 MB — it is not the
binding constraint on anything measured, and it remains the
OOM-containment backbone for pathological decodes. What is left:

- **Surface memory over a channel that survives the link being down** — the
  workspace advisory reads device metrics, so a frame too low on internal RAM
  to connect reports nothing and cannot be flagged. Today it is preventive
  only; a frame already over the edge is visible over USB and nowhere else.

How to measure, before proposing a fix: `-d:memProbe` logs PSRAM free and a
millisecond timestamp before every interpreter node
(`FRAMEOS_EXTRA_NIM_FLAGS="-d:memProbe" ./build_nim.sh`), and
`FRAMEOS_BOOTMEM=1` in the environment at configure time compiles in the
same for each boot step (`main/CMakeLists.txt`). A host-side peak model
once predicted 3.7 MB where the device wanted ~4.5 MB, and separately put
the source map at 45% of a transpile when it was 5% — reconcile any host
measurement against a device run before trusting it.

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
  idea below. Context: a per-source-digest transpile-output cache was built
  and removed the same day (2026-08-13) — pinning ~50 KB per unique source
  in PSRAM with no pressure-driven eviction is the wrong trade on a board
  that counts bytes.
- **ESP32: parse/transpile scenes at deploy time, not on boot.** Decided
  2026-08-13 to shelve: after the allocation fix (#329) a cold boot pays
  only ~3.3 s of transpile (weatherIcons 0.55 s + weatherPanel 1.38 s×2,
  bench 7.3" PhotoPainter, `-d:memProbe`), and dropping the ~80–92 KB
  transpiler from the image is not worth it — shipping readable TS source
  to the device is a feature. Per-render costs live elsewhere anyway (SVG
  raster 7–8 s, dither+pack 3.2 s, panel refresh ~29 s). Revisit only if
  boot time or flash budget becomes a real constraint.
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
  cache. (Spilled PNGs stream already; the 13.3E6 forced-spill bench ran
  2026-08-13 — 4.4 MB JPEG spilled to SD `.cache`, ~5.2 MB PSRAM floor.)
- ESP32 board nice-to-haves: parallel firmware builds (shared
  `generated_config.h` + nimcache serialise under the build lock), portal
  Wi-Fi scan list + AP password, mDNS advertisement, log persistence across
  offline periods, firmware artifact GC, deep-sleep improvements.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384` sends
  sub-16 KB mallocs internal) and cJSON likewise (`cJSON_InitHooks`;
  measure first, it is broad).
