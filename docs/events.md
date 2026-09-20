# Scene events

The spec of the scene event layer: what an event is, which ones exist, who may
send them and what a host does with one. Three files, one job each:

| File | What it is |
|---|---|
| [`events-contract.json`](events-contract.json) | The contract: every built-in event, machine-readable. **The source of truth.** |
| this file | The rules that do not fit in a table. |
| [`event-fixtures.json`](event-fixtures.json) | The conformance corpus. Add a case there first; a runner that disagrees is the bug. |

The history — what was wrong, and where this is going — is
[`event-system-analysis.md`](event-system-analysis.md). This file describes the
tree as it is; where the hosts still differ it says so
([Known host differences](#known-host-differences)) instead of pretending.

## Changing an event

1. Edit `docs/events-contract.json`.
2. `python3 frameos/tools/generate_events_contract.py` — it validates the
   contract and rewrites every table below. `--check` fails when one is stale;
   the backend test suite runs it (`test_esp32_events_contract.py`).
3. Add or change a case in `docs/event-fixtures.json`, and run the runners.

Never edit a generated file, and never add an event name to a list of your
own: if the contract cannot answer the question you are asking, add a column.

| Generated file | Read by |
|---|---|
| `frameos/src/frameos/events_gen.nim` | Every Nim host (Linux, ESP32, wasm), through `frameos/events.nim` |
| `embedded/esp32/main/fos_events_gen.h` | The ESP32's C paths (`fos_schedule.c`, `fos_http.c`) |
| `frontend/src/utils/eventsContract.gen.ts` | The shared SPA, through `utils/eventsContract.ts`; both Monaco declaration files |
| `frontend/schema/events.json` | The editor's node catalog, the legacy compiled-scene codegen, the AI context |
| `frameos/wasm/src/events.gen.ts` | The `frameos-wasm` npm package |
| `cloud/apps/auth-web/src/lib/events-contract.gen.ts` | The cloud's frame event route and schedule validator |
| `backend/app/utils/events_contract_gen.py` | The self-hosted backend |

| Runner of the fixtures | Covers |
|---|---|
| `frameos/src/frameos/tests/test_event_fixtures.nim` | `origins`, `log`, `sequences` — the code all three hosts compile |
| `embedded/esp32/main/tests/test_fos_events.c` (via `backend/app/tasks/tests/test_esp32_events_contract.py`) | `origins`, against the firmware's C table |
| `backend/app/utils/tests/test_events_contract.py` | `origins`, against the backend's choice of credential |
| `cloud/apps/auth-web/src/test/events-contract.test.ts` | `cloudEventRoute`, and `origins` for the schedule validator |
| `cloud/apps/auth-web/src/test/shared-spa/events-contract.test.ts` | The SPA and the `frameos-wasm` package against the contract |

## The model

An **event** is a name and a JSON object payload, delivered to the frame's
**current scene**. Every `event` node in that scene whose keyword is the name,
and whose filter passes, runs. There is no "handled": all matching listeners
run. A scene node (an embedded child scene) sees an event only when the
parent's flow for that same event walks through it — in practice, `render`.

A name that is not in the contract is a **custom event**: a scene declares it
in `customEvents`, and every host delivers it by name like any other. Custom
event names are at most 63 characters (`customEvents.maxNameLength`; the ESP32
keeps a schedule's event name in 64 bytes).

**Filters** are string equality on top-level payload keys: an event node's
`data.config` maps a payload key to the text it must equal (`{"pin": "6"}`
matches the integer 6). An event no listener's filter lets through is reported
once as `runEvent:noListenerMatched`, without its payload. A `button` listener
from before `data.config` keeps its `data.label` filter. Old names and old
spellings never stop working: store scenes are versioned and immutable.

### Classes

| Class | Events | Meaning |
|---|---|---|
| `lifecycle` | `init`, `open`, `render`, `close` | The host tells a scene where it is in its life. |
| `input` | `keyDown`, `keyUp`, `mouseMove`, `mouseDown`, `mouseUp`, `wheel`, `button` | Something a person did. `device` says with what: `keyboard`, `pointer`, `button`. |
| `scene-command` | `setSceneState`, `setCurrentScene`, `turnOn`, `turnOff` | Asks the host to do something for the scene; a scene may dispatch it. |
| `device-command` | `metrics`, `reload`, `restart`, `reboot`, `uploadScenes` | Asks the runtime to do something to the device. Never delivered to a scene, never offered by the editor. |

### Lifecycle

`init` — once per scene instance, after its apps exist, before anything else;
the payload is the scene's state. `open {sceneId}` — every time the scene
becomes the current one: at boot, on a switch, on a switch *back*. `render` —
zero or more times. `close` — when the frame switches away; no payload. State
an `init` listener sets is on the scene's first frame.

### Origins

Every event has an **origin** — who is saying it — and the contract's
`origins` is an **allow-list**: an origin that is not listed may not emit the
event. A new origin starts with nothing.

| Origin | Who |
|---|---|
| `driver` | An input driver on the frame |
| `preview` | The browser preview's canvas and buttons |
| `scene` | A scene's own `dispatch` node |
| `schedule` | A schedule entry firing on the frame |
| `http:write` | The frame's HTTP API with the frame access key (or `public` access) |
| `http:admin` | The frame's HTTP API with an admin session or the `serverApiKey` — the backend |
| `cloud` | FrameOS Cloud, through a hub verb (`cloud.verb` names it) |
| `system` | The runtime itself |

The allow-list is asked wherever a host can tell where an event came from
today — `enforcedOrigins`: a scene's dispatch node (`interpreter.nim`), the
scheduler (`scheduler.nim`, `fos_schedule.c`), the frame's HTTP routes
(`server/auth.nim`; the backend picks its credential by the same list) and the
cloud (the frame event route, the schedule validator). The other origins are
trusted code and are not checked anywhere yet; their lists are descriptive.
What that comes to:

- The frame access key is printed on the frame's QR code. It may pick a scene;
  it may not `reload`, `restart`, `reboot` or `uploadScenes`.
- A scene is untrusted code (anyone's store scene). Same four.
- A schedule is data nobody validated. It may switch, render, power, reload
  and reboot; it may not `uploadScenes`.
- The cloud sends what has a hub verb. Input, lifecycle and custom events have
  none: the route answers 404 `unsupported_event`.

A refused event is dropped and logged (`interpreter:dispatch:ignored` with
`reason: "runtimeVerb"`, `scheduler:refused` / `schedule:refused`), or
answered 401/404 on HTTP.

The lists for non-command events are wide on purpose: they record what each
origin *can* do today, because narrowing one is a behaviour change for scenes
in the wild. When the origin becomes part of the event envelope
(`event-system-analysis.md` §4.2) each narrowing is one line in the contract
and one fixture.

### Payloads, units and the wire

`payload` lists each field with its type and, where a number means something,
its `unit`. `catalog: false` keeps a field out of the editor's filter and
dispatch forms.

- **Pointer position.** A scene sees `mouseMove {x, y}` in **scene pixels**,
  rotation and flip applied. On the wire — driver → host, preview → host,
  `POST /event/mouseMove` — both axes run **0..32767** across the panel
  (`pointer.wireMax`), whatever the device reports. The host converts.
- `mouseDown` / `mouseUp` carry `button` only: 0 left, 1 right, 2 middle,
  3 side, 4 extra. The position is the last `mouseMove`.
- `wheel {deltaX, deltaY}` is in notches; `deltaY` is positive scrolling down.
- `keyDown` / `keyUp` carry the Linux key name and number (`KEY_A`, 30).
  Auto-repeat is dropped, not reported.
- `button {pin, label, level}` is a press. No host sends a release.
- `setSceneState {state, render}` — `state` is applied to the scene's public
  state; `render: true` asks for a render afterwards. In the editor its
  dispatch form is the scene's own fields (`sceneState: "payload"`).
- `setCurrentScene {sceneId, state}` — one that names the scene already
  showing applies `state` and renders, without a switch.

### Policy columns

- **`log`** — what the frame log says when a host drains the event. `full`:
  name and payload. `name-only`: keys — the log is stored by the control plane
  and may be sent to the cloud, so from the moment a scene has a text field
  anything else makes the frame a keylogger. `none`: pointer events, one per
  motion report.
- **`coalesce`** — `latest`: consecutive queued events of this name collapse
  to the newest (`mouseMove`), and the first other event behind them is kept in
  order.
- **`renderAfter`** — whether the host renders once the event is handled:
  `never`, `always`, or `if-state-changed` (a handler changed scene state or
  dispatched `render`). This is the rule the hosts converge on; today only
  `never` for pointer events is honoured everywhere — see below.
- **`hosts`** — whether a host produces or handles the event at all. Pointer
  and keyboard events are described for every host and are
  `hosts.esp32: false`: no board in the tree has touch, and nothing is built
  for hardware that is not there.
- **`schedule`** — the Schedule panel offers the event, under this label.
  `endsRuntime`: the runtime does not survive it, so the scheduler persists
  the minute it fired in, or it would fire again after the restart.

### Dispatch from a scene

What a handler dispatches is **queued**: it is delivered after the run that
dispatched it, never inside it. A run may dispatch 64 events; the first one
over is logged (`reason: "dispatchBudget"`), the rest are dropped.
`render` dispatched while handling `render` is ignored
(`reason: "renderSelfDispatch"`).

### `context` in JavaScript

`context.event` is the event's name and `context.payload` its payload. The
contract's `context.keys` says which keys a code node and an app see; both
Monaco editors get their declarations from it, together with a
`FrameOSEventPayloads` interface (`FrameOSEventPayloads["keyDown"]` is
`{ key: string; code: number }`).

### Log lines a control plane follows

`logEvents` are log lines, not scene events. `sceneChanged` — the frame now
shows `sceneId` (the backend's active-scene cache, Home Assistant, the fleet
list). `sceneStateChanged` — the frame's state is worth re-reading.

## Known host differences

The interpreter — delivery by name, filters, state, the dispatch rules above —
is one piece of Nim that all three hosts compile, and the fixtures run it. What
each host does *around* it is still three pieces of code, and they differ.
These are not the spec; they are what is left to fix, and none of them has a
fixture yet because no shared code exists to hold to one
(`event-system-analysis.md` §4.3, "one dispatcher").

| Behaviour | Linux | ESP32 | wasm preview |
|---|---|---|---|
| A handler's dispatch is delivered | after the run (queue) | now, nested (depth 4) | now — and dropped if already inside a handler |
| Render after an event | only if the scene dispatches `render` | after a `button` a listener handled; otherwise only on `render` | always, except pointer events |
| `turnOn` / `turnOff` | drives the display, then the scene hears it | the scene hears it; no display action | the scene hears it |
| A scheduled `reload` | reloads | goes to the scene as an unknown event | — |
| `setSceneState` from the cloud | rides on `set_current_scene` for the scene last reported | refused (the verb drops `state`) | — |
| `close` on `reload` / `uploadScenes` | not sent | not sent | not sent |

A fixture runner for the wasm *host* (the bundle under node) belongs with that
work: the cloud's CI runs the wasm runtime of the pinned release, not of the
tree, so until a job builds the bundle from source such a runner would test
last month's code.
