# FrameOS — consolidated remaining work

One tracker for everything still open across the repo (last swept
2026-08-05). Reference material — principles, permission scopes, store
decisions, threat models, wire protocols — stays in the linked docs; this
file only lists what is left to do. When an item ships, delete it here.

## Cloud-managed frames

- **Signed OTA** — the one open item from the cloud-workspace push and the
  blocker for FrameOS updates from the cloud. Releases signed
  (minisign/ed25519) with the public key baked into images; the device
  verifies independently (`upgrade.nim` today checks URL shape only); an
  `ota` verb (esp32: pull the published generic image; buildroot: release
  tarball swap via the frameos binary); an Update button gated on the
  fleet's reported `frameos_version`. Must land before widely distributing
  SD images. Design: `cloud/docs/cloud-frames.md` ("Signed OTA").
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
- **`image_get` full-loop verification** — the current-image endpoint is
  device-side verified (ESP32 BMP pack) but the end-to-end loop still
  awaits a re-enrolled frame (`cloud/docs/cloud-workspace-gaps.md`).
- **Free-tier quotas** — pick numbers (frame count, backup size, private
  scene count) when provisioning starts, not before.
- **Fleet extras** (design phase 4): offline alerting/notifications,
  backups integration, paid-tier gating.

## ESP32

- **Large-image spill-to-storage: firmware wiring** — C glue, Nim reader
  and stub no-op are merged and runtime-inert; wire
  `fos_nim_http_set_spill_dir` in `embedded/esp32/main/main.c` (SD
  `.cache` dir, or capped SPIFFS `/state` when no SD) plus the boot sweep
  of leftover `http-spill-*.tmp`, then validate on the bench PhotoPainter
  (12-scene workload, ~3 MB gallery JPEG, confirm the PSRAM floor during
  spill+decode). Full design: `cloud/docs/esp32-large-image-spill.md`.
- Spill follow-ups (optional): proactive Content-Length trigger;
  file-backed `InflateSegment` source in the pixie fork so spilled PNGs
  stream too; URL+ETag decode cache.
- ~~**FAT long filenames**~~ — DONE: `CONFIG_FATFS_LFN_HEAP` in
  sdkconfig.defaults + the dev sdkconfig; listings show full names.

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
  uptime/offline alerts. (Cloud-managed frames already ship logs; this is
  the backend-link side plus alerting.)

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

- ESP32: fonts list/file routes, full web admin shell parity. (Asset
  file/upload/mkdir/delete/rename routes DONE — device HTTP + cloud verbs +
  usb_api + backend proxy, 2026-08.)
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
