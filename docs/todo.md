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
`docs/embedded-todo.md`, CI and the release chain in
`docs/release-chain-todo.md`.

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

The 4 MB and 8 MB partition tables give NVS 16 KB (4 pages, one always kept
free for compaction, so 3 × 126 32-byte entries); the 16/32 MB tables give
24 KB. On the self-hosted backend the first settings sync stores the frame's
TLS pair as PEM blobs, and a bare 4 MB C3 hit the ceiling on 2026-09-05 —
the Wi-Fi driver's own writes failed (`wifi_nvs_set fail ... ret=4357`), PHY
calibration would not store, and `wifi <ssid>` silently did not persist.
Shipped: the driver keeps its config in RAM (~45 mirrored items gone),
`fos_config_save` reports the first failing key, `status` prints `nvs:
used/total`, and since 2026-09-06 the backend issues P-256 server keys
(`backend/app/utils/tls.py`): cert + key ≈ 1 KB of PEM against ≈ 2.9 KB for
the RSA-2048 pair it used to mint (the CA stays RSA; it never leaves the
backend). Frames created before that keep their RSA pair until the owner
regenerates it. Still worth doing only if a board still fills up:

- [ ] **Store the pair as DER, not PEM**, on the device (`nvs_set_pem`):
  another ~30 %. Only if the EC switch turns out not to be enough.
- [ ] Do NOT grow the NVS partition on the 4 MB / 8 MB tables casually: the
  NVS-sparing USB update (`embeddedFlashImage.ts`) writes around the NVS
  range read from the image and refuses a board whose table differs, so a
  bigger NVS strands every board already on the old table.

## Pre-release manual test sweep

`docs/manual-testing-todo.md` collects every unticked manual checkbox and
"needs hardware" note from PRs #362 onward, grouped by test bench. Work it
before the next release; delete it when empty.

---

## Frame privileges and FrameOS Remote

Audited 2026-08-16 and implemented in PR #415;
`docs/buildroot-privileges.md` §4 is the reference. Generic Buildroot images
(`raspberry-pi-64`, `raspberry-pi-5`) run `frameos.service` as the `frameos`
user behind a hardened unit; root work goes through the privileged door
(`frameos/src/frameos/privileged.nim`: enum verbs, validated arguments, a
`.path`-triggered root oneshot); OTA re-verifies the minisign signature on the
root side, refuses downgrades, and binds signed bytes to the requested
version/target; the images ship no FrameOS Remote at all, and the remote lost
its PTY verbs everywhere. Left:

- **Verify on hardware** — nothing has rendered under the unprivileged unit
  yet. The checklist is in `docs/manual-testing-todo.md` ("Privilege
  separation"): SPI panels and the Pi 5 framebuffer as `frameos`, the
  hotspot/portal flow through the door, an OTA from a root-only release (the
  migration path), and a generic card adopted by a self-hosted backend
  afterwards.
- **`raspberry-pi-32` stays root.** `network/supplicant.nim` runs
  wpa_supplicant/hostapd/udhcpc/dnsmasq from the runtime (39 privileged call
  sites); it is a root network daemon and needs to become one behind the door
  (or NetworkManager needs to build for ARMv6) before that image can drop
  privileges.
- **Backend-personalized Buildroot images stay root**, and the remote keeps
  `shell`: the self-hosted deploy path (`backend/app/tasks/_frame_deployer.py`,
  `deploy_remote.py`, `restart_frame.py`, the asset manager) is built out of
  it. The way out is no longer structured verbs on the Remote but the
  backend speaking the provider protocol the in-binary client already
  implements (`docs/convergence-todo.md` item 7): once deploys are
  `set_scenes` / `set_settings` / `notify_update_available`, those images
  use the same unprivileged unit and door as generic ones and the Remote
  retires. Meanwhile a frame with no shell at all (an adopted generic card)
  already deploys that way from the drawer (2026-09-07), and since
  2026-09-12 gets its assets, fonts, service keys, scene activation and
  scene snapshots over the same admin API — "remote lite",
  `docs/api-triality.md` "Admin-API-only frames" — with the shell-only
  verbs refused and hidden. Nothing ever installs a Remote on such a card.
- **Tighten the unit further once hardware says the groups work:**
  `DevicePolicy=closed` with an explicit `DeviceAllow` list, and
  `ProtectKernelTunables` with the two sysfs knobs re-exposed.

---

## Runtime: refs shared across HTTP worker threads

The frame's web server runs four mummy worker threads. ORC refcounts are not
atomic, so a `ref` (JsonNode, FrameConfig, …) that a global hands to more than
one thread gets freed under its readers sooner or later. Found 2026-09-06 on a
Zero 2 W: `server/auth.nim` cached the `frameAdminAuth` JsonNode and every
request touched it three times; four minutes of admin-panel polling later the
node was garbage, every request answered "Admin panel disabled" (the session
fingerprint reads user/pass from the same node, so sessions died too), and
the heap followed. Fixed by caching plain values (`AdminAuthValues`) and
building a fresh node per call; `test_auth.nim` has a four-thread regression
test that reproduces it on the old code under libc malloc.

Left: audit the rest of `server/` for the same shape — `globalFrameConfig`'s
nested refs read from handlers (`frameAdminAuth`, `httpsProxy`, `network`,
`agent` — field reads of scalars are fine, copying a nested ref or calling
`{}` on a shared JsonNode is not), `globalRecentLogs` / `globalRecentMetrics`
(JsonNodes appended by the logger and read by `/api/admin/logs`: keep every
read under `globalRecentLogsLock` and serialize there, never return a node),
and any other `var … : JsonNode` at module level. Rule for new code: a
global that crosses threads holds values or is only ever read under the same
lock that writes it; hand out copies, not refs.

---

## Setup hotspot: captive portal

A phone that joins `FrameOS-Setup` should get the OS's "sign in to network"
sheet with the setup form in it, instead of the owner scanning a second QR
code (2026-09-06, Zero 2 W first boot). Two halves; the server half shipped
the same day, the image half is open:

- **Done:** while the hotspot is up the frame answers the well-known probe
  paths (`/generate_204`, `/hotspot-detect.html`, `/connecttest.txt`, …) and
  every not-found request whose `Host` is not `10.42.0.1` with a 302 to the
  setup form (`captivePortalRedirect`, `server/routes/web_routes.nim`).
- **DNS:** the hotspot's dnsmasq must resolve every name to `10.42.0.1`.
  NetworkManager's shared mode reads `/etc/NetworkManager/dnsmasq-shared.d/`,
  so a `address=/#/10.42.0.1` drop-in staged next to the resolved/dropbear
  ones in `backend/app/tasks/buildroot_image.py` covers `raspberry-pi-64` /
  `raspberry-pi-5`; the supplicant backend (`network/supplicant.nim`,
  armv6) builds its own dnsmasq command line and takes the same `--address`.
  Root is read-only, so this is image-time only.
- **Port 80:** the probes go to port 80 and the runtime listens on 8787 as
  the unprivileged `frameos` user, so nothing answers today. Either add
  `CAP_NET_BIND_SERVICE` to `frameos.service.unprivileged` (both unit
  renderers read that file) and have the runtime open a second listener on
  :80 for the hotspot's lifetime that only redirects, or have the door's
  `nm-hotspot-start` verb add an nft/iptables `REDIRECT --to-ports 8787` on
  the hotspot interface (needs the firewall binary NetworkManager's shared
  mode already depends on — check which one the Buildroot NM package pulls).
  The listener is the smaller change; the redirect needs no capability.
- Without the DNS half the popup never triggers, and with DNS but no port 80
  the OS sees "connection refused" and reports plain "no internet" — so ship
  both halves together, and re-test the "Saved!" auto-move: a captive sheet
  is a restricted browser that may not run the page's timers.

---

## On-device admin

The frame's own admin page (`http://<frame>:8787/admin`, the shared SPA in
frame-control mode) is how a standalone frame is managed without a backend
or the cloud. Since 2026-09-12 its "Add scene" drawer hides **Generate
scene** (`allowedAddSceneActions` in `workspaceSurfaces.ts`): the button
opened the AI chat, which only the backend and the cloud can run, so on the
device it led to a "coming soon" panel. Bring it back once the frame can
reach an AI. Two routes, not exclusive: the frame's FrameOS Cloud link
(sign in from the panel, the cloud's AI and metering do the work — and the
first scene could be on us, as the reason to link at all), and/or the
owner's own OpenAI key entered under the frame's service keys (the scene
then costs them, and the prompt/lint pipeline in
`cloud/apps/auth-web/src/lib/ai/` would have to be callable from the
device). The other AI entry points (the sparkles in the header and the
scene editor) still open the same "coming soon" panel on the device; hide
them the same way, or make them work, with this.

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
- ESP32 board nice-to-haves: a portal Wi-Fi scan list and AP password, mDNS
  advertisement, log persistence across offline periods, deep-sleep
  improvements.
- ESP32 internal-RAM headroom, only if it gets tight again: move QuickJS
  allocations to PSRAM (`JS_NewRuntime2` with PSRAM-backed
  `js_malloc_functions`; `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384`) and cJSON
  likewise (`cJSON_InitHooks`). Measure first.
