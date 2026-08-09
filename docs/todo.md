# FrameOS — consolidated remaining work

One tracker for everything still open across the repo (last swept
2026-08-09). Reference material — principles, permission scopes, store
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

- **Flashing convergence** — the backend should adopt the same
  browser-centric flash system the cloud uses (Esp32CloudFlasher /
  EmbeddedWebFlasher). The backend may still build a frame-specific binary
  server-side when a custom source build is needed; the browser flasher then
  flashes that artifact instead of a release download.
- **Service settings: verify the Nim client on hardware** — the Linux/Pi
  client is unit-tested and build-verified only, never run against a real
  provider. (The ESP32 client has been.)
- Cloud-managed ESP32-C3 frames still have no render source (wasm harness
  is the building block; C3 boards stay out of the cloud flasher until then).
- **Cloud OTA: confirm it works against 2026.8.13** — the first release that
  should publish `…-esp32-s3-generic-app.bin` (an OTA slot cannot accept the
  merged flash image, so earlier releases 404 as `ota_image_not_published`)
  and the first to report a real `frameos_version` from an ESP32. Both want
  checking, not assuming. Meanwhile the USB updater moves a board on.

## Cloud-managed frames

- **JS-runtime capability audit** — enumerate every native binding exposed
  to scene JS; per-scene asset sandboxes; CPU/time/memory limits per scene;
  confirm RFC1918 fetch blocking and the local-presence elevation ceremony
  (`cloud/docs/cloud-frames.md`, "sandbox posture").
- **Account hardening** — passkeys/TOTP 2FA, re-authentication for
  sensitive actions (revoking frames, bulk assignment changes, scope
  grants), per-frame audit trail surfaced in the UI.
- **Panel-displayed link code** — show the enrollment code/QR on the e-ink
  panel itself (proof of possession), not just the portal/admin page.
- **wasm fleet previews** in the cloud UI — browser-rendered, keeping the
  no-image-proxy rule.
- **Backend↔cloud promotion/demotion ceremony** — the explicit local
  action that moves a frame between control planes without a reset (exact
  UX still an open design question).
- **Free-tier quotas** — pick numbers (frame count, backup size, private
  scene count) when provisioning starts, not before.
- **Fleet extras** (design phase 4): offline alerting/notifications,
  backups integration, paid-tier gating.

## ESP32

- **Large-image spill: bench validation** — a forced-spill render on the
  13.3E6 (`set spill_force <bytes>`, ~3 MB gallery JPEG) confirming the PSRAM
  floor during spill+decode. Measure fresh: the original premise, a 12-scene
  workload eating the headroom, died when scenes stopped being resident.
  Design: `cloud/docs/esp32-large-image-spill.md`.
- Spill follow-ups (optional): proactive Content-Length trigger;
  file-backed `InflateSegment` source in the pixie fork so spilled PNGs
  stream too; URL+ETag decode cache.

### Memory

- **Move QuickJS off internal RAM** — it allocates through libc malloc, and
  `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384` sends everything under 16 KB to
  the internal pool, so the active scene's JS context is an internal-RAM cost
  (`JS_NewRuntime2` with PSRAM-backed `js_malloc_functions`). Bounded to one
  scene, so only worth doing if internal RAM gets tight again.
- **Same for cJSON** — WS frames and settings payloads parse in internal
  RAM. `cJSON_InitHooks` with PSRAM allocators moves the lot, but it is
  broad enough to want its own measurement first.
- **Surface memory over a channel that survives the link being down** — the
  workspace advisory reads device metrics, so a frame too low on internal RAM
  to connect reports nothing and cannot be flagged. Today it is preventive
  only; a frame already over the edge is visible over USB and nowhere else.

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
- `device/request` has only a per-IP rate limit — a per-account limit
  would close online user-code enumeration.
- Frame-side `local_login_enabled` is cosmetic — persist the flag in the
  frame's cloud-link state and enforce it in the admin login before hiding
  local login fields means anything.

## Canonical API gaps (matrix in docs/api-triality.md)

- ESP32: fonts list/file routes, full web admin shell parity.
- Pi: canonical asset upload/mkdir/delete/rename routes (exist via the
  admin asset API, not the canonical frame API).
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
