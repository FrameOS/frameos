# FrameOS — what is still open

Everything left to do across the repo, in one file. It is written to be read
cold: each section says what that part of FrameOS *is* before it says what is
missing from it. Reference material — principles, permission scopes, threat
models, wire protocols, measurements — lives in the linked docs; this file only
carries the work. **When an item ships, delete it.** Larger tracks keep their
own files: security findings in `docs/security-todo.md`, architecture
convergence in `docs/convergence-todo.md`, store
content in `docs/scenes-todo.md`, the JSX widget UI in `docs/ui-todo.md`,
cloud billing in `cloud/docs/accounting-todo.md`, ESP32/Pico firmware in
`docs/embedded-todo.md`, and the boxes that need a bench in
`docs/manual-testing-todo.md`.

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

- **Both control planes — converging into one protocol.** FrameOS frames are
  managed either by a self-hosted backend or by FrameOS Cloud. A frame-facing
  feature lands on both unless it is explicitly one-sided. Doctrine in
  `docs/cloud-frames.md`, parity matrix in `docs/api-triality.md`. Since
  2026-09-07 the direction is that the backend becomes a provider speaking
  the cloud's protocol and the frame sees one "server to connect to"
  (`docs/convergence-todo.md` item 7); until that lands, "both" still means
  both.
- **The cloud has no shell verbs, on purpose.** Terminal, ping and debug panels
  are backend-only by design, not by omission. A stolen cloud account must not
  become a shell on someone's LAN. `docs/buildroot-privileges.md` audits how
  close that is to true. The backend's shell path (FrameOS Remote, SSH deploys)
  is now on the way out for the same reason — convergence item 7, stage 4.

---

## ESP32 NVS on the 16 KB layouts

The 4 MB and 8 MB partition tables give NVS 16 KB (3 usable pages × 126
entries); the 16/32 MB tables give 24 KB. The backend issues P-256 server
keys (≈ 1 KB of PEM), the Wi-Fi driver keeps its config in RAM and `status`
prints `nvs: used/total`, so a board should no longer fill up. Only if one
does:

- [ ] **Store the TLS pair as DER, not PEM**, on the device (`nvs_set_pem`):
  another ~30 %.
- Do NOT grow the NVS partition on the 4 MB / 8 MB tables: the NVS-sparing
  USB update (`embeddedFlashImage.ts`) writes around the NVS range read from
  the image and refuses a board whose table differs, so a bigger NVS strands
  every board already on the old table.

## Pre-release manual test sweep

`docs/manual-testing-todo.md` holds the boxes that need hardware: the
HyperPixel bench (Pi 0–4 firmware-DPI path, the Square, the Round on a Pi 5)
and the ESP32 flashing / OTA boxes that need a 16 MB C3, a 16 MB XIAO, a
32 MB S3 and an OTA-capable board on a self-hosted backend. Delete it when
empty.

---

## Frame privileges and FrameOS Remote

`docs/buildroot-privileges.md` §4 is the reference: generic Buildroot images
(`raspberry-pi-64`, `raspberry-pi-5`) run `frameos.service` as the `frameos`
user behind a hardened unit, root work goes through the privileged door, and
the images ship no FrameOS Remote. Verified on hardware 2026-09-04/05. Left:

- **Tighten the unit** now that the groups are known to work:
  `DevicePolicy=closed` with an explicit `DeviceAllow` list, and
  `ProtectKernelTunables` with the two sysfs knobs re-exposed. Needs a bench
  pass over an SPI panel, the Pi 5 framebuffer and a touch panel.
- **`raspberry-pi-32` stays root.** `network/supplicant.nim` runs
  wpa_supplicant/hostapd/udhcpc/dnsmasq from the runtime (39 privileged call
  sites); it has to become a root network daemon behind the door (or
  NetworkManager has to build for ARMv6) before that image can drop
  privileges.
- **Backend-personalized Buildroot images stay root**, and their Remote keeps
  `shell`, because the self-hosted deploy path is built out of it
  (`_frame_deployer.py`, `deploy_remote.py`, `restart_frame.py`, the asset
  manager). The way out is `docs/convergence-todo.md` item 7: once the
  backend speaks the provider protocol, those images use the same
  unprivileged unit and door as generic ones and the Remote retires.

---

## Runtime: refs shared across HTTP worker threads

The frame's web server runs up to four mummy worker threads and ORC refcounts
are not atomic; the rule and the helpers (`requestFrameConfig()`,
`getLastPublicSceneState()`, `sendEvent` copies) are in `AGENTS.md`, "Refs do
not cross threads". `server/` was audited and fixed 2026-09-19 (#503). Left,
deliberately:

- `portal.nim` as the HTTP workers call it on the setup path
  (`persistPortalSetup` copies and mutates the live `frameConfig`,
  `setupHtml` / `setupStatusJson` read it). Only reachable while the setup
  hotspot is up, when nothing else is running; not audited line by line.
- The cloud link routes pass `globalFrameConfig` to `startCloudHubClient` /
  `enrollManagedFrame` / `pollDeviceFlow`, which keep it: one owning copy of
  the ROOT per link, never freed (the globals hold it), no closures in the
  type. The proper fix is for the hub client to work on values, as the
  logger and metrics threads already do.
- Workers still read scalar and string fields straight off the live config
  (`frameAccess`, `frameAccessKey`, `serverApiKey`, `assetsPath`, `rotate`…).
  `updateFrameConfigFrom` never frees a payload, so the read cannot land on
  freed memory, but the swap is a `copyMem` and a string is two words: a
  reload can in principle tear one. A values snapshot for `auth.nim` (what
  `AdminAuthValues` is for the admin block) would close it.

---

## Setup hotspot: captive portal

A phone that joins `FrameOS-Setup` should get the OS's "sign in to network"
sheet with the setup form in it, instead of the owner scanning a second QR
code. The frame already answers the well-known probe paths and every
foreign-`Host` request with a 302 to the setup form (`captivePortalRedirect`),
the armv6 supplicant backend's dnsmasq already resolves every name to
`10.42.0.1`, and the unit already holds `CAP_NET_BIND_SERVICE`. Two halves
are missing, and they only work together (DNS without port 80 reads as plain
"no internet"):

- **DNS on NetworkManager images:** shared mode reads
  `/etc/NetworkManager/dnsmasq-shared.d/`, so an `address=/#/10.42.0.1`
  drop-in staged next to the resolved/dropbear ones in
  `backend/app/tasks/buildroot_image.py` covers `raspberry-pi-64` /
  `raspberry-pi-5`. Root is read-only, so this is image-time only.
- **Port 80:** the probes go to port 80 and the hotspot's own listener
  (`server/hotspot_listener.nim`) takes the first free port from 8000. Give
  it a second, redirect-only bind on `10.42.0.1:80` for the hotspot's
  lifetime.
- Then re-test the "Saved!" auto-move: a captive sheet is a restricted
  browser that may not run the page's timers.

---

## On-device admin: no AI on the device

The frame's own admin page (`http://<frame>:8787/admin`, the shared SPA in
frame-control mode) hides **Generate scene** (`allowedAddSceneActions` in
`workspaceSurfaces.ts`), because only the backend and the cloud can run the
AI chat. Bring it back once the frame can reach an AI. Two routes, not
exclusive: the frame's FrameOS Cloud link (sign in from the panel, the
cloud's AI and metering do the work — and the first scene could be on us, as
the reason to link at all), and/or the owner's own OpenAI key under the
frame's service keys (the prompt/lint pipeline in
`cloud/apps/auth-web/src/lib/ai/` would have to be callable from the
device). The other AI entry points (the sparkles in the header and the scene
editor) still open a "coming soon" panel on the device; hide them the same
way, or make them work, with this.

---

## A frame that joins the cloud arrives with no scenes

Flip "Manage this frame from FrameOS Cloud" on a frame that already runs its
own scenes and the cloud lists none — the frame keeps rendering what it has,
and the cloud shows an empty frame. The hub protocol has no device → cloud
scene path: `docs/cloud-frames-contract.json` carries `set_scenes` (cloud →
device) and the `scenes_checksum` ack, and `enrollManagedFrame` registers the
device and nothing more.

What it needs: a device → cloud "here are my scenes" verb, a cloud importer
that creates draft store scenes and frame assignments from it, dedupe against
scenes the account already has (a re-enrolled frame must not fork every scene
again), and a decision about what happens to a scene the device has and the
cloud then reassigns. A feature, not a fix — but an empty cloud frame is a
bad first five minutes.

---

## Backend Docker image: root, and a full build toolchain

Both halves are held in place by the deprecated source-build path
(`docs/legacy-source-builds.md`), so neither is a one-line `USER`:

- The toolchain (Nim, `build-essential`, `docker-ce-cli`, `/root/.nimble`) IS
  the legacy build environment — the Modal executor runs this very image as
  its sandbox with `HOME=/root` (`backend/app/utils/modal_sandbox.py`), and
  `nim check` for Nim apps (`api/apps.py`) reads `/root/.nimble`. It leaves
  with item 1 of `docs/convergence-todo.md`, not before.
- Dropping root is an entrypoint job (start as root, `chown` the data dir,
  `setpriv` down), not a Dockerfile `USER` — existing volumes hold a
  root-owned `frameos.db` and a 0600 `secret_key`, and the image auto-updates
  under people via Watchtower. What a first attempt has to get right: stay
  root when `/var/run/docker.sock` is mounted and under Home Assistant
  (`HASSIO_TOKEN`; the DB and key live in the Supervisor's `/data`); fall
  back to root with a warning when the `chown` fails (NFS / rootless Docker /
  userns-remap bind mounts) instead of boot-looping; give `redis-server` a
  writable `--dir` (it saves `dump.rdb` into `/app` today, and a failed
  bgsave makes Redis refuse writes — arq stops); a real `$HOME` for
  `~/.cache/frameos`; honour a `DATABASE_URL` outside `/app/db`. Needs a
  bench pass over an upgraded volume and an SD-image build before it ships.
- While there: `docker-compose.yml` sets no `SECRET_KEY` (the key persists to
  a file, so compose works; still worth setting explicitly).

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
- Thin-client frames on the cloud (ESP32-C3, Pico) — decided: cloud
  rendering is a paid-plan entitlement, N frames *and* a minimum refresh
  interval, none on the free tier, and enrollment enforces it. What keeps C3
  boards out of the cloud flasher is that the hub does not render for thin
  clients yet — item 3 of `docs/convergence-todo.md`.

---

## Parking lot (unscheduled, and fine as it is)

**New cloud services are not being built.** The scope names below are reserved
in the device-flow allowlist and the designs are sketched, but none of them is
planned work — as with organizations, projects, memberships, hosted backend
lifecycle and metered billing (`cloud/SCOPE.md`). Disposable-email blocking
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
- ESP32 board nice-to-haves: a Wi-Fi scan list in the setup portal (the
  console has `wifi-scan`), mDNS advertisement, log persistence across
  offline periods.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384`) and cJSON
  likewise (`cJSON_InitHooks`). Measure first.
