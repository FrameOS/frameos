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
  most a short-lived claim token with a small use budget (single-use by
  default). The device generates its own keypair at enrollment; the provider
  stores only the public key.
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
  "ws_path": "/api/frames/ws",
  "ws_url": "ws://10.0.0.5:3100/api/frames/ws"
}
```

`ws_url` is optional: a full `ws://` or `wss://` URL the device dials for the
management WebSocket *instead of* `{cloud_url}{ws_path}`. Providers send it
only when the socket lives somewhere other than the enrollment origin — in
practice a development deployment whose frame hub is a second process on its
own port (cloud.frameos.net's dev setup: the hub from `FRAME_HUB_PUBLIC_URL`,
or `:3100` on the same host when the enrollment request arrived on a loopback
host). In production the WS path is proxied on the same origin and the field
is omitted. Devices hold `ws_url` to the same transport rule as `cloud_url`
(`wss://` anywhere; plain `ws://` only for localhost, `.local`/`.localhost`
and private-network hosts) and ignore a value that fails it, falling back to
the `ws_path` flow.

Errors: `400 invalid_claim_token` (unknown/expired/budget spent), `400
invalid_public_key`, `429` on abuse, `403 frame_quota_exceeded` when the
account is at its frame limit. Each successful enrollment spends one use of
the token's budget atomically (single-use by default; see "Multi-use claim
tokens" under Provisioning), and a use is spent only when a frame is actually
created — a rejected enrollment leaves the budget untouched, so a device that
hits the quota can retry the same token once the owner frees a slot.

Retrying is safe: a repeat of the same `(claim_token, public_key)` pair while
the frame is still pending is idempotent and returns the same `frame_id` with
a usable access token, so a response lost in flight does not strand the
device. The same token presented with a *different* device key is refused —
`409 public_key_mismatch` — since that is a different device, not a retry.

The frame stores its access token in a `0600` state file and appears as
**pending** in the owner's account; the owner confirms it there (a deliberate
click, showing hardware details) before any scene push is accepted.
Re-enrolling a revoked frame needs a fresh claim token.

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

The frame dials `wss://{provider}{ws_path}` — or the enrollment response's
`ws_url` verbatim when one was given (see Enrollment) — with
`Authorization: Bearer <access_token>`. Plain `ws://` is acceptable only for
the hosts `docs/cloud-link.md` allows for `http://` providers — localhost,
`.local`/`.localhost` names, and private-network literals (RFC1918, loopback,
link-local, CGNAT). Devices enforce this: a `cloud_url` that is neither
`https://` nor one of those plaintext dev hosts is refused at provisioning
time and never enrolled against, because the claim token, the bearer token
and every scene push ride this connection.

All messages are JSON text frames: `{"id": "…", "type": "…", …payload}`.
`id` is set by the sender; replies carry the same `id`. Message types the
device does not recognize are answered — like every other verb — with an ack
carrying the failure: `{"id", "type": "ack", "ok": false, "error":
"unknown_verb"}`, and audit-logged on the device. A verb that *is* in this
document but is not implemented by the device's profile (see "Device
profiles" below) is answered `"error": "unsupported_verb"` instead, so a
provider can tell a smaller profile apart from a protocol violation.

Message size: providers and devices both cap a single text frame. A device
may cap lower than the provider — the ESP32 firmware refuses anything over
**512 KiB** (its whole on-device scene store is 512 KiB) and acks
`message_too_large`. Providers should keep pushes well under the smallest
profile they target rather than relying on the cap.

### Session start

1. Frame → provider: `{"type": "hello", "frameos_version": "…",
   "hardware": {…}, "states": {…scene state…}, "scenes_checksum": "…"}`
2. Provider → frame: `{"type": "challenge", "nonce": "base64"}` — the nonce is
   at least **32 random bytes**, and the minimum is on the *decoded* length,
   not on the base64 text.
3. Frame → provider: `{"type": "auth", "signature": "…"}` — proves possession
   of the enrolled private key, so a leaked bearer token alone cannot
   impersonate a device.

   **The signature is computed over the raw bytes obtained by base64-decoding
   `nonce`, not over the base64 text.** The frame must base64-decode the
   nonce, sign those bytes with its Ed25519 private key, and base64-encode the
   64-byte signature; the provider verifies the signature against the same
   decoded bytes it generated. (Signing the base64 text is the obvious
   mistake, and it fails silently — the socket simply closes.)
4. Provider → frame: `{"type": "ready", "pending_commands": N,
   "scopes"?: ["frame:managed", "telemetry:logs", …]}` — then drains the
   durable per-frame command queue in order. The optional `scopes` array is
   the link's currently granted scope list; a device should treat it as
   additive truth and enable the matching push loops (telemetry above all) —
   it is how a frame whose enrollment response under-reported the grant
   learns it may send logs and metrics without re-enrolling.

The provider must verify the signature against the enrolled public key and
close the socket on mismatch, with WebSocket close code **4401** (also used
when a frame is revoked mid-session). A challenge that simply goes
unanswered within the provider's auth window closes with **4408** instead:
a slow device — an e-paper frame mid-refresh can stall for a minute — must
be able to miss the window and redial without it counting as an
authentication rejection. An upgrade rejected before the socket opens — bad
or unknown bearer token — is a plain HTTP `401`.

The frame reconnects with jittered exponential backoff (a device picks its
delay uniformly from the lower half of a doubling window, so a fleet that
lost the provider together does not come back in lockstep); the provider
treats the WS liveness as `last_seen_at`. The `4401` close and the HTTP
`401` count toward the demotion rule under "Device-side state and
demotion"; `4408` never does.

### Provider → frame verbs (complete list)

The device rejects and audit-logs anything not listed here. Every verb is
acked: `{"id", "type": "ack", "ok": true}` or
`{"id", "type": "ack", "ok": false, "error": "…"}`. The ack carries only
`id` / `ok` / `error`; verbs that return data send it as a separate
frame → provider message carrying the same `id`.

Common `error` values, beyond the per-verb ones in the table:
`unknown_verb` (not in this document), `unsupported_verb` (in this document
but not in this device's profile), `message_too_large`, `invalid_json`,
`no_memory`.

| Verb | Payload | Device behavior |
|---|---|---|
| `set_scenes` | `{"scenes": […interpreted scene JSON…], "checksum", "scene_id"?: "…", "state"?: {…}}` | validate as interpreted node-graph JSON (`error: "invalid_scenes"`); refuse any compiled/source payload — an app node shipping `.nim` sources without a JS implementation refuses the whole push (`error: "not_interpreted"`); hot-reload via the uploaded-scenes path; persist locally so a reboot without cloud keeps rendering; ack once the payload is accepted and persisted, then `scene_ack` once it is actually live (no `scene_ack` if the hot-load fails — the frame is then genuinely out of sync). The optional `scene_id` names which of the pushed scenes to activate (default: the first) and `state` carries its initial public scene-state values — the shape the workspace's "preview on frame" flow produces |
| `set_schedule` | `{"schedule": {…}}` | replace the scene schedule |
| `set_settings` | `{"settings": {…}}` | allowlisted declarative keys only (`name`, `rotate`, `interval`, `scaling_mode`, `timezone`, `debug`; `brightness` joins the list once the runtime grows a brightness setting); unknown or non-allowlisted keys → the whole verb is refused (`error: "setting_not_allowed"`) |
| `set_current_scene` | `{"scene_id": "…", "state"?: {…}}` | switch active scene; the optional `state` object carries public scene-state field values, forwarded to the scene exactly as the local `setCurrentScene` event would |
| `get_state` | `{}` | bare ack, then a separate `{"id", "type": "state", …}` message with the same `id` carrying the `hello`-shaped state |
| `get_logs` | `{"since"?: iso-ts, "limit"?: N}` | bare ack, then a `log_batch` message with the same `id` carrying the buffered lines (requires `telemetry:logs`; device caps `limit` at 1000) |
| `get_metrics` | `{}` | bare ack, then a `metrics` message with the same `id` carrying the buffered samples (requires `telemetry:metrics`) |
| `render` | `{}` | trigger a re-render |
| `reboot` | `{}` | reboot the device |
| `restart_runtime` | `{}` | restart the FrameOS process |
| `notify_update_available` | `{"version": "…"}` | advisory only — the device fetches release metadata from its own configured archive and verifies signatures itself; the provider supplies no URLs and no binaries |
| `assets_list` | `{}` | bare ack, then a separate `{"id", "type": "assets", "assets": [{"path", "size", "mtime", "is_dir"?}…], "truncated"?: true}` message with the same `id`. Paths are **relative to the device's assets directory** (`assets_path`, default `/srv/assets`) — never absolute. A device may bound the listing (the reference cap is 5000 entries) and must then say so with `"truncated": true` rather than silently stopping |
| `image_get` | `{}` | the frame's current rendered image. Bare ack, then the same `asset_chunk` stream `asset_get` uses (same `id` correlation, same caps); the first chunk's `content_type` says what the device produces (the Linux runtime sends `image/png` of its last render, the ESP32 packs `image/bmp` from its framebuffer). `ok: false` ack with `no_image` when nothing has rendered yet, `busy` on a small device already streaming |
| `asset_get` | `{"path": "…", "thumb"?: true}` | read one file from the assets directory. Failure is an ordinary `ok: false` ack: `invalid_path` (traversal, absolute, or outside the assets directory), `not_found`, `is_directory`, `too_large` (the reference cap is **8 MiB** raw), `busy` (a small device already streaming another file). Success is a bare ack followed by one or more `{"id", "type": "asset_chunk", "seq": 0…N, "data": "<base64>", "done": bool}` messages with the same `id`, in order; the first chunk also carries `"size"` (total raw bytes), `"mtime"` and `"content_type"`. A read that fails after the ack ends the stream with `{"type": "asset_chunk", "id", "error": "…", "done": true}` and the provider discards the partial file. With `thumb`, a device that can generate thumbnails (Linux) returns a small preview; a device that cannot (ESP32) returns the original bytes |
| `asset_put` | `{"path": "…", "data": "<base64>"}` | store one file in the assets directory. The whole payload rides a single message, so the raw size is bounded well under the inbound frame cap (the reference device cap is **2.5 MiB** raw — `too_large` past it); the filename component is sanitized by the device exactly like a local admin upload, parent folders are created as needed, and an existing file at the path is replaced. Errors: `invalid_path` (traversal, absolute, outside the assets directory, or a dot-directory — see below), `invalid_data` (empty or undecodable base64), `too_large`, `write_failed`. The ack carries `"asset": {"path" (relative, as stored), "size", "mtime", "is_dir"}` |
| `asset_mkdir` | `{"path": "…"}` | create a folder (and parents) in the assets directory. Errors: `invalid_path`, `write_failed` |
| `asset_delete` | `{"path": "…"}` | delete a file or folder (recursively) in the assets directory. Errors: `invalid_path`, `not_found`, `write_failed` |
| `asset_rename` | `{"src": "…", "dst": "…"}` | rename/move a file or folder within the assets directory (the destination's parent folders are created). Errors: `invalid_path`, `not_found`, `write_failed` |

Explicitly absent, by design (see `cloud/docs/cloud-frames.md`): shell/exec,
PTY, arbitrary file read/write, SSH anything, network/WiFi config, admin
credentials, update URLs, agent/profile state, compiled scene deploys. The
asset verbs are deliberately not a file API: they are confined to the assets
directory (the same user-content directory the local admin's Assets panel
serves), and the device — not the provider — resolves and bounds every path.
Additionally, the write verbs (`asset_put`/`asset_mkdir`/`asset_delete`/
`asset_rename`) refuse any path containing a dot-component: dot-directories
(`.thumbs`, `.frameos`) are the device's own plumbing (thumbnail cache, scene
snapshots) — readable via `asset_get` where the provider knows a specific
path, but never writable from the wire.

### Device profiles

Not every device implements the whole verb table, and a provider must be able
to tell "this device is smaller" from "you sent something that is not in the
protocol". A device answers `"error": "unsupported_verb"` for a verb that is
in the table but outside its profile, and `"error": "unknown_verb"` for
anything else. Both are ordinary `ok: false` acks, so a durable command queue
drains either way.

| Profile | Implements | Answers `unsupported_verb` for |
|---|---|---|
| Full (Linux/Raspberry Pi FrameOS) | the whole table | — |
| ESP32 (microcontroller firmware) | `set_scenes`, `set_current_scene`, `get_state`, `render`, `reboot`, `restart_runtime` (identical to `reboot`: on ESP32 the runtime *is* the firmware), `set_settings` (the `interval`/`name` subset only — any other allowlisted key refuses the whole verb with `setting_not_allowed`, so a provider should not enqueue them), `assets_list`, `asset_get` (both only while the SD card is mounted — otherwise an empty listing / `not_found`; `thumb` is ignored and the original bytes are returned), `image_get` (`image/bmp`) | `set_schedule`, `get_logs`, `get_metrics`, `notify_update_available`, `asset_put`, `asset_mkdir`, `asset_delete`, `asset_rename` |

The ESP32 profile is a subset because the firmware has no scheduler, no log
buffer and no metrics buffer to expose, and updates itself from its own
configured archive. A provider should degrade gracefully — hide or disable
those controls for a frame whose `hardware.platform` is `esp32`, rather than
enqueueing commands that will come back refused. Logs still flow: `get_logs`
stays unsupported (nothing buffered to replay), but the firmware pushes
`log_batch` messages while the session is live and `telemetry:logs` is in
the ready scopes — a tick coalescer only (up to one batch per second, ≤60
lines), nothing retained across disconnects, and error acks are ignored.

### Frame → provider messages

| Type | Payload | Notes |
|---|---|---|
| `state` | `hello`-shaped | sent on scene change / significant events |
| `log_batch` | `{"logs": [{"timestamp", "scene"?, "payload"}…]}` | only with `telemetry:logs`; batched (device: ≤2 s / ≤100 lines); provider stores with a hard per-frame retention cap and counts retained bytes toward the account's storage usage |
| `metrics` | `{"metrics": {…}}` | only with `telemetry:metrics` |
| `scene_ack` | `{"checksum", "active_scene"}` | after a successful `set_scenes`, drives provider-side sync state |
| `assets` | `{"id", "assets": […], "truncated"?}` | reply to `assets_list`; the provider caches the latest listing per frame (the reference provider rejects listings over **256 KiB** of JSON rather than truncating them) |
| `asset_chunk` | `{"id", "seq", "data", "done", …}` | reply stream to `asset_get`; the provider reassembles in order, bounds the total at its per-file cap, and discards the partial file on a chunk carrying `"error"` or on disconnect |

A provider must tolerate unknown frame→provider types (forward compatibility).

A provider acks `log_batch` and `metrics` with `ok: false` and `rate_limited`
when the frame exceeds its ingestion budget, or `payload_too_large` when a
message is over the size the provider retains. Neither is fatal: the device
should drop the batch and keep going rather than reconnect.

### Message size and delivery guarantees

Both ends cap inbound message size and close the socket rather than allocate
past it. The reference provider caps frames at **4 MiB**; a device may cap
lower and refuse with `message_too_large` (the ESP32 profile caps at 512 KiB,
tied to its scene store) — so a provider must be prepared for a `set_scenes`
push to be refused on size by a small device, and should bound the payloads it
enqueues accordingly rather than relying on the device to absorb them. A
provider that must shed a slow consumer closes with WebSocket code **1013**
(try again later); the device treats that as an ordinary disconnect and
redials on its normal backoff.

Command delivery is **at-least-once**. A command written to a socket that dies
before its ack stays queued and is redelivered on the next session, so a
device may see the same `id` twice: every verb is idempotent, and a device
should ack a repeat exactly as it acked the original. Action verbs carry a TTL
and are expired rather than redelivered once it passes.

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
device=waveshare.EPD_13in3e   # optional display driver (frame.json device key)
width=1600             # optional, with device
height=1200            # optional, with device
rotate=90              # optional: 0/90/180/270
vcom=-1.48             # optional (IT8951-style panels)
upload_url=https://…   # optional; required by device=http.upload
```

Parsing is deliberately forgiving: `KEY=value` lines, `#` comments, blank
lines, CRLF endings, and whitespace around keys/values are all tolerated;
unknown keys are ignored (when recognized keys are also present).
`cloud_url` may be omitted and defaults to `https://cloud.frameos.net`. On
minimal (busybox-only) images the first-boot handler strips double quotes,
backslashes, and control characters from values, so avoid them in `name` and
WiFi credentials. A file whose `KEY=value` lines are *all* unrecognized (a
typo'd manual edit) is kept in place with a loud warning and no enrollment:
`/boot` is mounted root-only (`umask=077`) so nothing leaks, and shredding
would destroy the user's only copy of what they typed instead of letting
them fix the key names and reboot.

The display keys work because release images ship *every* compiled display
driver as a shared library — selecting one is a `frame.json` edit, not a
rebuild. When `device` is present, first boot patches `frame.json`
(`device`, `width`, `height`, `rotate`, `deviceConfig.vcom`,
`deviceConfig.uploadUrl`) and runs `frameos driver-setup
--reboot-if-required` after the shred (driver setup may edit
`/boot/config.txt` and reboot, and a reboot must not replay
personalization). Invalid numbers refuse the whole display patch — the
frame boots with its previous display config and the setup portal remains
the fallback. Images from releases before these keys existed log
"Ignoring unknown key" and enroll normally, so providers may always write
them.

**Placeholder + in-browser personalization.** Release images ship the file
pre-created as an all-comments placeholder of exactly **4096 bytes**, first
line `# FRAMEOS-CLOUD-CONFIG-V1`, padded with lines of 79 `#` characters
plus a final partial `#` run with no trailing newline (the comments double
as editing instructions; canonical bytes come from
`app.tasks.setup_json_reset.render_cloud_config_placeholder`). A file with
no recognized keys is ignored on boot — the image stays generic and the
file stays editable. Image composition copies the placeholder onto the
freshly built BOOT FAT before any other write, so its clusters are
contiguous and the 4096-byte region can be rewritten in the raw image
without touching FAT metadata. The provider's
"Download SD image" flow personalizes **client-side**: the browser streams
the generic `.img.gz`, decompresses it, locates the magic line within the
boot-partition region, verifies the 4096-byte placeholder, overwrites the
region in place with the real `KEY=value` content (same magic line, padded
back to 4096 bytes — same length, so no FAT metadata changes and no
rebuild), then re-gzips so what lands on disk is a `.img.gz` the flashing
tools read directly. WiFi credentials therefore never leave the browser. If
verification fails the build is refused rather than producing a card that
would silently fail to enroll.

The image bytes must come from the provider's own origin: GitHub's release
download issues a cross-origin redirect carrying no
`access-control-allow-origin`, so a browser cannot fetch release assets
directly. Providers serve a session-gated streaming pass-through
(cloud.frameos.net: `GET /api/frames/sd-image?platform=…`) that pipes the
public release asset through without buffering it. Personalization stays in
the browser, so no user data passes through it.

**The self-hosted sibling: `/boot/frameos-setup.bin`.** Release images also
ship a second, larger placeholder — **8 MiB**, first line
`# FRAMEOS-SETUP-BLOB-V1`, canonical bytes from
`app.tasks.setup_json_reset.render_setup_blob_placeholder` — for
personalization by a self-hosted FrameOS backend, whose payload (the full
`frameos-setup.json` with frame config and scenes, plus the
hostname/WiFi/SSH-keys/root-password boot files) cannot fit 4096 bytes. A
personalized region is `size=<bytes>` on line 2 followed by a gzipped POSIX
tar of the allow-listed `/boot/frameos-*` files, padded with `#` to the
fixed size; the first-boot script unpacks it with busybox `gunzip | tar`,
installs the members, shreds the blob, and runs the normal first-boot
handlers (display/boot config comes from `frameos setup` itself, so no
partition surgery is needed anywhere). The backend patches the region
in place in the raw image (`app.tasks.sd_image_blob_patch`) exactly like
the browser patches the cloud region — same magic-scan, same pristine-region
verification, same fixed-size overwrite — which means SD personalization
for backend-managed frames needs no mtools, debugfs, docker or build host
when the frame runs a precompiled FrameOS with interpreted scenes. While
the second line is a comment the region is inert and the image generic.

**Multi-use claim tokens.** A provider may mint claim tokens with a use
budget (`max_uses` > 1) so one personalized image can be flashed to many
cards: each boot enrolls a distinct frame (every device generates its own
keypair) and each appears individually as pending. The token dies when its
budget is spent or it expires, whichever comes first.

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

### Install script (existing OS)

For a device that already runs a supported Linux (Raspberry Pi OS on any Pi,
Debian, Ubuntu — the standalone installer's target matrix), the provider
serves the standalone setup script at `{provider}/install.sh` (the same
`scripts/frameos-setup.sh` published as `frameos.net/setup.sh`) and the "Add
frame" panel shows a one-liner:

```sh
curl -fsSL {provider}/install.sh | \
  sudo FRAMEOS_CLOUD_URL={provider} FRAMEOS_CLAIM_TOKEN=FRCT_… sh
```

The script installs the prebuilt release binaries and services as usual,
then writes the same `state/cloud_enroll_pending.json` handoff (mode `0600`,
dir `0700`) the SD-image flow uses, so the frame enrolls via flow A on first
start and appears as pending. Setting a claim token forces the backend
connection off and refuses an explicit `FRAMEOS_BACKEND_ENABLED=true` — one
control plane at a time. Display questions stay interactive (the script
keeps its prompts); every prompt can be pre-answered with the script's
`FRAMEOS_*` environment variables for unattended installs.

### ESP32 browser flashing

The provider's flasher page uses WebSerial + esptool-js to write a prebuilt
firmware image, then provisions `cloud_url` + `claim_token` (+ optional
WiFi) into the device's NVS config partition. The port must be the chip's
built-in USB-Serial/JTAG device ("USB JTAG/serial debug unit"): the console
REPL only exists there (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG`), and boards
that also expose an on-board USB-UART bridge (PhotoPainter 13.3", CH343 →
"USB Single Serial") can flash through the bridge but never provision, so
the flasher refuses known bridge vendor ids before writing anything. Same enrollment flow A over the
device's own network connection afterwards. The firmware binaries come from
the release archive; the flasher never receives per-user builds.

**"Generic" means credential- and panel-generic.** A published image carries
no user, account or WiFi data, and it compiles in every supported Waveshare
panel driver: the active panel is selected at runtime from the device's
config (`set panel <key>` over the serial console — the same allowlisted
channel the flasher already drives — or the setup portal dropdown, which
lists every compiled panel). The image is still built for one flash-size
profile, so the release archive publishes one artifact per (board, flash
profile) combination; the flasher page selects the flash profile and then
provisions the panel key over serial instead of picking a per-panel binary.
The generic image boots with `EPD_7in5_V2` as the default panel for backward
compatibility. Artifact file names are an implementation detail of the
release archive — read them from the release metadata rather than
constructing them. (Transitional: the generic binary is published as
`…-esp32-s3-generic.bin`, with an identical copy under the legacy
`…-esp32-s3-epd7in5v2.bin` name for one release cycle.) A second generic
image, `…-esp32-c3-generic.bin`, targets PSRAM-less ESP32-C3 boards
(TRMNL OG/BWRY, XTEINK X4): same panel set and provisioning surface, but
thin-client only — no on-device renderer. Backend-managed C3 frames pull
rendered bitmaps over the existing `/api/frames/{id}/embedded/render`
endpoint. Cloud-managed C3 frames can enroll, report state, and take
settings/logs verbs today, but scene rendering needs a cloud-side render
source (a push-image verb or server-rendered pulls) — not yet implemented;
until then a C3 frame linked to the cloud shows its provisioning/status
screen only.

Concretely, the firmware exposes these as allowlisted keys on the
existing USB serial console (`set cloud_url …`, `set claim_token …`,
`wifi <ssid> [pass]`), the same machine-readable channel the browser-based
frame admin already drives — so the flasher provisions over serial after
flashing instead of patching the NVS partition image. The claim token is
write-only: no console, status, or HTTP surface ever echoes it (or the
device key / access token) back. Enrollment state is surfaced as
`cloud: none|pending|enrolled|error` in `status` and in the `/status` JSON.
The ESP32 `hardware` object sends the chip as `platform` (`"esp32-s3"` or
`"esp32-c3"`; older firmware sent the plain `"esp32"`, and consumers
prefix-match) with the panel driver name as both `device` and `panel`, plus
`width`/`height`; a permanent
enrollment rejection (HTTP 400) erases the claim token on-device and shows
`error` until a fresh token is provisioned. `set cloud_url` refuses a
provider URL that would carry the claim token in the clear (see "The
management WebSocket").

The ESP32 firmware implements the **ESP32 profile** of the verb table, not
the full one — see "Device profiles" above for exactly which verbs it
implements and which it answers `unsupported_verb`.

**Secrets at rest on ESP32.** Unlike the Pi flows, which keep their link
state in `0600` files on a filesystem with real ownership, an ESP32 has no
users and no file permissions. The device key seed (NVS blob `cloud_sk`), the
bearer access token (`cloud_token`), the claim token before it is spent, and
the WiFi PSK all live in the NVS partition in **plaintext** unless the board
is provisioned with **ESP-IDF flash encryption**. The firmware's own
discipline is real but bounded: those values are never printed, never echoed
by the console, `status`, or the HTTP API, and are erased on demotion or
`factory-reset` — but anyone with physical access and a flash reader can dump
an unencrypted NVS partition and walk away with the device's identity and the
owner's WiFi password. Treat physical possession of an unencrypted ESP32
frame as possession of its cloud link, and enable flash encryption (plus
secure boot, if the deployment warrants it) for anything installed where that
matters. Revoking the frame in the owner's account is what invalidates a
stolen token; the provider rejects the next connection and the device demotes
itself.

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
self-hosted backend (`serverHost`) — one control plane at a time. Loopback
values (`localhost`, `127.0.0.1`, `::1`) do not count as a backend: they are
placeholders left by generic images and never a reachable control plane, so
they must not block enrollment.

While managed:

- the local admin page stays fully functional (it is the escape hatch and the
  local-presence surface), and shows a "managed by {provider}" banner;
- a persistent `401 invalid_link_token` on the WS or HTTP APIs — the device
  demotes after 3 consecutive authentication rejections — resets the link,
  returns the frame to standalone, and keeps rendering the last pushed
  scenes. Both WS rejection signals count: an HTTP `401` on the upgrade and a
  `4401` close of an established socket. The streak resets when a session
  reaches `ready`. Demotion discards the access token, `frame_id` and
  `ws_path`, and keeps the device key — a revoked frame still needs a fresh
  claim token to re-enroll — and it never touches local admin access, so a
  provider (or an attacker who reached one) can never lock an owner out of
  their own device. On ESP32 the same rule drops the NVS `cloud_token` /
  `cloud_fid` / `cloud_ws` keys and keeps `cloud_sk`;
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
