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
- **Cloud OTA: confirm it works against a published release** — the first
  release publishing `…-esp32-s3-generic-app.bin` (an OTA slot cannot accept
  the merged flash image, so earlier releases 404 as
  `ota_image_not_published`) and the first to report a real `frameos_version`
  from an ESP32. Both want checking, not assuming, and only a real release
  tests it. Meanwhile the USB updater moves a board on.
- **`FrameConfig.scalingMode` is hardcoded to `"cover"` on embedded** — a Pi
  reads it from frame.json; an ESP32 cannot be configured at all. Since #321
  it no longer decides image placement (the consuming node's own placement
  does), but it still wants the config path `rotate` already has: NVS field,
  console `set`, settings sync, backend/cloud plumbing.

## Cloud-managed frames

- **Transparent `preview_image` at publish time.** The surviving half of the
  blank-tile bug: the decided fix (explicitly copy the store cover into
  `frame_asset_files` when `POST /frames/{id}/scenes` installs an assignment
  set — the backend's `assignSceneImages` pattern, now on the cloud too)
  gives every installed scene's tile bytes to show, but a copy of a fully
  transparent cover is still invisible. The auto-captured preview appears to
  be grabbed from the wasm live-preview canvas before the first render
  completes; composite over an opaque background at capture, reject
  fully-transparent uploads at publish, and backfill or gallery-fall-through
  the existing rows.
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

- Spill follow-ups (optional): proactive Content-Length trigger; URL+ETag
  decode cache. (Spilled PNGs stream already; the 13.3E6 forced-spill bench
  ran 2026-08-13 — 4.4 MB JPEG spilled to SD `.cache` and decoded with a
  ~5.2 MB PSRAM floor after the decode-budget fixes.)

### Board follow-ups (rolled in from docs/esp32-photopainter-todo.md)

That file's tracked work was finished — the 13.3E6 parity push (#301-#305)
and the `image_get` cloud verb, all hardware-verified — so the file is gone
and its board facts now live in `embedded/esp32/README.md` next to the preset
table. What was still open there, mostly nice-to-have:

- **Parallel firmware builds.** Build directories are per-profile now, but
  `main/generated_config.h` and the Nim `nimcache` are still shared in-tree,
  so builds serialise under the global build lock.
- Portal: Wi-Fi scan list in the HTML form, AP password.
- mDNS advertisement.
- Log persistence across offline periods.
- Firmware artifact GC.
- Deep-sleep improvements (GPIO wake is moot on the 13.3E6 — no user
  buttons).

### Startup cost

- **Flashing the bench 7.3" PhotoPainter: use 0x10000, not 0x20000.** That
  board carries the **8 MB** layout (`partitions.csv`: otadata 0xd000, ota_0
  0x10000, ota_1 0x380000) while `build-pp73` is configured for
  `partitions_ota_16mb.csv` (otadata 0xf000, ota_0 0x20000). An app-only
  `write_flash 0x20000` lands in the middle of ota_0, the image is never
  found, and the bootloader silently keeps running the *old* app from ota_1 —
  esptool reports "Hash of data verified" either way. This cost a full day of
  measurement in 2026-08: two firmwares were "flashed" and compared, and both
  runs were the same untouched binary, which then read as "the fix does
  nothing" and "`-d:memProbe` is broken". **After every flash, check the boot
  log for `boot: Loaded app from partition at offset ...` and confirm the
  slot.** `esp_image: image at 0x10000 has invalid magic byte` in that log
  means the write went to the wrong offset.
- **Serial drops output during CPU-bound bursts.** The USB-Serial-JTAG
  console loses lines while `fos_client` holds the CPU — the transpile window
  in a cold boot comes back as a 16 s gap with corrupted joins
  (`MEMMEMPROBE`, `MEMrender`). Absence of a probe line is not evidence the
  probe did not fire. Read with a tight poll loop and expect to repeat the
  capture.
- **Parse and transpile scenes at deploy time, not on every boot.** Measured
  on the bench 7.3" PhotoPainter with `-d:memProbe`, after the allocation fix
  (#329): weatherIcons 11 KB = **0.55 s**, weatherPanel 36 KB = **1.38 s**,
  and the panel is transpiled twice because each node builds its own runtime
  — **~3.3 s per boot**, then `transpile CACHED` on every later render. The
  older 3.3 s / 10.2 s figures look like genuine measurements of the *pre-fix*
  transpiler (2 x 10.2 + 3.3 lands on the ~24 s cold-vs-warm delta that
  firmware showed), so the fix appears to be worth roughly 7x on device — but
  the old binary was overwritten before it could be re-instrumented, so treat
  the comparison as inferred rather than measured. What is measured on the
  host: 724,572 heap allocations for the 36 KB app (19.9 per source byte, all
  through ESP-IDF multi_heap against PSRAM) down to 16,709 (0.46/byte), and
  14.2 ms -> 4.5 ms, with byte-identical output.
  **This changes the case for deploy-time transpilation**: it now saves ~3 s
  per boot, not ~24 s, against ~92 KB of transpiler object code (unverified —
  one reading of `frameos_esp32.map` put the five modules nearer 78 KB) and
  ~420 KB left in the OTA slot. Cheapest win left is free: the two
  weatherPanel nodes transpile the same source twice, so caching per source
  hash halves what remains. For scale, a cold boot only costs ~6 s more than a
  warm render (3.3 s transpile + ~1.7 s Open-Meteo fetch + ~0.6 s scene load);
  the real per-render costs are SVG rasterization (7-8 s for the two weather
  SVGs), dither+pack (3.2 s) and the panel refresh (~29 s).
- **`compileToBytecode` serialises the wrong object.** It asked for
  `JS_EVAL_FLAG_COMPILE_ONLY`, which burrito.nim declared one bit too high —
  that value is `JS_EVAL_FLAG_BACKTRACE_BARRIER` in the bundled quickjs.h — so
  the code ran and whatever came back (a value, or a Promise for a module) was
  written out instead of bytecode. #322 fixed the constant; the function
  itself is still unused and untested. Fix it with a test or delete it: it is
  the prerequisite for ever shipping QuickJS bytecode instead of source.

### Memory

The Weather scene renders on an 8 MB board now (#318, #320, #322). The
resident baseline went 2.72 MB → 1.05 MB, a render starts with 7.1 MB
instead of 5.5 MB, and steady-state renders no longer touch the emergency
reserve. What is left:

- **The first render after a boot still dips into the 1 MB emergency
  reserve** (`heap exhausted: released 1048576 byte emergency reserve`). It
  succeeds, but that render also pays the scene parse and the app transpile,
  so it is the one with no headroom to spare. Re-measure once that work moves
  off the device (above).
- **Re-size the emergency reserve.** It is now the entire resident baseline:
  everything else at boot — wifi, scene storage, the console, HTTP, OTA —
  costs about 2 KB of PSRAM between them. 1 MB was chosen when a render could
  exhaust the pool; peak is much lower now, so measure whether it still needs
  to be that large.
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

How to measure, before proposing a fix: `-d:memProbe` logs PSRAM free and a
millisecond timestamp before every interpreter node, and
`-DFRAMEOS_BOOTMEM=1` does the same for each boot step. A host-side peak
model once predicted 3.7 MB where the device wanted ~4.5 MB, and separately
put the source map at 45% of a transpile when it was 5% — reconcile any host
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
