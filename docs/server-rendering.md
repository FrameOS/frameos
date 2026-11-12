# Rendering on the server

An ESP32 frame can hand its scenes to its control plane. The plane runs the
scene in the same wasm runtime the browser preview uses, packs the picture
into the panel's own format and hands it over at every render pull. The frame
keeps Wi-Fi, its schedule, its keys and touch, its panel and its deep sleep,
and stops doing the scene's work: no JavaScript, no image decodes, no TLS
handshakes to the scene's data sources. A battery frame's wake becomes Wi-Fi,
one HTTPS request and the panel refresh.

It also means the scene runs where the plane is, and fetches from there:

- **On a self-hosted backend** a scene reaches what the backend reaches: its
  LAN and a VPN it is on (private ranges, `100.64.0.0/10` included), as a
  backend frame's own runtime could (`docs/lan-access.md`: backend frames
  have no block). What is the backend host's own and never the frame's
  network stays refused: loopback, link-local and the metadata address,
  unless the frame's `network.allowLocalNetworkAccess` is on; set to `false`
  it refuses private ranges too. A virtual frame keeps its opt-in rule.
- **On FrameOS Cloud** a scene reaches public addresses only: the cloud's
  renderer refuses every private one, whatever the frame's local network
  access says (that switch is about the frame's own network, which the cloud
  is not on).

This is the thin-client mode a PSRAM-less board (ESP32-C3) has always run in,
offered as a choice to a board that has its own runtime (every ESP32-S3).
Neither plane builds firmware for it: the switch is a setting.

## The switch

| | Self-hosted backend | FrameOS Cloud |
| --- | --- | --- |
| Where it is kept | `device_config.renderMode` (`"local"` / `"remote"`) | `render_mode` in the frame's settings (`docs/cloud-frames-contract.json`), mirrored on `frames.settings` |
| How the device hears it | `/embedded/settings` → `frame.renderMode` (`fos_settings.c`) | `set_settings {render_mode}` (`fos_cloud.c`), firmware 2026.11.7 on |
| Where the owner sets it | Settings → Power → "Render scenes" (`PowerSettingsFields.tsx`) | the same field |
| What it costs | nothing | one of the plan's cloud-rendered frames, and the refresh floor that comes with them |

The device reports what it runs as `hardware.renderMode` and applies a change
live: the next render pass pulls (or renders) the other way. A board without
a runtime (`localRenderSupported: false`) is remote whatever the setting says.

On the cloud, a frame set to remote counts against `cloud_rendered_frames`
(`frameIsCloudRendered` in `cloud-rendered.ts`; the count's SQL reads the same
setting). Turning it on past the plan's number is refused with
`cloud_rendered_frame_quota_exceeded`, and the frame's interval may not go
under the floor (`interval_below_plan_floor`). A device that is remote by its
own console but not on the plane is refused at the pull
(`not_server_rendered`) and, having a runtime, renders that pass itself.

## The render pull

```http
GET {plane}/api/frames/{id}/embedded/render?scene=…&width=…&height=…&format=…&rotate=…
Authorization: Bearer …
If-None-Match: "…"
```

- **Who**: the backend's frame API key (`server_api_key`), or the cloud
  device's access token (`authenticateFrameDevice`). `{id}` is the backend's
  frame number or the cloud's frame uuid.
- **`scene`**: the scene the device's own runtime is on (absent on a board
  without one). See "Which scene" below.
- **`width`, `height`, `format`, `rotate`**: the panel's native size, its
  `fos_pixel_format_t` and the frame's rotation. The cloud draws to them and
  refuses a pull without the first three (`400 invalid_panel`); the backend
  draws to its own copy of the frame and ignores them.
- **`If-None-Match`**: the ETag of the picture the panel shows now, from the
  pull that put it there. Kept in RTC memory, so it survives a deep sleep;
  dropped whenever anything else draws the panel.
- **200**: the FOSB bitmap (`FOSB`, version 1, format, width u16le, height
  u16le, reserved u16, then the packed panel bytes), `ETag: "<first 32 hex of
  sha256(body)>"`, `Cache-Control: no-store`.
- **304**: the picture is the one the panel shows. No body; the device
  leaves the panel alone and logs `render:device skipped unchanged`.
- **Errors**: the backend answers a diagnostic card instead of failing. The
  cloud answers `403 not_server_rendered`, `403
  cloud_rendered_frame_quota_exceeded`, `503 renderer_unavailable` /
  `renderer_busy` (with `Retry-After`) or `502 render_failed {error}`; the
  device keeps the picture it shows and logs `render:error`.

The backend also takes `POST` with the board's button edges (the Pico's
pull, `embedded_device_input`); an ESP32 pulls with `GET`.

### Which scene

1. A scene switch the plane sent and the device has not taken yet (a
   `set_current_scene` still pending on the frame's command queue): the
   plane's choice. The device has not heard it.
2. Otherwise the device's `scene`, when it names one of the frame's scenes:
   a key, a touch, the schedule or a switch the device already took.
3. Otherwise the plane's own active scene, then the frame's default scene.

The plane keeps the scene it drew as its active scene.

### State and events

The plane is the memory, as for a virtual frame: a scene's state lives on the
plane and is written back after every render (backend: the virtual-frame
state store in Redis; cloud: `frame_server_renders.states`). State that comes
with a scene switch or `setSceneState` goes into that store when it is sent,
before the device hears of it. A `scene_event` waits on the plane and runs in
the scene at the next pull, and the device is sent `render` in its place
(backend `hold_thin_client_event`, cloud `frame_server_renders.pending_events`).

### Packing

The plane packs the runtime's RGBA into the panel's format exactly as the
backend's thin-client renderer always has (`pack_image_for_panel` in
`backend/app/api/embedded_device.py`; the cloud's port is
`cloud/apps/auth-web/src/lib/panel-pack.ts`): Floyd-Steinberg dithered against
the panel's palette, greys from luma 0.21 / 0.72 / 0.07, Spectra 6's unused
index 4 skipped. A frame hung at 90 or 270 degrees renders on the swapped
canvas and is turned clockwise by its rotation into the panel's orientation.

## Deep sleep: the picture is drawn before the wake

A deep-sleeping frame says when it will wake (`sleep` with `wakeInSeconds`
and `nextRenderAt`, kept as `next_wake_at` / `next_render_at`). For a frame
rendered on the server, the plane draws its next picture **before** the wake
and keeps it, so the pull at the wake is a download, not a render:

- It starts `lead` seconds before the wake: twice the frame's last render on
  the plane plus 10 s, at least 20 s and at most 90 s.
- The scene's clock is set to the wake's render time (`nextRenderAt`, else
  the wake): the renderers take `nowMs` (the backend harness's request
  `nowMs`, the cloud's `SceneRenderOptions.nowMs`) and shift `Date.now`
  inside the wasm runtime only. A clock face drawn ahead shows the minute
  the frame wakes into.
- It is kept with the scene and the revision it was drawn at. The pull takes
  it when it would draw the same scene, nothing changed since (no state
  written, no event held, no scenes pushed: the revision moved on none), and
  it is within 120 s of the time it was drawn for. Its scene state is
  committed then, not before. Anything else, and the pull renders as it
  always did. A kept picture is used once.

With the ETag a wake whose picture did not change costs no download and no
refresh at all.

## Battery: what the switch would save

ESP32 metrics carry `renderSceneMs`: how long the last pass took to produce
its picture (the scene on the device, or the pull). The battery popover
(`FrameBatteryPopover.tsx`) models a server-rendered wake as the awake time
less `renderSceneMs` plus 3 s for the pull, puts it through the same cadence
model as the rest of the forecast (`serverRenderForecast` in
`utils/batteryForecast.ts`) and, on a frame that renders itself and
deep-sleeps, says how long the battery would last rendered on the server when
that is at least 10% longer.

## Not yet

- The plane's packer dithers to the stock palette of the panel, not the
  frame's own `palette` setting.
- A scene listening to the board's keys (`button`) does not hear them on an
  ESP32 rendered on the server: the GET pull carries the scene id, not the
  key edges. The frame's event map (previous / next scene, the switcher)
  still works, since it is a scene switch.
- The cloud has no frame assets for a scene drawn on the server.
