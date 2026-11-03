# Home Assistant integration

The self-hosted backend shares its frames with Home Assistant over MQTT
discovery and the Home Assistant event bus, and takes commands back the same
way. Turn it on under **Settings → Home Assistant → Share frames with Home
Assistant**. As a Home Assistant add-on the connection and the Mosquitto broker
are found through the Supervisor; standalone, give it the Home Assistant URL
plus a long-lived access token (events) and an MQTT login (devices).

This is a feature of the self-hosted backend alone: FrameOS Cloud has no Home
Assistant link, and a cloud-managed frame is reached from Home Assistant
through the backend it is also enrolled with, if any.

The code is `backend/app/ha/`: `discovery.py` (what a frame is in Home
Assistant), `commands.py` (what Home Assistant sends back), `state.py` (what
the sync remembers in Redis, and how it reads a frame's scene state) and `sync.py` (the service, one task in the arq
worker). Every command reaches a frame through `dispatch_frame_event` in
`app/api/frames.py`, the same function the editor's buttons go through, so
every frame kind (Pi, Buildroot, ESP32, thin client, virtual) takes a Home
Assistant command the way it takes an editor click. Nothing here is a new
event: the names are the contract's (`docs/events-contract.json`).

## What a frame is in Home Assistant

One device per non-archived frame (archived ones are removed), under a
"FrameOS" hub device whose `sensor.frameos_frames` counts them and lists their
names in its attributes. On the frame's device:

| Entity | Kind | What it does |
|---|---|---|
| Image | `image` | The latest render (retained PNG). |
| Status | `sensor` | `ready`, `deploying`, `uninitialized`, … |
| Scene | `sensor` | The scene showing, by name; its public field values are the sensor's attributes (below). |
| Last seen | `sensor` (timestamp, diagnostic) | The last log line's time. |
| Scene | `select` | The frame's scenes; picking one is `setCurrentScene`. |
| Display | `switch` | `turnOn` / `turnOff`. Its state is what the frame last logged (`event:turnOn`, `event:turnOff`, a toggle), or what Home Assistant last asked for; unknown until either. |
| Refresh | `button` | `render`. |
| Next scene, Previous scene | `button` | `setCurrentScene` to the neighbour in the frame's scene order, wrapping around. |
| Restart FrameOS, Reboot | `button` (config) | The restart / reboot tasks, with a deploy-progress record like the workspace's buttons. |

Two scenes with one name show as "Clock" and "Clock (2)", in the frame's order.
That is the whole device, eleven entities, whatever the frame's scenes hold: a
scene's settings are never entities of their own (a frame has many scenes and a
scene many fields; a thousand entities is not an integration).

### Scene settings as attributes

The Scene sensor's attributes carry the public fields (the ones the scene's
settings panel shows, the implicit `refreshInterval` included) of the scene
showing, typed as the scene keeps them:

```yaml
# sensor.kitchen_frame_scene
state: Weather
scene_id: 3f2a…
fields:
  city: Paris
  dark: true
  refreshInterval: 300
```

So a template reads `state_attr('sensor.kitchen_frame_scene', 'fields').city`,
and a trigger on the attribute fires when the frame itself changes it. Fields
of type `json`, `image`, `font`, `node`, `scene` and `path` are left out
(assets and wiring, not settings), private ones too. The values come from where
the backend keeps a frame's scene state (a virtual frame's and a thin client's
store, a device's `/states` cache, else the device itself), re-read a second
after the frame logs a scene change or a `setSceneState` / `setCurrentScene` /
`uploadScenes`, so a setting changed on the frame's own settings panel, by a
button or a schedule shows in Home Assistant too.

Setting them goes through the command topic (next section): a scene with its
parameters in one message, or `setSceneState` for the scene showing. A frame
applies state to the scene showing alone, so "set the weather city, then show
the weather" is one `{"scene": "Weather", "state": {"city": "Paris"}}`.

## Topics

Everything a frame publishes and listens on lives under
`frameos/frame/<project id>/<frame id>/`:

| Topic | Direction | Payload |
|---|---|---|
| `state` | out, retained | `{name, status, scene, scene_id, display, last_log_at}` |
| `image` | out, retained | PNG bytes |
| `event` | out | `{frame_id, project_id, frame_name, event, payload}` per frame event |
| `fields` | out, retained | `{scene_id, scene, fields: {<field>: <value>}}` for the scene showing (the Scene sensor's attributes) |
| `set/scene` | in | a scene label (what the select shows), name or id |
| `set/display` | in | `ON` / `OFF` |
| `press` | in | `render`, `next_scene`, `previous_scene`, `restart`, `reboot` |
| `command` | in | free-form, below |

`frameos/status` is the availability topic (`online` while the sync runs, the
broker's will says `offline`); `frameos/frames/<project id>/state` the hub's
count. Only the frames of projects that enabled sharing are published, and only
to the broker their own project configured.

### The command topic

For automations that want more than an entity: `mqtt.publish` to
`frameos/frame/<project>/<frame>/command` with either

```json
{"scene": "Weather", "state": {"city": "Paris", "dark": true}}
```

(the scene by label, name or id, with optional state) or

```json
{"event": "setSceneState", "payload": {"state": {"city": "Rome"}}}
```

A `state` value is typed by the scene's public field where it has one and the
value fits (a template's `"true"` reaches a boolean field as `true`, its `"4"`
an integer field as `4`), and passed on as given otherwise.

Any event the frame's own HTTP API accepts with the frame access key may be
named: `render`, `setCurrentScene`, `setSceneState`, `turnOn`, `turnOff`,
`toggleScreen`, `sceneSwitcher`, `back`, `forward`, `button`, a custom event a
scene listens for, … What that API refuses (`init`, `open`, `close`, `reload`,
`restart`, `reboot`, `uploadScenes`, `voiceChat`: the contract's `http:write`
column) is refused here too; restart and reboot are the buttons.

Every command is logged on the frame ("Home Assistant asked for scene:
Weather"); one the frame refused, or one that made no sense ("No scene
'Nope' on this frame"), is a `stderr` line there rather than an error anywhere
else. Whoever can publish on the broker can command the frames of every
project sharing through it: it is Home Assistant's broker, protect it as such.

## Events

Every frame log line that is an event (`render:done`, `bootup`, `button`,
`event:setCurrentScene`, a scene's custom event, …; not `log`, `debug`,
`metrics`) is published on the frame's `event` topic and fired on the Home
Assistant event bus as `frameos_event`:

```yaml
trigger:
  - platform: event
    event_type: frameos_event
    event_data:
      frame_name: Kitchen frame
      event: button
```

Each carries `frame_id`, `frame_name`, `event` and the line's other keys under
`payload`.

## What syncs when

- A frame added, renamed, archived or deleted, or its scenes changed, is
  re-discovered on the `update_frame` broadcast; discovery is only resent when
  it changed (a hash of the configs).
- The scene sensor and select follow `render:scene` / `render:sceneChange` /
  `event:setCurrentScene` lines; the display switch `event:turnOn` /
  `event:turnOff` / `event:toggleScreen`; the scene sensor's attributes those
  scene-change lines and the `sceneStateChanged` log events, debounced by a
  second.
- The image follows `frame_rendered` / `new_scene_image`, at most once every
  two seconds per frame.
- "Save & sync now" on the settings page republishes everything and answers
  with the broker it used and how many frames it shared.

## Settings

`homeAssistant` (per project): `url`, `accessToken` (the event bus,
standalone installs), `syncEnabled`, `mqttHost` / `mqttPort` / `mqttUsername` / `mqttPassword` (standalone installs;
an add-on asks the Supervisor). Frames get `url` + `accessToken` only, for the
Home Assistant apps they run.
