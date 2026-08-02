# Cloud-managed frames — wire protocol

This document is the public, reimplementable contract between a frame and a
"cloud provider" that manages it directly (no self-hosted backend in between).
The product design and security rationale live in `cloud/docs/cloud-frames.md`;
this file specifies only what goes over the wire, in the same spirit as
`docs/cloud-link.md` (which it extends). Independent implementations of this
protocol require no permission or license from us.

Vocabulary: **provider** is the cloud (`https://cloud.frameos.net` by default,
user-editable, same rules as `docs/cloud-link.md`). **Frame** is the device.
**Owner** is the provider account that enrolled the frame.

## Principles (inherited, load-bearing)

- **Outbound-only.** The frame initiates every connection, including the
  management WebSocket. The provider can never reach into a device.
- **The device is the security boundary.** The cloud-profile protocol handler
  on the device has no shell, no arbitrary-file-write, and no compiled-code
  verbs — *the verbs do not exist*, they are not flag-disabled. A compromised
  provider or account is limited to installing sandboxed interpreted scenes
  and reading whatever telemetry the owner opted into.
- **Interpreted scenes only.** The provider ships node-graph scene JSON to the
  device's interpreted runtime. Compiled scenes, drivers, and shell access
  remain the domain of the self-hosted backend.
- **No long-term secrets in images.** SD images and flasher payloads carry at
  most a single-use, short-lived claim token. The device generates its own
  keypair at enrollment; the provider stores only the public key.
- **One control plane at a time.** A frame is managed by its self-hosted
  backend or by a provider, never both. Switching is a local action on the
  device; no provider verb can change it.
- **Frames keep working when the provider is down.** Rendering, schedules,
  and the local admin page never depend on provider reachability.

## Enrollment

Two paths mint the same thing: a `linked_clients` row with
`client_kind = "frame"` plus a `frames` row on the provider, and a
`state/cloud_link.json` (mode `"managed"`) on the device.

### A. Claim token (SD image / browser flasher / manual paste)

The owner clicks **Add frame** on the provider and receives a claim token
(`FRCT_` prefix, single use, short expiry — cloud.frameos.net: 24 h). The
token reaches the device via the SD boot-partition personalization file, the
ESP32 flasher, or by pasting it into the device's setup portal / local admin
page. The device then calls, unauthenticated:

```http
POST {provider}/api/frames/enroll
```

```json
{
  "claim_token": "FRCT_…",
  "public_key": "base64 Ed25519 public key, generated on-device",
  "hardware": {
    "platform": "pi-zero2w | pi | esp32 | …",
    "device": "…driver name…",
    "width": 800, "height": 480, "color": "…"
  },
  "frameos_version": "2026.8.1",
  "name": "…optional, e.g. from the personalization file…"
}
```

Response `200`:

```json
{
  "access_token": "…opaque bearer, hashed at rest provider-side…",
  "token_type": "Bearer",
  "scope": "frame:managed",
  "frame_id": "…",
  "status": "pending",
  "ws_path": "/api/frames/ws"
}
```

Errors: `400 invalid_claim_token` (unknown/expired/used), `400
invalid_public_key`, `429` on abuse. The claim token is dead after one use,
success or failure. The frame stores the token in its `0600` state file and
appears as **pending** in the owner's account; the owner confirms it there
(a deliberate click, showing hardware details) before any scene push is
accepted. Re-enrolling a revoked frame needs a fresh claim token.

### B. Link code on the device (RFC 8628)

The device-authorization flow from `docs/cloud-link.md`, initiated from the
setup portal, the local admin page, or the panel itself, with
`client_kind: "frame"` and `scopes: ["frame:managed"]`. The consent screen is
the ownership proof, so a frame enrolled this way is born `active`, not
`pending`. After approval the device calls `/api/frames/enroll` with
`{"public_key": …, "hardware": …}` and the device-flow Bearer token instead
of a claim token, to register its key and fetch `frame_id`/`ws_path`.

### Scopes

`frame:managed` is the base scope: connect the WS, receive scene/settings
pushes, report state. Telemetry is opt-in per scope, exactly as reserved in
`docs/cloud-link.md`:

| Scope | Allows the provider to |
|---|---|
| `frame:managed` | manage this frame (scenes, declarative settings, state) |
| `telemetry:logs` | receive and retain device logs |
| `telemetry:metrics` | receive and retain device metrics |

Scope changes use the existing `/api/backends/scopes` mechanism (additions
need owner approval on the provider's device screen; removals are immediate).

## The management WebSocket

The frame dials `wss://{provider}{ws_path}` with
`Authorization: Bearer <access_token>`. Plain `ws://` is acceptable only for
the hosts `docs/cloud-link.md` allows for `http://` providers (development).

All messages are JSON text frames: `{"id": "…", "type": "…", …payload}`.
`id` is set by the sender; replies carry the same `id`. Unknown message types
are answered with `{"type": "error", "error": "unknown_verb"}` — and, on the
device, audit-logged.

### Session start

1. Frame → provider: `{"type": "hello", "frameos_version": "…",
   "hardware": {…}, "states": {…scene state…}, "scenes_checksum": "…"}`
2. Provider → frame: `{"type": "challenge", "nonce": "base64, ≥32 bytes"}`
3. Frame → provider: `{"type": "auth", "signature": "base64 Ed25519 sig over
   nonce"}` — proves possession of the enrolled private key, so a leaked
   bearer token alone cannot impersonate a device.
4. Provider → frame: `{"type": "ready", "pending_commands": N}` — then drains
   the durable per-frame command queue in order.

The provider must verify the signature against the enrolled public key and
close the socket on mismatch. The frame reconnects with jittered exponential
backoff; the provider treats the WS liveness as `last_seen_at`.

### Provider → frame verbs (complete list)

The device rejects and audit-logs anything not listed here. Every verb is
acked: `{"id", "type": "ack", "ok": true}` or
`{"id", "type": "ack", "ok": false, "error": "…"}`.

| Verb | Payload | Device behavior |
|---|---|---|
| `set_scenes` | `{"scenes": […interpreted scene JSON…], "checksum"}` | validate as interpreted node-graph JSON (`error: "invalid_scenes"`); refuse any compiled/source payload — an app node shipping `.nim` sources without a JS implementation refuses the whole push (`error: "not_interpreted"`); hot-reload via the uploaded-scenes path; persist locally so a reboot without cloud keeps rendering; ack then `scene_ack` |
| `set_schedule` | `{"schedule": {…}}` | replace the scene schedule |
| `set_settings` | `{"settings": {…}}` | allowlisted declarative keys only (`name`, `rotate`, `interval`, `scaling_mode`, `timezone`, `debug`; `brightness` joins the list once the runtime grows a brightness setting); unknown or non-allowlisted keys → the whole verb is refused (`error: "setting_not_allowed"`) |
| `set_current_scene` | `{"scene_id": "…"}` | switch active scene |
| `get_state` | `{}` | reply with the `hello`-shaped state: the ack carries it as `"state"`, and a `state` message with the same `id` follows |
| `get_logs` | `{"since"?: iso-ts, "limit"?: N}` | reply with buffered log lines in the ack as `"logs"` (requires `telemetry:logs`; device caps `limit` at 1000) |
| `get_metrics` | `{}` | reply with buffered metrics samples in the ack as `"metrics"` (requires `telemetry:metrics`) |
| `render` | `{}` | trigger a re-render |
| `reboot` | `{}` | reboot the device |
| `restart_runtime` | `{}` | restart the FrameOS process |
| `notify_update_available` | `{"version": "…"}` | advisory only — the device fetches release metadata from its own configured archive and verifies signatures itself; the provider supplies no URLs and no binaries |

Explicitly absent, by design (see `cloud/docs/cloud-frames.md`): shell/exec,
PTY, file read/write, SSH anything, network/WiFi config, admin credentials,
update URLs, agent/profile state, compiled scene deploys.

### Frame → provider messages

| Type | Payload | Notes |
|---|---|---|
| `state` | `hello`-shaped | sent on scene change / significant events |
| `log_batch` | `{"logs": [{"timestamp", "scene"?, "payload"}…]}` | only with `telemetry:logs`; batched (device: ≤2 s / ≤100 lines); provider stores with a hard per-frame retention cap and counts retained bytes toward the account's storage usage |
| `metrics` | `{"metrics": {…}}` | only with `telemetry:metrics` |
| `scene_ack` | `{"checksum", "active_scene"}` | after a successful `set_scenes`, drives provider-side sync state |

A provider must tolerate unknown frame→provider types (forward compatibility).

## Provisioning

### SD card image personalization

Generic, unpersonalized images per board are prebuilt and published (the
provider never builds images per user). Personalization is one INI-style file
on the FAT boot partition, `frameos-cloud.txt`, written by the user after
flashing or patched into the download by the provider without a rebuild:

```ini
# frameos-cloud.txt — read once on first boot, then shredded
cloud_url=https://cloud.frameos.net
claim_token=FRCT_…
name=Kitchen frame
wifi_ssid=…            # optional; omitted by default
wifi_password=…        # optional
```

Parsing is deliberately forgiving: `KEY=value` lines, `#` comments, blank
lines, CRLF endings, and whitespace around keys/values are all tolerated;
unknown keys are ignored. `cloud_url` may be omitted and defaults to
`https://cloud.frameos.net`. On minimal (busybox-only) images the first-boot
handler strips double quotes, backslashes, and control characters from
values, so avoid them in `name` and WiFi credentials.

First boot: if the file exists, the device stores the config (Pi/buildroot:
`state/cloud_enroll_pending.json` under the FrameOS working directory, mode
`0600`, containing `{"claim_token": …, "provider_url": …, "name"?: …}`, plus
a NetworkManager keyfile when WiFi was embedded), shreds the file —
zero-overwrite then delete, best effort on FAT — joins WiFi (from the file or
via the existing `FrameOS-Setup` captive portal), and enrolls via flow A. If
enrollment fails
the claim token is kept in the `0600` state file and retried with backoff
until its expiry, then the portal shows a "get a new code" hint. Downloads
with embedded WiFi credentials must be short-lived links and labeled as
containing secrets.

### ESP32 browser flashing

The provider's flasher page uses WebSerial + esptool-js to write the prebuilt
generic firmware, then provisions `cloud_url` + `claim_token` (+ optional
WiFi) into the device's NVS config partition. Same enrollment flow A over the
device's own network connection afterwards. The firmware binaries come from
the release archive; the flasher never receives per-user builds.

Concretely, the generic firmware exposes these as allowlisted keys on the
existing USB serial console (`set cloud_url …`, `set claim_token …`,
`wifi <ssid> [pass]`), the same machine-readable channel the browser-based
frame admin already drives — so the flasher provisions over serial after
flashing instead of patching the NVS partition image. The claim token is
write-only: no console, status, or HTTP surface ever echoes it (or the
device key / access token) back. Enrollment state is surfaced as
`cloud: none|pending|enrolled|error` in `status` and in the `/status` JSON.
The ESP32 `hardware` object sends `platform: "esp32"` with the panel driver
name as both `device` and `panel`, plus `width`/`height`; a permanent
enrollment rejection (HTTP 400) erases the claim token on-device and shows
`error` until a fresh token is provisioned.

## Provider-side HTTP API (account-authenticated)

These are the endpoints the management UI uses; they are provider-internal
but documented so the shared frontend's cloud adapter is reimplementable:

```http
POST {provider}/api/frames/claim-tokens        # mint a claim token ("Add frame")
GET  {provider}/api/frames                     # list the account's frames
GET  {provider}/api/frames/{id}                # one frame, state + sync status
POST {provider}/api/frames/{id}/confirm        # pending → active
POST {provider}/api/frames/{id}/revoke         # revoke link; device demotes itself on next 401
GET  {provider}/api/frames/{id}/logs           # retained logs (telemetry:logs)
GET  {provider}/api/frames/{id}/scenes         # assigned scenes
POST {provider}/api/frames/{id}/scenes         # assign scene versions → enqueues set_scenes
POST {provider}/api/frames/{id}/settings       # declarative settings → enqueues set_settings
POST {provider}/api/frames/{id}/command        # {"type": "render" | "reboot" | "restart_runtime" | "set_current_scene", …}
WS   {provider}/api/frames/{id}/updates        # browser socket: update_frame / new_log / new_metrics events
WS   {provider}/api/frames/updates             # browser socket, all the account's frames (fleet view)
```

Frame log retention and any stored previews count toward the account's
storage usage figure, itemized per frame.

## Device-side state and demotion

`state/cloud_link.json` gains `"mode": "managed"` alongside the existing
direct-link fields, plus `"frame_id"`, `"ws_path"` and `"scenes_checksum"`
(the checksum of the last accepted `set_scenes` push, reported back in
`hello`). Two sibling files complete the managed state, all `0600`:

- `state/cloud_device_key` — the base64 Ed25519 private-key seed, generated
  on-device at first enrollment. Nothing reads it back out except the
  challenge signer; disconnecting keeps it (a revoked frame still needs a
  fresh claim token to re-enroll).
- `state/cloud_enroll_pending.json` — the claim-token boot handoff:
  provisioning (SD personalization file, ESP32 flasher, setup portal) writes
  `{"claim_token", "provider_url", "name"?, "expires_epoch"?}` and the
  runtime enrolls at startup with backoff until the token is exchanged,
  rejected, or expired, then deletes the file.

Local enrollment surfaces call `POST /api/cloud/enroll` (admin-session-gated)
with `{"claim_token", "provider_url"?, "name"?}` for flow A; flow B rides the
existing `/api/cloud/connect` + `/api/cloud/poll` device flow with the
`frame:managed` scope. Both are refused with `409` while `frame.json` names a
self-hosted backend (`serverHost`) — one control plane at a time.

While managed:

- the local admin page stays fully functional (it is the escape hatch and the
  local-presence surface), and shows a "managed by {provider}" banner;
- a persistent `401 invalid_link_token` on the WS or HTTP APIs — the device
  demotes after 3 consecutive authentication rejections — resets the link,
  returns the frame to standalone, and keeps rendering the last pushed
  scenes;
- leaving managed mode (to standalone or to backend-managed) is a local admin
  action only (`POST /api/cloud/disconnect`). Enrolling with a backend while
  managed — or vice versa — requires that local demotion first.

### Local network access

Cloud-installed scenes run *inside the owner's LAN*, so while a frame is
managed its HTTP stack denies requests whose target resolves to a private or
local address — loopback (`127/8`, `::1`), RFC1918 (`10/8`, `172.16/12`,
`192.168/16`), link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`),
`0.0.0.0/8`, broadcast, IPv6 ULA — whether the URL names the address
literally or a DNS name (redirects included) resolves to one. Blocked
requests fail with `local network access is blocked on cloud-managed frames`
in the scene logs. Two exceptions:

- the provider's own API endpoint (exact `host:port` from the stored
  `provider_url`) stays reachable, so development providers on the LAN work —
  the local admin linked that endpoint deliberately;
- the owner can lift the deny per frame with the `frame.json` field
  `network.allowLocalNetworkAccess` (default `false`). It is settable only
  through the local admin surface: the key is not in the `set_settings`
  allowlist, so no provider verb can flip it — this is the local-presence
  elevation for scenes that legitimately need LAN access (e.g. Home
  Assistant).

Standalone and backend-managed frames are unaffected; the deny is active only
in managed mode.

## Compatibility

Providers must drop unknown fields, frames must ignore unknown optional
response fields, and both sides version through `frameos_version` /
`hello` — there is no separate protocol version until a breaking change
forces one.
