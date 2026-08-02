# Cloud-Managed Frames — Design

Status: **draft, agreed direction** (2026-07-31). This is the concrete product
design that `TODO.md` previously said to wait for. Nothing here is implemented
unless explicitly marked.

## Summary

Add an **"Add frame"** button to the account surface. A frame enrolls directly
with FrameOS Cloud — via a downloadable SD card image, a link code shown on the
device, or a browser-based flasher — and can then be managed from the cloud
account: assign interpreted scenes, set schedules and declarative settings, see
status and screenshots-via-wasm, receive telemetry.

The design rests on one architectural bet and one security posture:

1. **A cloud-managed frame is an interpreted-only frame.** The cloud ships
   node-graph JSON to the device's existing interpreted-scene runtime
   (QuickJS). The cloud never compiles Nim, never builds images per user,
   never holds SSH credentials. Compiled scenes, custom drivers, and shell
   access remain the domain of the self-hosted AGPL backend.
2. **The device is the security boundary, not the cloud.** A compromised
   cloud account (or a compromised cloud) can install sandboxed interpreted
   scenes on your frames and nothing else. It cannot reach a shell, write
   arbitrary files, pivot into the owner's home network, or push unsigned
   code. This is enforced by the device-side protocol handler having no such
   verbs, not by configuration flags the control plane could flip.

The cloud grows only a small frame control plane: a WebSocket hub, a `frames`
data model, scene assignment, and telemetry. It is a port of *roles* from the
Python backend, not a port of its code. This is deliberately the
"device-first" model: the frame is the product; the cloud is identity, store,
relay, and fleet view.

The management UI is the existing FrameOS frontend — the same SPA that
already serves the self-hosted backend and the on-device admin panel — built
as a third wrapper bundle for the cloud (see "Frontend: the fourth adapter",
"Repo layout", and "Licensing").

## Goals

- One-click onboarding: download image / enter code / flash from browser,
  frame appears in the account.
- Manage frames from `account.frameos.net` with no self-hosted backend.
- Assign store scenes and private scenes to frames; edit them in the hosted
  editor; changes go live without a deploy.
- Fleet basics: online/offline, health, logs and metrics (opt-in scopes),
  scene previews.
- The self-hosted stack remains fully functional with zero cloud, forever.
- The protocol stays reimplementable by third parties (existing hard rule).

## Non-goals / hard rules

These are load-bearing constraints, in the spirit of the existing "no image
proxies, ever" rule in `AGENTS.md` at the repo root:

- **The cloud never gains SSH access to frames.** No SSH credentials, host
  keys, or shell transport ever touch the cloud data model.
- **The cloud never compiles scenes or builds images per user.** No Nim
  codegen, no per-user buildroot builds, no Docker build farm. Generic
  images are prebuilt and served from `archive.frameos.net`.
- **No image proxies for frame content** (inherited rule). Frames fetch and
  render images directly from source. Fleet previews are rendered in the
  browser via `frameos-wasm`, not screenshotted through the cloud.
- **Frames must keep working when the cloud is down.** Rendering, schedules,
  and the local admin page never depend on cloud reachability. Cloud is
  additive.
- **No dangerous verbs behind flags.** Any capability the cloud must never
  have is absent from the cloud-profile protocol handler on the device — not
  disabled by a setting, because settings arrive from the control plane.
- Hosted full backends (compiler + SSH, the current Python stack as a
  service) are explicitly **out of scope**. Interpreted scenes plus cloud
  mode are expected to solve ~99% of the need; hosted backends can be
  revisited later as a separate product without changing this design.

## Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│ FrameOS Cloud (this repo)  │        │ Frame (Pi / buildroot / ESP) │
│                            │  WSS   │                              │
│  identity + accounts       │◄───────┤  frameos_remote, CLOUD       │
│  scene store               │ out-   │  profile (restricted verbs)  │
│  frames table + assignment │ bound  │                              │
│  WebSocket hub             │ only   │  frameos runtime             │
│  telemetry sink (opt-in)   │        │   ├ interpreted scenes (JS)  │
│  wasm previews (browser)   │        │   ├ compiled scenes (local)  │
└────────────────────────────┘        │   └ local admin (full power) │
                                      └──────────────────────────────┘
```

- The device dials out (WSS), reusing the pattern of the existing remote
  agent (`frameos/remote/`) and the `remote:access` slot
  already reserved in `docs/cloud-link.md`. There is no inbound
  connectivity requirement and no port forwarding.
- The cloud side is a new, small control plane inside `apps/auth-web` (or a
  sibling service if WS lifetimes demand it): `frames` rows hang off
  `linked_clients` with `client_kind = "frame"`, which already exists.
- The Python backend is **not** ported. Self-hosted backends keep their
  existing link (`connected_backends`); cloud-managed frames bypass backends
  entirely. A frame is managed by exactly one control plane at a time
  (backend or cloud); switching is an explicit local action on the device.

### Single-host constraint

The cloud currently runs as one instance on one host. A WS hub is fine on one
box, but connection registry and command queueing must be keyed through
Postgres (or Redis if introduced) from day one so a second instance is
possible later. No in-memory-only state for frame connectivity.

## Trust and security model

### Threat model

Primary scenario to defeat: **attacker controls the cloud account** (stolen
session, phished password) or, worse, **controls the cloud itself**. In both
cases the blast radius on the owner's frames and home network must be limited
to: installing interpreted scenes that run inside the device sandbox with
render + restricted-HTTP capabilities.

### Cloud agent profile (device-side)

The device agent gains a second profile. Which profile runs is decided by
local state on the device that the cloud profile has no verb to modify.

| | `full` profile (existing) | `cloud` profile (new) |
|---|---|---|
| Peer | self-hosted backend | FrameOS Cloud |
| Enabled by | local backend pairing | enrollment ceremony (local) |
| Shell / PTY | yes (flag-gated today) | **verb does not exist** |
| Arbitrary file write | yes | **verb does not exist** |
| Scene install | compiled + interpreted | **interpreted JSON only** |
| Settings | full config | allowlisted declarative keys |
| Updates | backend-driven | device-initiated, signature-verified |

Cloud-profile verb set (complete):

- `set_scenes` — interpreted scene JSON, validated on device, hot-reloaded
  via the existing uploaded-scenes path.
- `set_schedule`, `set_settings` — declarative allowlist only (brightness,
  rotation, timezone, scene schedule, display options). Never SSH config,
  admin credentials, network config, update URLs, or agent/profile state.
- `get_state`, `get_logs`, `get_metrics` — gated by the `telemetry:*` scopes
  the owner granted.
- `reboot`, `restart_runtime`.
- `notify_update_available` — advisory only; the device fetches and verifies
  independently (see OTA below).

Anything else the socket receives is rejected and audit-logged on-device.

Not every device implements all of it. Microcontroller frames (ESP32) run a
subset — scenes, current scene, state, render, reboot — and answer
`unsupported_verb` for `set_schedule`, `set_settings`, `get_logs`,
`get_metrics` and `notify_update_available`. The management UI should hide
those controls for an `esp32` frame rather than enqueue commands that come
back refused; the profile table lives in `docs/cloud-frames.md`.

### Device identity and enrollment secrets

- Today's model (backend mints `agentSharedSecret`, stores it in its DB) is
  inverted: on first boot the **frame generates its own keypair**; the cloud
  stores only the public key. The control plane can no longer impersonate
  the device, and a cloud DB leak yields no device credentials.
- SD images and personalization files contain **no long-term secrets** —
  only the cloud URL and a single-use, short-lived **claim token** that is
  exchanged during enrollment and then dead. A leaked or shared image file
  is harmless after (and mostly before) enrollment.
- Link tokens for the WS session follow the existing `linked_clients`
  machinery (hashed at rest, rotation grace, revocation from the account UI).

### Interpreted scenes are still code — sandbox posture

"Only interpreted scenes" is only safe if the QuickJS runtime's bindings are
narrow. Required before launch:

1. **Capability audit** of `frameos/src/frameos/js_runtime/` —
   enumerate every native binding exposed to scene JS.
2. **Cloud-installed scenes get render + HTTP only.** Apps carrying the
   store's `"shell"` risk flag refuse to load under the cloud profile.
   No filesystem access outside the scene's own asset sandbox.
3. **RFC1918 / link-local HTTP is blocked by default** for cloud-installed
   scenes. A malicious scene is *inside the owner's LAN*; without this, a
   compromised account becomes an SSRF pivot onto routers and IoT devices —
   exactly the outcome this design exists to prevent. Elevation (a scene
   that legitimately needs LAN access, e.g. Home Assistant) requires a
   **local-presence ceremony**: confirmation on the device's local admin
   page, or a physical button press paired with a code shown on the panel.

### Signed OTA

`upgrade.nim` currently fetches GitHub releases without signature
verification. Before the cloud can even *suggest* updates:

- Releases are signed (minisign/ed25519); the public key is baked into
  images; the private key is held offline and is never in the cloud DB.
- The device verifies signatures itself and updates on its own schedule.
  Cloud compromise therefore cannot become native code execution via the
  update channel.

### Account hardening

An account that controls physical devices needs more than email + password:

- Passkeys and TOTP 2FA.
- Re-authentication for sensitive actions (revoking frames, changing scene
  assignments in bulk, scope grants).
- Per-frame audit trail surfaced in the UI (the `audit_events` table already
  exists).

## "Add frame" flows

One button, three tiles, one shared enrollment endpoint.

### 1. Download SD card image

- Generic per-device images are prebuilt and served from
  `archive.frameos.net` (already the precompiled-image path for buildroot).
  The cloud never builds images on demand.
- Personalization is a small file on the FAT boot partition — written by the
  user after flashing, or injected by the cloud into the downloaded image
  with a cheap offset patch (no rebuild). Contents: cloud URL, claim token,
  optionally WiFi credentials the user typed into the download form.
- If WiFi is embedded, the download link is short-lived and the UI states
  the image contains network credentials. Default flow leaves WiFi out and
  relies on the existing captive portal (`FrameOS-Setup` hotspot).
- Boot sequence: flash → boot → portal if no network → dial cloud with
  claim token → keypair enrollment → frame appears as **pending** in the
  account → owner confirms.
- Initial hardware support is whatever buildroot supports (today: Raspberry
  Pi Zero 2 W); `rpios` users can enroll via flow 2 instead.

### 2. Link an existing frame (code / QR)

The RFC 8628 device flow already implemented for backends, initiated from
the frame: the setup portal or the local admin page — or, best, **the e-ink
panel itself** — shows a short code and QR pointing at
`account.frameos.net/device`. Displaying the code on the physical panel
doubles as proof of possession. This reuses `client_kind = "frame"`,
which the device-flow tables already support.

### 3. Flash from browser (ESP32)

esptool-js over WebSerial: plug in USB, click Flash in Chrome, firmware from
the existing `embedded/` pipeline with the claim token passed at flash time.
No SD card involved. This is the flagship onboarding demo when embedded
frames are ready.

## Cloud data model (sketch)

New tables, hanging off existing machinery:

- `frames` — 1:1 with a `linked_clients` row (`client_kind = "frame"`).
  Device public key, hardware model, display size/type, firmware version,
  `last_seen_at`, `pending`/`active`/`revoked`.
- `frame_scene_assignments` — frame ↔ scene (store scene version or private
  account scene version) plus order/schedule. Assignment writes enqueue a
  `set_scenes` push; the device's ack updates sync state.
- `frame_commands` — durable queue of pending pushes per frame (survives
  restarts; drained on reconnect), with TTL and audit linkage.
- `frame_telemetry` — recent health/log/metric samples, opt-in per scope,
  aggressively capped and pruned (single Postgres, 8 MB-blob-era budgets).
- `enrollment_tokens` — hashed single-use claim tokens with expiry, minted
  by "Add frame".

Scenes themselves need no new storage: store scenes and private account
scenes (`store_scenes` + versions) are already the unit of content. "My
frames" becomes a sibling of `account/installs`.

## Frontend: the fourth adapter

The FrameOS frontend is already multi-context by design.
`docs/api-triality.md` defines a canonical management API —
feature code calls logical `/api/...` paths — with three adapters: the
Python backend (project-scoped), the Pi device (served directly by the Nim
server), and the ESP32 subset. The on-device admin panel is not a separate
UI: `frameos/frontend/` is a ~700-line wrapper package that
deep-imports the main frontend (`FrameWorkspace`, `SceneWorkspace`,
`socketLogic`, the kea models), builds its own esbuild bundle, and flips
behavior via `window.FRAMEOS_APP_CONFIG` flags (`frameMode`,
`frameAdminMode`).

The cloud is the **fourth adapter** of that API and the **third wrapper
bundle** of that SPA:

- A `cloud-frontend/` wrapper package, modeled on `frameos/frontend/`, sets
  `FRAMEOS_APP_CONFIG = { cloudMode: true }`, imports the workspace shell
  and the scenes it needs, and esbuilds a static bundle.
- Next.js serves that bundle at `account.frameos.net/frames/**` as a
  first-class route (HTML shell + static assets) — **not an iframe**.
  Since the 2026-08 React 19 unification the whole workspace shares one
  React major, so the wrapper bundle is a packaging choice (esbuild SPA vs
  Next), not a version-isolation necessity — and importing SPA components
  directly into Next pages is open as a future option.
- API: the cloud implements the canonical `/api/frames...` subset. The SPA
  has a single transport chokepoint (`src/utils/apiFetch.ts` plus the path
  scoping in `src/utils/projectApi.ts`); the cloud adapter is one more
  rewrite rule. Auth is the existing session cookie — the SPA already sends
  `credentials: "include"`, and the shared cookie domain covers
  `account.frameos.net`.
- WebSocket: the frame hub emits the same event names `socketLogic` already
  dispatches (`update_frame`, `new_log`, `new_metrics`, `frame_rendered`,
  …), so the live UI works unchanged.
- On 401 the SPA redirects to cloud login; its own `login/` / `signup/`
  scenes never render in cloud mode — Next.js owns auth.

Panel and scene availability in cloud mode, gated the same way
`frameAdminMode` gates panels today:

| Existing surface | Cloud mode |
|---|---|
| `FramesHome` fleet grid | ✅ enrolled frames, online/offline, wasm previews |
| `SceneWorkspace` + `Diagram` editor | ✅ interpreted scenes only |
| `Scenes`, `Schedule`, `Templates` (store) | ✅ core of the product |
| `FrameSettings` | ✅ reduced to the declarative allowlist |
| `Logs`, `Metrics`, `Image` | ✅ behind `telemetry:*` scopes |
| `Terminal`, `Debug`, `SceneSource`, deploy drawer, SSH settings | ❌ never rendered — mirrors the protocol having no such verbs |
| `login/`, `signup/` scenes | ❌ cloud auth pages own this |

Per-frame capability gating reuses the existing
`src/utils/embeddedCompatibility.ts` pattern: shell-flagged apps and
compiled-only features are filtered for cloud frames exactly as they are for
`frame.mode === "embedded"`.

## Repo layout

The cloud lives in this monorepo as `cloud/` (sibling of `backend/`,
`frontend/`, `frameos/`), in one unified pnpm workspace — `frameos-wasm` and
`frameos-editor` are `workspace:` dependencies, with Turborepo orchestrating
the cross-package builds. The frontend sharing model above is relative deep
imports inside that workspace — there is no published component library; the
monorepo *is* the sharing mechanism, the same way the on-device admin
consumes the frontend today. `cloud-frontend/` will sit beside
`frameos/frontend/` as the two thin SPA wrappers.

**Monorepo ≠ mono-deploy.** Device releases stay `versions.json`-driven; the
cloud ships continuously from its subdirectory; CI splits by path filters.

## Changes required outside `cloud/` (device + shared frontend)

This doc records the contract; the work lands there (post-merge: same repo,
different subtrees):

1. Cloud profile in the remote agent (restricted verb dispatcher, local
   profile state, on-device audit log).
2. Device-generated keypair enrollment + claim-token exchange.
3. JS runtime capability audit; per-origin scene capability enforcement;
   RFC1918 fetch blocking with local-presence elevation.
4. Signed release verification in `upgrade.nim`.
5. Boot-partition personalization file support in the buildroot image +
   portal claim-token handoff.
6. Panel-displayed link code for flow 2.
7. Local ceremony to switch a frame between backend-managed and
   cloud-managed (exactly one control plane at a time).

Shared-frontend work:

8. `cloudMode` flag plus panel/scene gating in the main frontend (the
   `frameAdminMode` pattern), and the `cloud-frontend/` wrapper package.
9. Cloud adapter rewrite rule in `apiFetch` / `projectApi.ts`; the matching
   WebSocket event emission is cloud-side work.
10. Extend `embeddedCompatibility`-style app/template gating to cloud
    frames (interpreted-only, no shell-flagged apps).

`docs/cloud-link.md` there should gain the frame-link protocol, filling in
its reserved `remote:access` placeholder; the wire protocol spec stays public
documentation (see Licensing) so third-party clouds can implement it.

## Licensing

Everything in this repo, `cloud/` included, is AGPL-3.0 — one license
everywhere. The wire contract stays public documentation (this doc plus the
`cloud-link.md` successor): it keeps device and cloud loosely coupled and
versionable, keeps the "reimplementable by third parties" promise credible,
and keeps the capability boundary honest. The spec states explicitly that
independent implementations of the documented protocol require no permission
or license from us. Trademark/branding ("FrameOS", "FrameOS Cloud",
`frameos.net`) stays reserved. The business moat is the hosted service, the
store network, the archive, and the trademark — not the source (see
Monetization).

## Monetization

Free tier is the product's credibility; paid tiers are convenience and
capacity, never security or lock-in:

- **Free, forever**: account, enrolling and managing frames, installing
  public store scenes, basic status. Self-hosting everything remains free
  by license.
- **Paid (subscription)** — candidates, roughly in order of likely value:
  - Backups beyond a small quota (scene/frame config history, restore).
  - Private and org-shared scene hosting beyond the free quota; team
    workspaces (the Organization/Project tenancy in the Python backend is
    the model to eventually mirror).
  - Extended telemetry retention, offline alerting/notifications.
  - Larger fleets (free tier covers a household, e.g. 3–5 frames).
- **Explicitly deferred**: hosted full backends (compiler + SSH as a
  service). Possible later as a separate isolated product; nothing in this
  design may depend on it.

Nothing security-relevant (2FA, revocation, signed updates, sandbox
enforcement) is ever paywalled.

## Phasing

In order:

1. **Protocol + profile (foundations)** — cloud agent profile in
   the device runtime, keypair enrollment, claim tokens, WS hub + `frames` table
   here, "Add frame" flow 2 (link code). No scene pushing yet; a frame can
   enroll, appear in the account, show status, and be revoked.
2. **Scene management** — `set_scenes` push of interpreted scenes, the
   `cloud-frontend` wrapper bundle (fleet grid, scene assignment, wasm
   previews, declarative settings + schedule). Requires the JS capability
   audit and RFC1918 blocking to land first.
3. **Provisioning** — SD image tile (personalization file + archive-served
   images), portal claim handoff. ESP32 web flashing when embedded is ready.
4. **Fleet extras** — telemetry scopes, alerting, backups integration,
   paid-tier gating.

Signed OTA (device-side) should land before or alongside provisioning, since
widely distributed images make the unsigned update channel the weakest link.

## Open questions

- **WS hub placement**: inside the Next.js process (custom server) vs. a
  small sibling service sharing the DB. Next.js route handlers are awkward
  hosts for long-lived sockets; a sibling `apps/frame-hub` may be cleaner.
  Decide when the foundations work starts.
- **Fleet previews doctrine**: is browser-side wasm rendering the permanent
  answer (extending the no-image-proxy rule to previews), or is an opt-in,
  end-to-end-encrypted screenshot path ever acceptable?
- **Promotion/demotion UX**: exact local ceremony for moving a frame between
  backend-managed and cloud-managed without resetting it.
- **Free-tier quotas**: frame count, backup size, private scene count —
  pick numbers when provisioning starts, not before.
- **QuickJS hardening budget**: memory/CPU/time limits per scene are partly
  device-stability features and partly sandbox features; scope during the
  capability audit.
