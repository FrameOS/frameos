# FrameOS — what is still open

Everything left to do across the repo starts here. "The map" lists every
todo file with its state and how much it matters right now; the rest of this
file is the work that has no file of its own. It is written to be read cold:
each section says what that part of FrameOS *is* before it says what is
missing from it. Reference material — principles, permission scopes, threat
models, wire protocols, measurements — lives in the linked docs; the todo
files only carry the work. **When an item ships, delete it** (and update its
line in the map).

## The map (2026-10-19)

1. **`docs/convergence-todo.md`** — the architecture getting smaller: one
   provider protocol on two hosts. **Next up: item 7 stage 1**, the backend
   hosts the frames' management WebSocket. Item 3 (the hub renders for thin
   clients) waits on a reason to ship, since its plans cannot be bought until
   billing resumes; item 2 (a hardware bench that runs on every release) has
   not started; item 1 (delete the compiler) not before December 2026.
2. **`docs/security-todo.md`** — nothing critical open on any plane. The
   highs left are device and isolation work: ESP32 Secure Boot and flash/NVS
   encryption, the preview worker on its own origin (the per-preview proxy
   token it waited on is in; the move is left), interpreter budgets per
   scene. Owner tasks:
   rotate the laptop's plaintext OpenAI and R2 keys, and move the CDN to its
   own registrable domain.
3. **`docs/manual-testing-todo.md`** — what needs a bench: the HyperPixels on
   Pi 0–4 and the Round on a Pi 5, input and GPIO buttons on a Pi, four ESP32
   flash/OTA checks and the dispatcher's cloud/schedule paths, the setup
   hotspot's captive sheet on a phone, scene import from a standalone frame.
   The E1004's buttons and sounds passed (2026-10-18). It only shrinks for
   good with convergence item 2.
4. **`cloud/docs/accounting-todo.md`** — billing. AI metering is live and
   nothing is invoiced: Phase 3b (entity, provider, invoices, dunning) is
   paused until there are users to invoice. Owed before the first invoice: an
   OpenAI organisation admin key and a week of `ai-metering-compare.mjs`
   (§7). Mostly a design record; §8/§9 stay because the code cites them.
5. **`docs/embedded-todo.md`** — the Pico's four small bugs and its missing
   host tests, all fixed on draft PR #499, which rewrites the file when it
   merges. The ESP32's open work lives in the other files.
6. **`docs/ui-todo.md`** — JSX widgets that render and react on the frame.
   Designed, not started. Lower priority for now, not parked.
7. **`docs/scenes-todo.md`** — 49 store scene ideas, which
   `build-todo-scenes.ts` builds from. Lower priority for now, not parked.
8. **`cloud/STORE-TODO.md`** — the store's design record (decisions, threat
   model, protocol), no open work; its open questions are below. The name
   stays because code comments cite its decision numbers.
9. **Open PRs with their own todo file**, joining this map when they merge:
   #555 (`docs/local-assets-todo.md`: serve-stale caches, bounded image
   libraries, paid-source budgets). Draft #496 and its
   `docs/scene-rhythm-todo.md` are superseded by #582, whose open work is the
   "Scenes inside scenes" section below.

---

**Compiled scenes are deprecated (2026-08-30).** No editor action produces
new Nim, every surface that shows a compiled scene warns and points at the
converter (scenes.frameos.net/nim-converter, the editor button, MCP
`scene_convert`, the CLI), deploys install release binaries, and
`last_successful_deploy.build_kind` records which frames still build from
source (`docs/legacy-source-builds.md`). Deleting the source-build path is
item 1 of `docs/convergence-todo.md` — not before December 2026, maybe much
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
  manager), until `docs/convergence-todo.md` item 7 stage 3.

---

## Runtime: the last live-config reads off the runtime's thread

The frame's web server runs up to four mummy worker threads and ORC refcounts
are not atomic; the rule and the helpers are in `AGENTS.md`, "Refs do not
cross threads". Workers copy what they read (`liveConfigValue`,
`requestFrameConfig()`), and the hub thread keeps a copy of its own that it
refreshes when the config's generation moves. Left:

- The portal's start-AP path (`startAp`, `startApSupplicant`,
  `checkNetwork`, `hotspotAutoTimeoutLoop`, `effectiveWifiCountry`) still
  reads the hotspot name and password, `networkCheckUrl` and `wifiCountry`
  off the live config. It runs on the main thread at boot, but `startAp`
  also runs on the connect thread after a failed join, where a reload could
  tear a string. Threading a private config through the start-AP path
  closes it.

---

## On-device admin: no AI on the device

The frame's own admin page (`http://<frame>:8787/admin`, the shared SPA in
frame-control mode) answers **Generate scene** and the AI chat buttons with
where the generator lives (`AiElsewhereNote`: scenes.frameos.net, or link
the frame to the cloud), because only the backend and the cloud can run the
AI chat. Make them work once the frame can reach an AI. Two routes, not
exclusive: the frame's FrameOS Cloud link (sign in from the panel, the
cloud's AI and metering do the work — and the first scene could be on us, as
the reason to link at all), and/or the owner's own OpenAI key under the
frame's service keys (the prompt/lint pipeline in
`cloud/apps/auth-web/src/lib/ai/` would have to be callable from the
device).

---

## Frame scene import (`scenes_get`)

Open on the import of a frame's own scenes (`docs/cloud-frames.md`, "Scenes
the frame already had"):

- Compiled scenes stay behind: the device counts them and the import's
  summary says so, but the owner has to find `/nim-converter` themselves.
  Sending their JSON along and offering the conversion inside the import
  would finish the job for frames that came from an old backend deploy.
- Persisted scene state does not travel: the push keeps the active scene on
  screen, but the provider's copy runs as `uploaded/<id>`, so state persisted
  under the old id is not carried over. `set_scenes` takes a `state` seed; the
  import sends none.

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

## Scenes inside scenes: exact repaints, and the bench

A split's panels each render on their own schedule, and a panel that is not
due puts back the picture it drew last time, from a copy capped by memory
(`docs/scene-rhythm.md`). Where no copy fits (big ESP32 panels, every
deep-sleep wake), the panel runs again: a *repaint*. Open:

- **Exact repaints through the node store (#555).** While a repaint runs,
  `FrameScene.repainting` is true. A node cache should then serve what it
  stored last time whatever its age, so an album does not move on and a random
  photo app does not fetch a new photo between its due runs. Until then a
  repaint is an ordinary run.
- **Bench it.** A Pi on HDMI with a 24 fps clock beside an Unsplash panel
  (split on 0.04 s): one fetch per photo interval, the clock smooth. An E1002
  split of a 60 s clock and a 15 min weather panel: the lazy loader reads
  both panels in (`scenes:load` `embedded-scene-read`), the weather panel is
  kept (its renders take the clock's time, not the weather fetch's). An E1004 1600x1200 split: the copy is refused once
  (`render:rhythm:copyRefused`) and the big panel repaints.
- **Realtime on an ESP32.** The C render loop ignores scene intervals under
  1 s and sleeps in whole seconds; a fast ESP32 with an LCD would need both.

---

## Open questions (decisions, not code)

- `store:publish` human review: always, only for the public store, or
  pre-review for risky (shell-app) scenes? Today it is automated moderation +
  badges + post-moderation only.
- Unpublish policy: owners delete outright today. Switch to yank-only plus
  support-mediated deletion once anything can depend on a scene.
- Publisher handles: publisher pages exist under opaque account ids
  (`cloud/STORE-TODO.md` decision 8); pretty handles only once someone wants
  them, and the URLs can then 301.

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
  leaves the user), content-addressed chunks, resumable. Its key-recovery UX
  is open, and the answer has to remain "we cannot read your photos".
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
  (the `cloud_membership` table anticipates this). With it: one backend link
  per installation, or per organization/project?
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
- ESP32 NVS on the 4 MB / 8 MB layouts (16 KB, 3 usable pages): the
  service-settings cache already skips itself below 192 free entries
  (`fos_settings.c`) and `status` prints `nvs: used/total`. Only if a board
  fills up anyway: store the TLS pair as DER, not PEM (`nvs_set_pem`,
  ~30 %). Never grow the NVS partition on those tables: the NVS-sparing USB
  update (`embeddedFlashImage.ts`) refuses a board whose table differs, so a
  bigger NVS strands every board already on the old one.
