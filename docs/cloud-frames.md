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
    "board": "raspberry-pi-5 | raspberry-pi-64 | raspberry-pi-32",
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

The frame stores its access token in a `0600` state file. Whether it needs a
confirmation click depends on whether it is the token's first enrollment:

- **The first enrollment of a token is born active.** Minting the token was
  the owner's deliberate, authenticated act, and the overwhelmingly common
  first redeemer is the owner's own board booting minutes later — asking the
  owner to confirm their own two-minute-old token again is ceremony without
  proof. (SD images mint multi-use tokens so a card can be reflashed, which
  is why the rule keys on first use, not on a single-use budget.) If a
  stolen token or leaked image beats the owner's board to it, the owner's
  own card lands pending behind a foreign active frame — loud, auditable,
  revocable. Provisioning scene intent (`scene_source_frame_id`) is applied
  right at enrollment.
- **Every later enrollment of a multi-use token appears as pending** and the
  owner confirms it (a deliberate click, showing hardware details) before
  any scene push is accepted — any card holding a fleet image can enroll, so
  each additional board brings its own proof.

Re-enrolling a revoked frame needs a fresh claim token.

### A2. Re-enrollment (a claim token bound to an existing frame)

A board that loses its settings — a factory reset, a full `0x0` flash, or a
move to a different account's frame — comes back with a brand new device
keypair and no link token. Enrolling it normally would create a SECOND frame
row for one physical device, orphaning the original's scenes, assets and logs
while it still counts against the frame quota. So the owner mints a token
*bound to the frame they already have*:

```http
POST {provider}/api/frames/claim-tokens
{"frame_id": "…a frame this account owns…"}
```

The response is an ordinary claim token plus the `frame_id` echoed back, and
the binding forces `max_uses: 1` and a short expiry (cloud.frameos.net: 1 h)
regardless of what was asked for — redeeming one hands a device the identity
of an existing frame, which is worth more than an ordinary code. Minting is
refused for a frame the session account does not own (`404 invalid_frame`), a
revoked one (`409 frame_revoked`), or any `multi_use`/`max_uses > 1`
(`400 invalid_max_uses`). Frame quota is NOT checked: no frame is created, so
an account at its limit must still be able to rescue a board.

Redemption goes through the same `POST /api/frames/enroll` with the same body
and returns the same shape, but re-keys instead of inserting:

- `frames.public_key` becomes the key the device just presented, and the
  link's token is rotated with **no grace window** (the previous credential
  is being replaced, so it dies immediately);
- `frames.id`, the frame's name, scenes, assets, logs, schedule, settings and
  status are untouched, as are the link's SCOPES — re-enrolling re-keys a
  device, it does not re-approve anything, so a `settings:services` the owner
  revoked stays revoked and the response's `scope` is the link's current list;
- a socket still held by the device that used to own the row is closed with
  `4401`: the hub compares the frame's public key against the one its session
  authenticated with.

Errors: `400 invalid_claim_token` if the token expired, the frame is gone or
revoked, or the budget is spent. Retrying with the *same* device key is
idempotent (a lost response gets a fresh access token); the same spent token
presented with any other key is refused.

Bound tokens are what the workspace's "Re-enroll over USB" control uses:
the browser flasher mints one for the frame on screen, provisions it over
serial, and reports success against that same row — no new-frame watch, no
confirmation step.

### A3. Provisioning-time scene intent

"Start it with the scenes from *that* frame", chosen while building the SD
image or flashing the board. A frame that boots into an empty workspace is
the thing this removes — most people adding a second Pi want what the first
one is already showing.

```http
POST {provider}/api/frames/claim-tokens
{"multi_use": true, "scene_source_frame_id": "…a frame this account owns…"}
```

Ownership is checked at MINT time, by the same lookup that guards
re-enrollment (`404 invalid_scene_source_frame` otherwise) — enrollment
itself is unauthenticated, so it must never be the step that decides whose
scenes travel.

The intent then makes two hops, and needs a column for each. It rides the
token, because the browser that built the image is long gone by the time the
card is flashed; and it is copied onto every frame that token enrolls,
because a multi-use card enrolls many and the token's own `frame_id` records
only the last one.

Nothing reaches the device until the owner CONFIRMS the frame. At that point
the copy runs through exactly the gates a workspace deploy runs through
(accessibility, pinned version, shell-risk refusal) and enqueues the ordinary
`set_scenes` push, so the scenes land on the board's first connection. The
intent is then cleared — it fires once and never fights the owner's own later
edits. A source frame deleted in the meantime simply means there is nothing
left to copy.

### B. Link code on the device (RFC 8628)

The device-authorization flow from `docs/cloud-link.md`, initiated from the
setup portal, the local admin page, or the panel itself, with
`client_kind: "frame"` and `scopes: ["frame:managed"]`. The consent screen is
the ownership proof, so a frame enrolled this way is born `active`, not
`pending`. After approval the device calls `/api/frames/enroll` with
`{"public_key": …, "hardware": …}` and the device-flow Bearer token instead
of a claim token, to register its key and fetch `frame_id`/`ws_path`.

**The code shows on the panel.** While a flow is pending, the runner draws
the user code plus a QR of `verification_uri_complete` over whatever the
frame is showing (`frameos/cloud/device_flow.nim` `activeLinkCode()`, drawn
in `runner.nim` beside the local-presence overlay), so the person in front
of the frame can claim it without ever opening the local admin page — the
same possession ceremony as the LAN-access code, in the other direction.
The hub thread polls the flow in the background (`deviceFlowTick`), so a
link started from the admin page completes even after the browser tab
closes, and the code comes down the moment the flow resolves or its window
lapses.

**Starting one without a browser.** The setup portal's cloud option no
longer requires a claim code: saved without one, it queues
`state/cloud_link_code_pending.json`, and once the frame is online the hub
thread starts the device flow and the panel shows the code. An unclaimed
window restarts a fresh code (each start is a provider round trip; after 12
unclaimed starts the frame gives up until the next boot or admin-page
retry). Picking another control mode in the portal, or `POST
/api/cloud/disconnect`, retires the queue.

### Scopes

`frame:managed` is the base scope: connect the WS, receive scene/settings
pushes, report state. Telemetry is opt-in per scope, exactly as reserved in
`docs/cloud-link.md`:

| Scope | Allows the provider to |
|---|---|
| `frame:managed` | manage this frame (scenes, declarative settings, state) |
| `settings:services` | serve this frame the account's service API keys (see "Service settings") |
| `telemetry:logs` | receive and retain device logs |
| `telemetry:metrics` | receive and retain device metrics |

Scope changes use the existing `/api/backends/scopes` mechanism (additions
need owner approval on the provider's device screen; removals are immediate).
A claim-token enrollment grants all four up front (since 2026-08-03); links
made before that carry `frame:managed` only and are **never backfilled** —
adding a scope the owner did not approve is the silent escalation the flow
refuses. The owner instead flips two per-frame switches in the frame's
Settings panel (`service-settings/enabled`, `telemetry/enabled` below), which
grant or remove the scope on the link itself. Scopes are read once per
WebSocket session, so the telemetry switch also queues a `restart_runtime`
for an active frame; until the device reconnects, a frame without
`telemetry:logs` shows an empty Logs panel that names the switch.

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

The hello's `hardware` object is the same shape enrollment sends; a provider
should persist it on each successful session start so its copy tracks the
device (cloud.frameos.net does, size-capped at the same 4 KiB the enroll
route applies). Without that refresh the enrollment-time snapshot goes stale
the first time the panel or firmware changes.

`platform` is frame.json's deployment MODE (`buildroot`, `rpios`, `esp32-s3`,
…), never a board. Linux frames additionally send **`board`** — the Buildroot
platform key of the hardware they detected themselves to be, i.e. which SD
image they run — so a provider can offer "write another card for this frame"
without asking. It is derived from `/proc/device-tree/compatible`, and it is
omitted rather than guessed on boards FrameOS publishes no image for.

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
| `set_schedule` | `{"schedule": {…}, "utcOffsetMinutes"?: N}` | replace the scene schedule (`{"events": [{"id", "minute": 0-59, "hour": 0-23, "weekday": 0 daily/1-7 mon-sun/8 weekdays/9 weekends, "event", "payload"}…]}`); the provider resolves `disabled` flags before pushing — devices fire every event they are given. An entry's `event` is fired onto the device's own event queue, so the schedule is also the cloud-safe **automatic reboot**: `setCurrentScene` (`payload: {sceneId, state?}`), `restart` (`payload: {}` — the runtime exits and init relaunches it) and `reboot` (`payload: {}` — the device's privileged reboot, the same one the `reboot` verb runs; on the ESP32 both are `esp_restart()`). Firmware before **2026.8.32** hands an unknown event to the scene as a silent no-op rather than refusing the push, so the provider's panel gates the two maintenance entries on the reported version (disabled with a reason, never hidden). The optional `utcOffsetMinutes` is the provider's current frame-local UTC offset, for devices that match in local wall-clock time without a tz database; a device without that need (or one that takes its offset from a backend settings poll, as the ESP32 firmware does today) ignores the key |
| `set_settings` | `{"settings": {…}}` | allowlisted declarative keys only. **Base six** (every managed frame): `name`, `rotate`, `interval`, `scaling_mode`, `timezone`, `debug`. **Extended batch** (Linux runtime from **2026.8.30**, gate on the frame's reported `frameos_version` — older firmware refuses the whole verb on the first of these it sees): `flip` (`""`/`horizontal`/`vertical`/`both`), `error_behavior` (`{mode, retry_seconds, silent_retry_seconds, silent_retry_forever, silent_window_minutes, show_error_retry_seconds}` — the frontend/backend spelling), `control_code` (the runtime's shape: `{enabled: bool, position, size, padding, offsetX, offsetY, qrCodeColor: "#rrggbb", backgroundColor}`), `metrics_interval` (seconds; `0` disables the sampler, applied live), `max_http_response_bytes` (64 KiB … 64 MiB — a provider can lower a device's per-request bound, never raise it past the runtime default), `save_assets` (`bool`, or `{appKeyword: bool}`), `timezone_updater` (`{enabled, hour}` only — the download URL is never accepted from a provider; the device carries its own URL across the write). **Hardware batch** (Linux runtime from **2026.8.31**, gated the same way; the display driver reads all three at init, so the device RESTARTS its runtime after persisting them instead of reloading — a few seconds of blank panel): `palette` (the SPA's shape, `{colors: ["#rrggbb", …] (0–16), name?, colorNames?}`; an empty list hands the panel back its built-in palette), `device_config` (STRICTLY `{partial, partialMaxAreaPercent, partialMaxRefreshesBeforeFull}` — the device PATCHES its deviceConfig with what is sent and refuses any other sub-key; VCOM, pins, upload URL/headers, SD-card and render-mode wiring never move), `gpio_buttons` (`[{pin 0–48, label 1–32 chars}]`, ≤16, the whole list replaced, duplicate pins refused; `[]` unbinds every button). Which of the three apply to a frame depends on the panel it reported (`hardware.device`): the SPA renders only the applicable fields, the device silently ignores an inapplicable one. **ESP32-only** power keys `deep_sleep`, `deep_sleep_on_battery`, `wake_check_seconds`, `battery_pin`, `battery_divider`, and from firmware **2026.8.39** `battery_enable_pin` (the GPIO that switches the battery divider on for a reading, `-1` = always on; gate on the reported version like the other late keys). `brightness` joins the list once the runtime grows a brightness setting. Unknown or non-allowlisted keys → the whole verb is refused (`error: "setting_not_allowed"`); a value that fails the device's shape check (an unknown sub-key, a colour that is not `#rrggbb`, an out-of-range number) → the whole verb is refused (`error: "invalid_settings"`) — the device validates every value itself, the provider's validation is UX |
| `refresh_service_settings` | `{}` | advisory nudge: "your service settings changed, re-fetch them". The payload is **always empty** — API keys never ride the command queue (see "Service settings"). Ack on *accepting* the nudge, not on completing the fetch: the fetch is HTTP, on the device's own schedule, and a failed fetch must not look like a refused verb. Requires `settings:services`; a device without it acks `ok: false` with `insufficient_scope` |
| `set_current_scene` | `{"scene_id": "…", "state"?: {…}}` | switch active scene; the optional `state` object carries public scene-state field values, forwarded to the scene exactly as the local `setCurrentScene` event would. `scene_id` is the **public** scene id — the full/Pi runtime registers cloud-pushed scenes as `uploaded/<id>` internally and resolves the public id to that registration itself (the ESP32 firmware stores scenes by public id, so both profiles accept the same id) |
| `get_state` | `{}` | bare ack, then a separate `{"id", "type": "state", …}` message with the same `id` carrying the `hello`-shaped state |
| `get_logs` | `{"since"?: iso-ts, "limit"?: N}` | bare ack, then a `log_batch` message with the same `id` carrying the buffered lines (requires `telemetry:logs`; device caps `limit` at 1000) |
| `get_metrics` | `{}` | bare ack, then a `metrics` message with the same `id` carrying the buffered samples (requires `telemetry:metrics`) |
| `render` | `{}` | trigger a re-render |
| `reboot` | `{}` | reboot the device |
| `restart_runtime` | `{}` | restart the FrameOS process |
| `notify_update_available` | `{"version"?: "…"}` | nudge the device to update itself — the provider supplies no URLs and no binaries (today's provider sends a bare `{"id","type"}` frame; a `version`, if present, is logged and otherwise ignored). The full profile answers by running its own signed release upgrade (`frameos/upgrade.nim`: fetch the latest published release for its target, verify the minisign signature on-device, stage, restart — a nudge while an upgrade is in flight, or on an up-to-date install, is a logged no-op, so at-least-once redelivery is safe); the ESP32 fetches the provider's signed OTA manifest (see the profile table) |
| `assets_list` | `{}` | bare ack, then a separate `{"id", "type": "assets", "assets": [{"path", "size", "mtime", "is_dir"?}…], "truncated"?: true}` message with the same `id`. Paths are **relative to the device's assets directory** (`assets_path`, default `/srv/assets`) — never absolute. A device may bound the listing (the reference cap is 5000 entries) and must then say so with `"truncated": true` rather than silently stopping |
| `image_get` | `{}` | the frame's current rendered image. Bare ack, then the same `asset_chunk` stream `asset_get` uses (same `id` correlation, same caps); the first chunk's `content_type` says what the device produces (the Linux runtime sends `image/png` of its last render, the ESP32 packs `image/bmp` from its framebuffer). `ok: false` ack with `no_image` when nothing has rendered yet, `busy` on a small device already streaming |
| `asset_get` | `{"path": "…", "thumb"?: true}` | read one file from the assets directory. Failure is an ordinary `ok: false` ack: `invalid_path` (traversal, absolute, or outside the assets directory), `not_found`, `is_directory`, `too_large` (the reference cap is **8 MiB** raw), `busy` (a small device already streaming another file). Success is a bare ack followed by one or more `{"id", "type": "asset_chunk", "seq": 0…N, "data": "<base64>", "done": bool}` messages with the same `id`, in order; the first chunk also carries `"size"` (total raw bytes), `"mtime"` and `"content_type"`. A read that fails after the ack ends the stream with `{"type": "asset_chunk", "id", "error": "…", "done": true}` and the provider discards the partial file. With `thumb`, a device that can generate thumbnails (Linux) returns a small preview — the reference implementation fits it inside 320×320 and encodes PNG, and says so in `content_type`, which is what a provider should trust; a device that cannot (ESP32) returns the original bytes |
| `asset_put` | `{"path": "…", "data": "<base64>"}` | store one file in the assets directory. The whole payload rides a single message, so the raw size is bounded well under the inbound frame cap (the reference device cap is **2.5 MiB** raw — `too_large` past it; bigger files ride `asset_put_chunk` below); the filename component is sanitized by the device exactly like a local admin upload, parent folders are created as needed, and an existing file at the path is replaced. Errors: `invalid_path` (traversal, absolute, outside the assets directory, or a dot-directory — see below), `invalid_data` (empty or undecodable base64), `too_large`, `write_failed`. The ack carries `"asset": {"path" (relative, as stored), "size", "mtime", "is_dir"}` |
| `asset_put_chunk` | `{"upload_id": "…", "offset": N, "data": "<base64>", "complete"?: true, "path"?: "…"}` | store one file that does not fit a single `asset_put`, as offset-addressed chunks under one `upload_id` (`[A-Za-z0-9_-]{1,64}` — it becomes a filename component on the device). The provider sends one chunk, waits for its ack, sends the next; the last one carries `complete: true` and the destination `path` (sanitized like `asset_put`, dot-directories refused). Offsets make redelivery idempotent — hub delivery is at-least-once, and a chunk that arrives twice overwrites itself instead of appending. `offset: 0` starts (or restarts) the part; an offset past what has landed means an earlier chunk was lost and is refused with **`chunk_gap`** — the provider restarts the file from 0 under a fresh id. The part lives outside the assets directory (Linux: the admin upload temp root; ESP32: `.uploads/` on the card) until the final chunk moves it into place, so a half-uploaded file is never listable or renderable; parts nobody finishes are swept on the next session start (Linux, after 6 h) or at card mount (ESP32). Per-chunk raw cap: what one inbound frame carries (the reference Linux runtime takes up to `HubMaxAssetUploadBytes` = 2.5 MiB, an ESP32 ≈ 256 KiB); assembled-file cap **64 MiB** (`too_large`). Non-final acks carry `"received": <part bytes so far>`; the final ack carries `"asset"` exactly like `asset_put`. Errors: `invalid_upload_id`, `invalid_offset`, `invalid_data`, `invalid_path`, `chunk_gap`, `too_large`, `write_failed`. Firmware from before 2026.8.30 answers `unknown_verb`; a provider then knows only single-frame files fit and says so |
| `asset_mkdir` | `{"path": "…"}` | create a folder (and parents) in the assets directory. Errors: `invalid_path`, `write_failed` |
| `asset_delete` | `{"path": "…"}` | delete a file or folder (recursively) in the assets directory. Errors: `invalid_path`, `not_found`, `write_failed` |
| `asset_rename` | `{"src": "…", "dst": "…"}` | rename/move a file or folder within the assets directory (the destination's parent folders are created). Errors: `invalid_path`, `not_found`, `write_failed` |

Explicitly absent, by design (see `cloud/docs/cloud-frames.md`): shell/exec,
PTY, arbitrary file read/write, SSH anything, network/WiFi config, admin
credentials, update URLs, agent/profile state, compiled scene deploys. The
asset verbs are deliberately not a file API: they are confined to the assets
directory (the same user-content directory the local admin's Assets panel
serves), and the device — not the provider — resolves and bounds every path.
Additionally, the write verbs (`asset_put`/`asset_put_chunk`/`asset_mkdir`/
`asset_delete`/`asset_rename`) refuse any path containing a dot-component: dot-directories
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

**What never becomes a setting.** Everything a provider can change is in the
table above; the rest of `frame.json` is the device's, whatever else moves
later: deployment mode, panel/driver/VCOM/dimensions, flash and GPIO wiring,
SD-card wiring, Wi-Fi/hotspot credentials, private-network elevation, frame
HTTP/admin/TLS access and keys, SSH/backend/agent configuration, mountpoints,
HTTP-upload URLs and headers, arbitrary update URLs (the tz-updater URL
included — the device carries its own across a push), and service API secrets.
Raw `assets_path` and `log_to_file` paths are not exposed either; if they are
ever wanted remotely they get redesigned as bounded toggles on fixed
FrameOS-owned directories. Hardware identity reported by the frame stays
authoritative. Adding a key is always the same four-list change (device
allowlist + validator in `hub_client.nim`, the auth-web validator and version
floor, `frontend/src/utils/cloudFrameSettings.ts`, this table) — and because
the device refuses the WHOLE push on a key it does not recognise, nothing new
goes out before the frames understand it.

| Profile | Implements | Answers `unsupported_verb` for |
|---|---|---|
| Full (Linux/Raspberry Pi FrameOS) | the whole table | — |
| ESP32 (microcontroller firmware) | `set_scenes`, `set_current_scene`, `get_state`, `render`, `reboot`, `restart_runtime` (identical to `reboot`: on ESP32 the runtime *is* the firmware), `set_settings` (the `interval`/`name`/`rotate`/`scaling_mode` subset plus the power keys `deep_sleep`, `deep_sleep_on_battery`, `wake_check_seconds` (all picked up on the next render pass) and `battery_pin`/`battery_divider` (acked, then deferred-rebooted — the ADC is set up once at boot; from firmware **2026.8.39** also `battery_enable_pin`, the divider's enable GPIO, same deferred reboot, gated on the reported version), and from firmware **2026.8.31** `debug` (debug_logging, pushed into the Nim runtime on the next render pass), `max_http_response_bytes` (1 KiB … 64 MiB; handed to the runtime at init → deferred reboot) and `gpio_buttons` (the Pi shape, ≤ FOS_GPIO_BUTTONS_MAX = 8 entries, labels without `:`/newline; `fos_buttons_init` runs at boot → deferred reboot) — a provider gates those three on the reported version, and any other allowlisted key refuses the whole verb with `setting_not_allowed`, so a provider should not enqueue them; `rotate` is normalized to 0/90/180/270 and, when it actually changes, acked first and then rebooted, because the renderer sizes its canvas once at init; `scaling_mode` is normalized to contain/cover/stretch/center and applied live on the next render pass — it is the fallback fit for image consumers without their own placement, so no reboot. from firmware **2026.8.34** `timezone` (an IANA name) plus `timezone_data` (that zone's **tzdata slice**: its transitions from last year to ten years out in the full tzdata.json's `{timezones, dstChanges}` shape, ~1.5 KB — the chip carries no tz database, so the slice is the zone. The device keeps it at `/state/tz.json`, loads it into the Nim runtime's chrono (exact conversions for scenes and apps) and installs the POSIX TZ rule chrono derives from it with `setenv("TZ")`, so libc `localtime`, QuickJS `Date` and the on-device schedule all follow, DST included; applied live, gated on the reported version like the 2026.8.31 keys. The provider fetches the slice from `https://tz.frameos.net/zone/<Zone>.json` (published by the `../tz` generator; the self-hosted backend cuts it from its own tzdata) and sends it in the command payload only — it is never stored as a frame setting. A `timezone` without `timezone_data` is still accepted: the device fetches the same URL once on its next online render pass. `timezone_data` on its own is refused. Before 2026.8.34 the device's only timezone concept was the `utcOffsetMinutes` that rides along with `set_schedule`, which firmware with a zone installed now ignores in favour of the zone), `assets_list`, `asset_get`, `asset_put`, `asset_put_chunk` (parts under `.uploads/` on the card, 256 KiB raw per chunk), `asset_mkdir`, `asset_delete`, `asset_rename` (all seven only while the SD card is mounted — otherwise an empty listing / `not_found`; `thumb` is ignored and the original bytes are returned; write acks are sent after the SD write finishes, from the same job queue the reads use), `image_get` (`image/bmp`), `get_logs` (replays the on-device ring of the last 128 lines), `get_metrics` (newest sample; the device also pushes a `metrics` message after every render pass when `telemetry:metrics` is granted), `set_schedule` (evaluated on-device once per wall-clock minute; matching uses the installed time zone (2026.8.34+, `timezone` setting) or, without one, UTC plus a provider/backend-supplied `utcOffsetMinutes`; `setCurrentScene`, `render`, and from firmware **2026.8.32** `restart`/`reboot` — both `esp_restart()` after flushing the log — are handled by the firmware, anything else is handed to the Nim runtime), `refresh_service_settings` (the firmware's
settings poll fetches the six groups itself — from the provider on a cloud-only
frame, from the FrameOS backend's `/embedded/settings` payload when one is
configured, in which case the nudge is refused `backend_managed` because the
provider is not that frame's settings source; the copy lives in RAM and is
re-pulled every boot), `notify_update_available` (signed cloud OTA: manifest + download from the provider, minisign Ed25519 over BLAKE2b-512 verified against the baked key before the boot slot switches) | — |

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
| `sleep` | `{"wake_in_seconds", "next_render_at"?, "reason", "wake_check"}` | ESP32 (firmware **2026.8.41**+), sent synchronously right before `esp_deep_sleep` halts the CPU: back (and redialing) in `wake_in_seconds`; `next_render_at` is the unix time of the next panel refresh (omitted without a synced clock; later than the wake when the wake is only a `wake_check_seconds` command check-in, `wake_check: true`); `reason` is `battery` / `always` / `battery_critical`. The forecast is an upper bound: a press on a registered GPIO button wakes the frame early (firmware **2026.8.42**+), and the reconnect clears it like any other. The provider stores the forecast (`next_wake_at` / `next_render_at` / `sleep_reason` on the frame row, cleared again on the next connect), **terminates the socket itself** — a halted chip sends no close frame, and waiting for the heartbeat to notice would keep the frame "connected" for up to a minute after it went dark — and records the disconnect as `asleep`. The SPA shows "asleep · wakes in 5 min" (and "overdue" when the wake never comes) instead of "last seen just now"; for firmware without the message it estimates the wake from the pushed power settings. The ESP32 metrics sample carries `onBattery` (the firmware's own cell-present test) for that estimate |
| `scene_ack` | `{"checksum", "active_scene"}` | after a successful `set_scenes`, drives provider-side sync state. When the acked checksum matches the provider's current assigned set, the provider also promotes its per-scene deploy ledger (`assigned_scene_state` → `deployed_scene_state` on the frame row) so the workspace can name WHICH scene is still pending on later edits |
| `assets` | `{"id", "assets": […], "truncated"?}` | reply to `assets_list`; the provider caches the latest listing per frame (the reference provider rejects listings over **256 KiB** of JSON rather than truncating them) |
| `asset_chunk` | `{"id", "seq", "data", "done", …}` | reply stream to `asset_get`; the provider reassembles in order, bounds the total at its per-file cap, and discards the partial file on a chunk carrying `"error"` or on disconnect |
| `render` | `{"active_scene": "…", "image"?: "image_get"}` | "I have written a fresh snapshot of this scene." Announcement only, never bytes — see Previews below. A provider that does not want it can ignore it entirely. `image: "image_get"` (ESP32 firmware **2026.8.43**+) says the device keeps no snapshot files — its image is its framebuffer — so a provider that wants the picture fetches it with `image_get` (into its current-image slot) rather than `asset_get` of a per-scene PNG |

A provider must tolerate unknown frame→provider types (forward compatibility).

### Previews

**The cloud never renders a frame's scenes, and never asks a device to take a
screenshot on demand.** Both were considered and refused: server-side
rendering means the provider holds every scene's data sources and API keys,
and an on-demand screenshot verb is a camera into someone's home that a stolen
account could point wherever it liked. The two things that *are* allowed are
narrower:

- **Before deploy**, a scene is previewed by running it in the browser, in
  the WebAssembly build of the FrameOS runtime. The data stays with whoever
  opened the page; the server renders nothing.
- **After deploy**, the provider may keep a copy of the snapshot the device
  already writes for itself. The runner saves a PNG per scene under
  `{assets}/.frameos/scene_images/` on every scene switch and whenever the
  one on disk is over a minute old, because the on-device admin uses it too.
  Nothing new is rendered for the cloud's benefit.

The `render` message is what makes the second one timely without making it
expensive. The device announces the write; the provider decides whether to
spend the frame's uplink on fetching it, and the reference provider fetches
only while somebody has that frame open in a browser (`preview_watched_at`,
stamped by the preview routes and by an attached browser socket, with a
three-minute window). A frame nobody is looking at costs one small JSON
message per snapshot write and nothing else — no polling, no scraping, and no
standing stream of images out of a home.

The fetch itself is the ordinary `asset_get` verb (or `image_get` when the
announcement says so), so a provider that ignores `render` entirely still
gets previews the moment a tile asks for one; it just gets them a render
late. Devices must not send `render` more than once per snapshot write, and
providers should cap the resulting fetches per frame regardless (the
reference hub allows four a minute).

Two things make this work for a frame that deep sleeps between renders. A
fetch queued while the frame is asleep must outlive the sleep: the reference
provider stretches the `image_get` / `asset_get` TTL past the frame's
announced `next_wake_at` (a two-minute TTL on a fifteen-minute sleeper
expired every time). And "someone is looking" has to span one sleep: the
frame renders exactly once per wake, so the reference hub adds the frame's
last announced `wake_in_seconds` to its three-minute watch window when that
frame's `render` arrives. On the device side, an `image_get` that lands at
`hello` — before the wake's render exists — waits for that render (up to
150 s) instead of answering `no_image`, and the deep sleep holds (up to 45 s)
while the stream is still going out.

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

### Queue observability

A queued command is an intention, not an event: a battery frame that sleeps
for hours takes the reboot, the render and the scene push on its next wake,
and until then "sent" and "applied" look identical from the account side. Two
endpoints make the difference visible.

`GET /api/frames/{id}/commands` returns what is still waiting, oldest first —
the same order the hub drains in:

```json
{"commands": [
  {"id": "…", "type": "reboot", "status": "pending",
   "created_at": "…", "expires_at": "…", "sent_at": null}
]}
```

`status` is `pending` (never written to a socket) or `sent` (written, not
acked — the hub redelivers those, so they are still waiting). Rows past their
TTL are filtered out rather than swept: reading the queue must not mutate it.
Payloads are deliberately NOT echoed — a `set_scenes` payload is a whole scene
bundle, and the only payload field worth reporting is `set_current_scene`'s
`scene_id`, a public store id the owner already sees.

`DELETE /api/frames/{id}/commands/{command_id}` cancels one while it is still
undelivered, moving it to the same terminal state a superseded command gets
(`expired`, with `cancelled` in `error`) rather than deleting the row. It
answers 404 when there is nothing to cancel — already delivered, already
expired, already cancelled — because a pretend success would have the UI claim
it stopped something the device had already run. Nothing can recall a command
the device already has; that is exactly why action verbs carry short TTLs.

The self-hosted backend implements the same two routes over the one action it
records instead of pushing immediately (a queued ESP32 OTA request); its
deploys, restarts and renders are immediate SSH/HTTP pushes with nothing
durable to observe. Same wire shape either way, so the workspace's "Waiting
for the frame" panel is one component (docs/api-triality.md).

## Service settings

Scenes need third-party credentials to render: an Unsplash access key, an
OpenAI API key, a Home Assistant URL and token. On a self-hosted frame these
come from the backend's settings table; on a cloud-managed frame they belong
to the **owner's provider account**, and the frame fetches them.

**They are fetched, never pushed.** The command queue is durable and is never
pruned, so a key that entered it would live in the provider's database — and
in every backup — long after the owner deleted it; it would pass through the
WebSocket hub; and at-least-once redelivery could hand a device a credential
that had already been revoked. So the socket carries only the zero-payload
`refresh_service_settings` nudge, and the keys travel over a device-authed
HTTPS request the device makes itself:

```http
GET {provider}/api/frames/{id}/service-settings
Authorization: Bearer <access_token>
If-None-Match: "<etag from the last fetch>"      # optional
```

Response `200`:

```json
{
  "settings": {
    "unsplash": { "accessKey": "…" },
    "homeAssistant": { "url": "https://ha.local", "accessToken": "…" }
  },
  "groups": ["homeAssistant", "immich", "unsplash"]
}
```

- `settings` — group → field → value, for every group that has a usable
  value. Deliverable groups and fields are exactly:
  `frameOS{apiKey}`, `github{api_key}`, `homeAssistant{url,accessToken}`,
  `immich{url,apiKey}`, `openAI{apiKey}`, `unsplash{accessKey}`. An empty
  string counts as "not configured" and is omitted.
- `groups` — every group the frame's **assigned scenes declare**, whether or
  not the owner has filled it in. A group in `groups` but not in `settings` is
  one the frame needs and the account has not set; the device may surface that
  ("this frame needs an Unsplash key") but must not invent a value for it.

**The six groups are cloud-owned on a managed frame.** A group absent from
`settings` is **deleted** on the device — not left at its previous value.
That is the whole point: revoking a key in the provider account, or removing
the last scene that used it, must actually take the key off the device.
Settings groups *outside* the six are untouched by this route and stay under
local control.

Both the response and a `304` carry `Cache-Control: no-store`: this body is
the account's credentials and no proxy, CDN or on-device HTTP cache may keep
a copy. The `ETag` is a hash of the canonical response body (keys sorted at
every level, so re-saving the same values in a different order does not
invalidate it); a device that sends a matching `If-None-Match` gets `304` with
no body and should keep what it has.

Errors:

| Status | `error` | Meaning |
|---|---|---|
| `401` | `invalid_link_token` | missing, unknown, revoked or expired bearer |
| `401` | `frame_not_enrolled` / `frame_revoked` | the token is valid but no live frame stands behind it |
| `403` | `frame_mismatch` | the bearer belongs to a different frame than the `{id}` in the path |
| `403` | `insufficient_scope` | the link does not hold `settings:services` (or not even `frame:managed`) |
| `409` | `frame_not_active` | the frame is still `pending` (owner has not confirmed it) |
| `429` | `rate_limited` | over the per-IP or per-frame budget |

`403 insufficient_scope` is the boundary that matters. Devices treat the
`ready` scope list as additive truth and never drop a scope from their local
copy, so an owner turning delivery off is enforced *here*, by the provider
refusing the fetch — a device that keeps asking simply keeps getting 403.
On that response a device should delete its local copy of all six groups, the
same way it treats a group absent from `settings`.

When to fetch: on every session that reaches `ready`, on a
`refresh_service_settings` nudge, and whenever the device's own logic decides
its copy may be stale. The nudge is advisory and expires quickly (reference
provider: 5 minutes), because a frame that was offline when the owner saved a
key re-fetches at `ready` anyway.

A device may keep its last fetched copy across reboots. The ESP32 firmware
(**2026.8.42**+) stores the six groups in NVS next to its bearer token and
applies them before the first render, so a deep-sleeping frame — whose only
render pass runs before its session's `ready` could ask for a fetch — renders
with its keys, and skips the fetch at `ready` while the copy is under the 6 h
interval (the nudge and the 403 still force one; a revocation, a demotion and a
factory reset delete the copy). The device logs `settings:services` with
`origin: "cache"` when it started from that copy.

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
root_password=…        # optional; sets the root password via chpasswd
time_zone=Europe/Brussels   # optional IANA zone; the builder writes the browser's
authorized_key=ssh-ed25519 AAAA… you@laptop   # optional, repeatable: root's SSH keys
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

`root_password` mirrors the self-hosted `/boot/frameos-root-password`
semantics: applied with `chpasswd` on first boot, and setting it also
re-enables dropbear password logins (`DROPBEAR_ARGS=""`). Without the key
the image keeps its build-time default — root with no password on the
console (physical access only), while SSH refuses password logins entirely
(`dropbear -s -g`, no authorized keys). The provider's SD-image builder
makes this an explicit choice: enter a root password, or tick a
"passwordless root" checkbox to accept the default. Like the WiFi
credentials, the password is written into the image in the browser and
never reaches the provider.

`authorized_key` (repeatable, one OpenSSH public key each) fills
`/root/.ssh/authorized_keys` on first boot — the cloud counterpart of the
self-hosted `/boot/frameos-authorized_keys` file. The provider's SD-image
builder offers the account's SSH keys (public halves only; the cloud never
stores a private key) with the "default on new frames" ones pre-selected,
and shows how much of the 4096-byte region the configuration uses — an
ed25519 key is ~100 bytes, an RSA-3072 key ~570. Images from releases before
this key existed log "Ignoring unknown key" and boot without the keys.

`name` and `time_zone` are the card's personalization and end up in
`frame.json`, not just in the enrollment request: first boot forwards
`time_zone` into `cloud_enroll_pending.json`, and once the claim token is
redeemed the runtime writes `name` / `timeZone` into `frame.json`, reloads,
and sets the system zone (`/etc/localtime`) so QuickJS `Date` agrees with the
scheduler. The name also becomes the hostname on first boot (slugified:
"Kitchen Frame (2nd floor)" → `kitchen-frame-2nd-floor.local`), so two cloud
cards on one network are not both `frame.local`. Without `time_zone` the
image stays on UTC; the provider's builder fills it from
`Intl.DateTimeFormat().resolvedOptions().timeZone`. Later changes come through
the `timezone` settings key (Pi, and ESP32 from 2026.8.34 — see the ESP32
row under Device profiles).

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

### What the panel shows before a scene arrives

Every board draws the same **FrameOS status screen**
(`frameos/src/frameos/utils/status_screen.nim`): the mark and wordmark, one
status line ("Checking network…", "Connected to FrameOS Cloud. Add a scene
from the workspace to get started."), then label/value rows — name, device
and resolution, network, who manages the frame, the frame URL, remote
control — and the version in the corner. White on black for HDMI/LCD, black
on white for e-ink.

- **Pi, HDMI (`framebuffer`)**: the driver is brought up *before* the network
  check (it is plain `/dev/fb0`, nothing that can wedge the board — the other
  drivers keep their deliberate late init) and the boot steps are drawn as
  they happen: "Starting up…", "Checking network… attempt N, T s", "Network
  connected. Loading scenes…" / "No network. Starting the setup hotspot…".
- **Pi, no scenes**: the `system/index` scene is this screen with the live
  facts. It re-renders the moment the cloud link state changes (enrollment
  completing, a disconnect) instead of at its 5-minute interval — only the
  `system/*` scenes do; a photo scene on e-ink is never refreshed because the
  provider reconnected.
- **ESP32 with the Nim runtime, no scenes**: the built-in fallback scene
  (`frameos/src/embedded/embedded_scene.nim`) is the same screen;
  `fos_client.c` pushes name/panel/IP/cloud state/version into the runtime
  (`frameos_nim_set_status_info`) before a pass that has no scene to draw.
  The screen is static on purpose (no render counter), so the packed-image
  hash skips the e-ink refresh when nothing changed.
- **ESP32 thin client (C3, no Nim)**: `fos_status_screen.c` draws the portal
  screen with the same header — the mark is a 24×28 1-bit bitmap generated
  by `frameos/tools/gen_logo_bitmap.nim` into `fos_logo_bitmap.h`.

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
start (the token's first enrollment is active right away; later enrollments
of a multi-use image token stay pending behind a confirmation). Setting a claim token forces the backend
connection off and refuses an explicit `FRAMEOS_BACKEND_ENABLED=true` — one
control plane at a time. Display questions stay interactive (the script
keeps its prompts); every prompt can be pre-answered with the script's
`FRAMEOS_*` environment variables for unattended installs.

### ESP32 browser flashing

The provider's flasher page uses WebSerial + esptool-js to write a prebuilt
firmware image, then provisions `cloud_url` + `claim_token` (+ optional
WiFi) into the device's NVS config partition. Either USB port a board
offers works: the console answers on the chip's built-in USB-Serial/JTAG
device ("USB JTAG/serial debug unit") and on UART0 behind an on-board
USB-UART bridge ("USB Single Serial" — Seeed's reTerminal E10xx wire USB-C
to a CH340 on UART0 and nothing to the chip's own USB pins; the PhotoPainter
13.3" shows both ports over one cable). `sdkconfig.defaults` makes UART0
the primary console and USB-Serial/JTAG the secondary; `fos_console.c`
reads commands from both. The flasher used to refuse bridge vendor ids,
which locked the reTerminal boards out entirely. Same enrollment flow A over
the device's own network connection afterwards. The firmware binaries come from
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
constructing them. Each ESP32 platform publishes **two** images, and they are
not interchangeable: `…-esp32-s3-generic.bin` is the merged flash image
(bootloader, partition table, blank otadata, app) that a USB flasher writes at
`0x0`, while `…-esp32-s3-generic-app.bin` is the bare app image — the only
thing an OTA slot accepts, since `esp_ota_end` validates an `esp_app_desc` at
offset `0x20` and the merged image has the bootloader there. The device-authed
OTA manifest/download routes serve the `-app.bin`; the browser flasher serves
the merged one. (Transitional: the generic binary is published as
`…-esp32-s3-generic.bin`, with an identical copy under the legacy
`…-esp32-s3-epd7in5v2.bin` name for one release cycle.) A second generic
image, `…-esp32-c3-generic.bin`, targets PSRAM-less ESP32-C3 boards
(TRMNL OG/BWRY, XTEINK X4): same panel set and provisioning surface, but
thin-client only — no on-device renderer. Backend-managed C3 frames pull
rendered bitmaps over `/api/frames/{id}/embedded/render`: the backend runs
the frame's scenes inside the same emscripten wasm runtime the live preview
uses (QuickJS sandboxed in wasm, no outbound network, bounded Node
subprocess — `backend/app/utils/embedded_render.py`), falling back to a
diagnostic card when scenes or the toolchain are missing. Cloud-managed C3
frames can enroll, report state, and take settings/logs verbs today, but
cloud-side scene rendering (the same wasm approach, or a push-image verb)
is not yet implemented; until then a C3 frame linked to the cloud shows its
provisioning/status screen only.

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
`width`/`height`. 2026.8+ firmware adds the board facts the USB console's
status JSON already reported, so the cloud deploy drawer can show them
without a cable: `mac`, `chipRevision` (major×100+minor), `chipCores`,
`memory` (`internalHeapBytes`, `psramBytes` — totals; free values travel as
metrics), `storage` (partition-map byte counts: `flashBytes`, `nvsBytes`,
`otadataBytes`, `phyBytes`, `factorySlotBytes`, `otaSlots`, `otaSlotBytes`,
`otaBytes`, `stateBytes`), `ota` (`supported`, `slotBytes`) and `sd`
(`enabled`, `mounted`, `capacityBytes`). A permanent
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
POST {provider}/api/frames/claim-tokens        # mint a claim token ("Add frame"); {"frame_id": …} binds it to an existing frame (re-enrollment); {"scene_source_frame_id": …} starts every frame it enrolls with that frame's scenes; {"timezone": "Europe/Brussels"} seeds the enrolled frame's time zone (and queues the set_settings push)
GET  {provider}/api/frames                     # list the account's frames
GET  {provider}/api/frames/{id}                # one frame, state + sync status
GET  {provider}/api/frames/{id}/metrics        # retained metrics + `reboots` markers (telemetry:metrics)
GET  {provider}/api/frames/{id}/metrics/recent # the same, from ?since=
POST {provider}/api/frames/{id}/confirm        # pending → active
POST {provider}/api/frames/{id}/revoke         # revoke link; device demotes itself on next 401; 403 reauth_required unless the session proved its credentials within 15 min (cloud/docs/auth.md)
GET  {provider}/api/frames/{id}/logs           # retained logs (telemetry:logs)
GET  {provider}/api/frames/{id}/activity       # the frame's audit trail, newest first; ?limit= (≤200), ?before=&before_id= cursor from next_cursor
GET  {provider}/api/frames/{id}/scenes         # assigned scenes
POST {provider}/api/frames/{id}/scenes         # assign scene versions → enqueues set_scenes
POST {provider}/api/frames/{id}/settings       # declarative settings → persists them, enqueues set_settings
POST {provider}/api/frames/{id}/schedule       # {"schedule": {…}, "utcOffsetMinutes"?: N} → persists the schedule, enqueues set_schedule (disabled events stripped from the push)
POST {provider}/api/frames/{id}/command        # {"type": "render" | "reboot" | "restart_runtime" | "set_current_scene", …}
GET  {provider}/api/frames/{id}/commands       # what is still QUEUED for this frame (see "Queue observability")
DELETE {provider}/api/frames/{id}/commands/{command_id}  # cancel one, while it is still undelivered
GET  {provider}/api/frames/{id}/service-settings          # DEVICE-authed, not session: see "Service settings"
POST {provider}/api/frames/{id}/service-settings/enabled  # {"enabled": bool} → grants/revokes settings:services, nudges on enable
POST {provider}/api/frames/{id}/telemetry/enabled         # {"enabled": bool} → grants/revokes telemetry:logs + telemetry:metrics, restart_runtime on change
WS   {provider}/api/frames/{id}/updates        # browser socket: update_frame / new_log / new_metrics / frame_activity events
WS   {provider}/api/frames/updates             # browser socket, all the account's frames (fleet view)
```

The settings push persists what it validated (`name` into the frame row, the
rest into the frame's `settings`, merged onto what was pushed before) and
`GET /api/frames/{id}` returns them as top-level fields in the device's own
spelling, so the Settings panel renders current state rather than blanks
after a reload — and an edit made while the device is offline survives until
the device reconnects.

**The panel shows only these keys.** A cloud-managed frame's Settings panel
renders an editable field for the allowlisted settings and nothing else — no
display driver, network, mountpoints, palette, GPIO or log configuration, even
though the same shared component draws all of them for a self-hosted frame.
That is not tidiness: `set_settings` refuses the *whole* push on a key the
device does not know, so an editable field for something outside the allowlist
cannot be made to work by trying harder — it either silently drops what was
typed or takes the rest of the push down with it. A provider adding a key must
therefore ship it to the devices first (or gate it on a reported version), and
only then let the surface offer it.

The extended batch is what that gate looks like in practice. The reference
SPA and the settings route both read the frame's reported `frameos_version`
(`frameSupportsExtendedSettings` in auth-web, its mirror
`cloudFrameSupportsExtendedSettings` in the shared SPA, pinned to agree by
test): a version at or past 2026.8.30 unlocks the fields; an older one renders
them *disabled with the reason* — never hidden — and the route answers
`400 settings_need_newer_firmware` (with `min_frameos_version`) if a client
sends them anyway; a non-empty but unparseable version (`unknown`, a dev
build) is trusted; a frame that has never reported one is not. The next batch
of keys should copy this shape: add to the device allowlist and validators
first, bump the floor, then let the surface offer them.

The frame summary those routes (and the hub's `update_frame` event) return
also carries the service-settings picture, so the workspace can explain a
scene that wants a key it does not have:

- `service_setting_groups` — the group NAMES this frame's assigned scenes
  declare (`[]` when they declare none). Never a field or a value.
- `service_settings_enabled` — whether the frame's link still holds
  `settings:services`. Omitted, never `false`, when the caller could not
  answer (a hub broadcast without the link row); the SPA merges summaries
  over the frame it holds, so an absent field keeps its last known value.

The metrics routes return `{"metrics": [...], "reboots": [...]}`, matching the
self-hosted backend. Markers are derived from the device's own
`{"event": "bootup"}` log lines (and the `reboot` object the Linux runtime
attaches to them: boot ids, systemd service result, OOM/watchdog kind). The
backend additionally guesses a reason from the shell output preceding a boot;
the cloud has no shell verbs, so a cloud marker carries only what the device
reported.

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

Standalone and backend-managed frames are unaffected. The deny keys on
*provider-origin scenes*, not on the link alone: the device stamps every
`set_scenes` payload with a runtime origin as it stores it (Pi/Linux:
`"source": "cloud"` persisted with `state/uploaded.json`; ESP32: a top-level
`"source"` in `/state/scene-index.json`), and a frame demoted out of the
managed state keeps the deny for as long as those scenes remain resident.
Replacing them — a local upload, a backend deploy — lifts it; the
`allowLocalNetworkAccess` elevation above overrides in either state. The
origin stamp is also re-checked at scene load time against the refused-app
list, so a persisted cloud payload can never reach a process-spawning app by
being replayed at boot.

## Compatibility

Providers must drop unknown fields, frames must ignore unknown optional
response fields, and both sides version through `frameos_version` /
`hello` — there is no separate protocol version until a breaking change
forces one.
