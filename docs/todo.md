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

- **Weather on the 16 MB-PSRAM 13.3" (SuurESP) — verified 2026-09-05** on
  2026.9.8 after a cold boot (first scene render after the 32 MB relayout):
  `render:done` in 85 s (14.4 s render + 18.9 s dither/pack + refresh), no
  `memory:oomAbort`, no `render:degraded`; idle PSRAM 5.91 MB before the
  text-heavy render and 5.36 MB after (the ~0.5 MB drop the plan expected,
  not 1.6 MB); the packed capture shows the sky's 6-colour dither banding
  and no full-width strip seam (the RGBX canvas draws no strips). Idle PSRAM
  now sits ~0.5 MB below the old ~6.9 MB baseline — the 24 MB SPIFFS state
  partition's cache, measured 6.15 MB free at boot with no scene loaded.
  Still to provoke deliberately: `memory:oomAbort` and the leak-percent
  restart. The 8 MB E1004 half was done 2026-09-01 (#428).
- **4:4:4 JPEGs degraded to half resolution on the 13.3" — fixed in the
  pixie fork (FrameOS/pixie#8, lock bumped to fe417a0).** Found 2026-09-05
  on SuurESP: the `koduraam` photos are 4:4:4 exports and every one logged
  `render:degraded … needs 5160K of decode buffers, over the 4989K memory
  budget`, rendering 600x800 stretched at 12, 24 and 60 MP alike (4:2:0
  and 4:2:2 files passed at 60 MP). The JPEG planner's budget clamp shaved
  the sampling grid until the channel planes fit, then the plan check added
  the per-component band + accumulator buffers (~180 KB) and refused, and
  the degrade ladder jumped to the divisor-2 rung instead of the ~1130x1506
  grid the clamp had computed. The clamp now counts the same three buffers
  and shaves in 1/64 steps until the exact plan fits (`tests/test_jpeg.nim`
  pins it; the frameos `test_decode_degrade` suite still passes). Verified
  on the board: see the bench entry in `docs/manual-testing-todo.md`.
  Longer term the streamed JPEG decoder holds target-sized channel planes;
  a banded design would cut the plan to a few MCU rows per component.
- **A cloud frame whose `/state` was wiped stayed sceneless but "in sync"
  — device half fixed (`fos_cloud.c` + `fos_scenes_stored()`).** The hello
  reported the NVS-cached `cloud_scn_sum` without checking that
  `/state/scenes.json` (or the split index) still existed, so after a
  SPIFFS autoformat or a flash relayout the hub saw the assigned checksum,
  never re-pushed, and every `set_current_scene` failed `scene not found`.
  Now the hello forgets the cached checksum when the store is empty and
  reports the store's own etag, so the frame shows **out of sync** in the
  workspace and any deploy (or `frame_scenes_set` with the same list)
  restores it. The hub does not push unasked on a hello mismatch by design
  (the push is assembled on the auth-web side; the hub has no channel to
  ask for it), so an automatic re-push for the empty-store case is a
  possible follow-up, not a bug: it would need an internal auth-web route
  the hub can call, and it can never lose anything because the device
  holds nothing.
- Console: `ota` printed `ota: UNKNOWN ERROR (cloud)` on every outcome
  because `CONFIG_ESP_ERR_TO_NAME_LOOKUP` is off; it now prints
  `check requested` / `request failed 0x…`.

---

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
  it. Retiring `shell` means structured deploy verbs on the remote (`stage
  release`, `activate`, `restart`) plus the backend `chown`ing what it writes,
  after which those images can use the same unit and door.
- **Tighten the unit further once hardware says the groups work:**
  `DevicePolicy=closed` with an explicit `DeviceAllow` list, and
  `ProtectKernelTunables` with the two sysfs knobs re-exposed.

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
- **Vannituba (Pimoroni HyperPixel 2r, 480×480) shows a blank screen** on
  the HA backend's 2026.9.0 SD image (seen 2026-09-04, parked by the user).
  Lead from that card's `frameos-setup-reset.log`: the driver's setup step
  ran `cd /srv/frameos/vendor/inkyHyperPixel2r` → `No such file or
  directory`, so its python venv was never built — the release image ships
  `inkyHyperPixel2rLegacyFb.so` but not the vendor tree it needs. Check
  whether the composer/release archive should carry `vendor/inkyHyperPixel2r`
  for that driver, then re-test on the panel.
