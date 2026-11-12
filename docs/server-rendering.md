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

What the frame stops doing with its scenes, it stops doing entirely: in
remote mode the firmware runs no scene work (no scene store apply, no
dispatcher). What its keys, its touch glass, its own schedule and its own
HTTP API would have told its scene goes to the plane with the next pull
instead, and the plane's dispatcher runs it (see "Keys, touch and the
schedule").

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

or, when the frame has input for its scene, the same with `POST` and that
input as a JSON body (see "Keys, touch and the schedule").

- **Who**: the backend's frame API key (`server_api_key`), or the cloud
  device's access token (`authenticateFrameDevice`). `{id}` is the backend's
  frame number or the cloud's frame uuid.
- **`scene`**: the scene the device's own runtime is on. Both planes read it
  (see "Which scene" below), but no firmware sends it yet: a frame in remote
  mode runs no scene of its own, so its runtime's scene would be a stale one
  and would undo the plane's switches.
- **`width`, `height`, `format`, `rotate`**: the panel's native size, its
  `fos_pixel_format_t` and the frame's rotation. The cloud draws to them and
  refuses a pull without the first three (`400 invalid_panel`); the backend
  draws to its own copy of the frame and ignores them.
- **`If-None-Match`**: the ETag of the picture the panel shows now, from the
  pull that put it there. Kept in RTC memory, so it survives a deep sleep;
  dropped whenever anything else draws the panel.
- **200**: the FOSB bitmap (`FOSB`, version 1, format, width u16le, height
  u16le, reserved u16, then the packed panel bytes), `ETag: "<first 32 hex of
  sha256(body)>"`, `Cache-Control: no-store`, and `X-FrameOS-Scene: <the
  scene drawn, URI-encoded>` (on a 304 too), so the device can name it.
- **304**: the picture is the one the panel shows. No body; the device
  leaves the panel alone and logs `render:device skipped unchanged`.
- **Errors**: the backend answers a diagnostic card instead of failing. The
  cloud answers `403 not_server_rendered`, `403
  cloud_rendered_frame_quota_exceeded`, `503 renderer_unavailable` /
  `renderer_busy` (with `Retry-After`) or `502 render_failed {error}`; the
  device keeps the picture it shows and logs `render:error`.

### Keys, touch and the schedule

A frame rendered on the server keeps its producers: the button task, the
touch glass, the schedule and its own HTTP API (`/event/<name>`). In remote
mode `fos_events_dispatch` (`fos_events.c`, the one C edge they all go
through) does what it always did with what is the firmware's own (`render`
asks for a pull; `reload`, `restart`, `reboot`, `uploadScenes`; the voice
key, which the button task claims before any dispatcher), and **relays**
everything it would have handed its scene: input (`gpio` edges with
`claimed` and `wake`, `pointerDown` / `pointerMove` / `pointerUp`),
`setCurrentScene` (with or without a `direction`), `setSceneState`, custom
events, `button` said over HTTP, `turnOn` / `turnOff`. Relayed from these
origins only: `driver`, `schedule`, `http:write`, `http:admin`. What came
from the plane itself (`cloud`, a backend command) is the plane's already
and only asks for the pull (it reaches the firmware through
`fos_events_dispatch_from_plane`, which never relays); the console's
`system` stays on the frame (`event:unsupported`). `turnOn`, `turnOff` and
`toggleScreen` are both: the board's backlight is the device's, so it acts
on them, and the scene may listen for them, so they are relayed too.

The relay (`fos_render_relay.c`, pure, host-tested) holds them in order,
each as the dispatcher would have been handed it: origin, name and payload,
the payload's `atMs` on the board's monotonic clock as the button task and
the touch driver stamp it, kept as it goes on the wire. A finger on the
glass keeps its gesture in the touch queue until it lifts, its moves folded
to the newest there, so the plane gets the down, the last move and the up.
At most 32 events and 16 KiB of body; past that the oldest go, logged
`event:dropped`.

The frame sends them **once the input is decided**: no key down, no tap
inside its double-press window (`fos_button_timing.c`, the rule the Pico
sends by), no finger on the glass; a pull due anyway waits for that too (at
most 10 s), so a press never goes in two halves. Then the next pull is a
`POST` (`Content-Type: application/json`) with

```json
{"nowMs": 81234, "events": [
  {"origin": "driver", "name": "gpio", "payload": {"pin": 3, "label": "RIGHT", "level": 0, "action": "down", "atMs": 80410}},
  {"origin": "driver", "name": "gpio", "payload": {"pin": 3, "label": "RIGHT", "level": 1, "action": "up", "atMs": 81020}},
  {"origin": "schedule", "name": "setCurrentScene", "payload": {"sceneId": "news"}}
]}
```

`nowMs` is the board's clock when it sent them; `pointerMove` carries no
`atMs` (the touch driver stamps the down and the up). A schedule entry or
an HTTP event asks for the pull at once; a pull that is due anyway takes
whatever is waiting. A battery frame does not go to sleep while the relay
holds anything (`sleep:held`, reason `input`), within bounds: not on a
critical battery, and three holds in a row at most without a pull the
plane answered; then it sleeps and the input is lost with its RAM. The key that woke it (`wake:
true`) is relayed with the first pull of the wake. The relay is emptied by
a `200` or a `304`, and by a `400` or `413` (a body the plane cannot read
would otherwise be sent for ever); after a network error, a `503` or a
`429` the same events go with the next pull. (A plane that ran them and
whose answer was lost runs them twice; a press is not worth a delivery
protocol.) A pull the cloud refuses (`403`) drops what it carried
(`event:dropped`, reason `refused`); a board that can render then renders
that pass itself, from then on with its own scene hearing its input. Each
pull that carried input logs one `render:relay` line: the count and the
status.

The Pico sends its button edges the older way, `{"nowMs", "edges": [{label,
action, atMs, pin?, wake?}]}` (`embedded_device_input`), and both planes
keep taking it. A body may carry both; `edges` are delivered first.

**On the plane** the input goes into the same render, before it draws:
`frameos_wasm_device_input` (`frameos/relayed_input.nim`) moves every
`atMs` onto the runtime's own clock, as far before its now as it was before
the board's `nowMs`, and sends each event from its origin through the one
dispatcher (`event_loop.nim`), whose origin allow-list, event maps (the
frame's `event_map` and the installed scene's, which both planes hand the
render) and `press` / `doublePress` / `longPress` timing decide what comes of
it, exactly as on the board. Before the scenes load, both planes hand the
runtime what the board's own runtime holds (`frameos_wasm_set_frame`:
`eventMap`, `palette`, `colors`, the panel's `pixelFormat` and `rotate`, and
the backend's `gpioButtons`), so a relayed tap lands where it was on a
rotated frame and the automatic fit aims at the panel's colours. An event whose origin is not one of the four is
not delivered. The scene's log lines about what it heard go to the frame's
log, as for the Pico.

A pull carrying pointer events draws the scene once before it delivers
them, and throws that picture away: a UI's clickable regions and its
handlers are the last render's (`ui/events.nim`), and the plane's process
has drawn nothing yet, so without it a tap lands on nothing
(`frameos_wasm_device_input`; on the bench, 2026-11-12, a tap on the E1003
did nothing). That costs a render more for a pull with a tap, and a scene
whose state moves on with every render moves on twice. A pointer's position
travels as the touch driver sends it, 0..32767 across the picture
(`fos_touch_wire`), never in pixels.

**The plane keeps the scene the render ended on** as its active scene, with
that scene's state: a `setCurrentScene` or a `previous` / `next` from the
event map is a switch on the plane. The scene switcher and the scene
settings (`system/sceneSwitcher`, `system/sceneSettings`) are kept too, so a
tap on a tile in the next pull lands in the switcher it opened; they are
kept only while the frame is awake, as on the board, which never persists
them: when the frame says it is going to sleep, the plane goes back to the
scene they were opened from (`state.from`) before it draws the picture for
the wake. The frame page behind the gear has nothing to show on a plane (its
facts are the device's): with no host behind it the gear is not offered.

The plane's record is also what the workspace shows: the scene showing and
its state come from the plane's store (the backend's `_load_frame_states`
and `/state`, the cloud's `frames.last_state` written at each committed
render), never from what the device reports of its own idle runtime: not its
commands pull, not its render log lines, not the `scene_id` of a picture it
pushes, not its own `/image`. A backend that took those undid every switch
the pull had just drawn (E1003, 2026-11-12). The picture is the plane's too:
the backend keeps what a pull served (the upright scene image, as PNG, after
the answer has gone, one scene at most every 10 s) as the frame's image, and
a picture drawn ahead of a wake is published when a pull takes it.

The board names that scene too: the pull's `X-FrameOS-Scene`
(percent-decoded) is the scene in its `render:*` lines (the start line
names the one drawn last), and the panel's refresh chooser takes it as the
scene shown, so a switch on the plane gets a full refresh, not the partial
one that ghosted when the board compared its idle runtime's scene with
itself. A board rendered on the server does not push its picture back.

A pull with input never takes a picture drawn ahead of a wake.

### Which scene

1. A scene switch the plane sent and the device has not taken yet (a
   `set_current_scene` still pending on the frame's command queue): the
   plane's choice. The device has not heard it.
2. Otherwise the device's `scene`, when it names one of the frame's scenes
   (the firmware does not send it: a frame in remote mode runs no scene of
   its own, and its keys and schedule reach the plane as input instead).
3. Otherwise the plane's own active scene (a built-in scene included, see
   below), then the frame's default scene.

The plane keeps the scene the render ended on as its active scene.

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

Neither plane packs on its event loop: a 13.3" Spectra 6 panel is 0.1 to
0.2 s of dithering, which would stall every other request and every other
frame's pull meanwhile. The backend packs on a worker thread
(`_fosb_off_the_loop`, handed the frame's packing facts, `_PanelFrame`, never
the ORM row). On the cloud the packing runs in the render's own worker
thread, where the pixels are, and only the packed picture comes back, for
the auth-web route and the hub's pre-render alike. The worker
builds its packer from `panel-pack.ts`'s text (`createPanelPacker`, one
self-contained function, which the main thread calls too); if it cannot,
it hands the pixels over and the main thread packs them, logged once as
`server_render.pack_on_main_thread`.

The palette it dithers against is the one the device's own packer would
use (`activePalette(framePalette(stock))` in `embedded_main.nim`):

1. A photo's own dither palette (its colour profile's `palette`,
   `docs/asset-color-profiles.md`), when the scene drew one last in this
   render. The runtime reports it (`frameos_wasm_render_palette`, `[]` when
   none), and it is fitted like the device fits it.
2. Otherwise the frame's `palette` setting (its colour list: the colours
   this panel really shows, measured), fitted onto the stock table
   (`fitPaletteOverride` in `utils/dither.nim`: as many colours as the
   table, or one fewer for Spectra 6, whose hole at index 4 is put back;
   any other length is ignored).
3. Otherwise the panel's stock palette.

Only the palette formats have one (`BWYR`, 7-colour, Spectra 6); the
colours change what each pixel is dithered to, never which index it is
written as. The render itself is told the frame's `palette` and `colors`
the way the device's runtime is, so the automatic fit of drawn images aims
at the same colours.

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

- One render keeps one scene's state: if the input switched scenes, the
  scene it left loses what it changed in that same render.
- A tap answers in a pull's time (a second or three on e-paper; on an LCD
  it shows), since the scene runs on the plane: no animation, no
  `hover:` / `active:` light while the finger is down.
- A frame rendered on the server wakes on the frame's interval, as a board
  with no runtime always has: a scene's own `refreshInterval` and its
  `nextSleep` do not reach it (a clock that wants every minute gets the
  frame's five). The way there: the plane sends them with the pull (both
  planes' renderers would report `frameos_wasm_scene_interval` /
  `frameos_wasm_next_sleep`, the cloud's held to its floor) and the board
  takes its next wake from it.
- A press sent through the backend's event route to a frame it renders
  (`POST …/event/pointerDown`, a tap in the workspace) is forwarded to the
  board's own HTTP API, not held on the plane like a custom event, so its
  down and its up can go with two pulls and make no tap. A tap on the glass
  is one gesture, sent once the finger lifts.
- The ETag is an e-paper fact: an LCD keeps no hash of its panel, so it
  downloads every picture.
- A board that refused once (the cloud's `403`) renders itself for an hour
  before it asks again (`FOS_RENDER_PULL_REFUSED_RETRY_S`), and at once after
  a new `render_mode` push.
- Frame assets. A scene drawn on a plane cannot read the device's assets
  (its SD card, its flash): neither plane hands the render any for a
  hardware frame. A photo album works (its share link is an address the
  plane can fetch). The way there: while a frame renders on the server, its
  plane keeps the frame's assets (the backend's virtual-frame store; on the
  cloud an object store with a size limit, the sweep and account erasure),
  the Assets panel and the asset tools write there, and the render mounts
  them as a virtual frame's are.
