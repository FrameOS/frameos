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
tree as it is. Everything under [The model](#the-model) is one piece of Nim,
`frameos/src/frameos/event_loop.nim`, which the Linux runner, the ESP32 runtime
and the wasm preview all compile; what is left that differs per host is in
[Known host differences](#known-host-differences).

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
| `embedded/esp32/main/fos_events_gen.h` | The ESP32's C edge, `main/fos_events.c` |
| `frontend/src/utils/eventsContract.gen.ts` | The shared SPA, through `utils/eventsContract.ts`; both Monaco declaration files |
| `frontend/schema/events.json` | The editor's node catalog, the legacy compiled-scene codegen, the AI context |
| `frameos/wasm/src/events.gen.ts` | The `frameos-wasm` npm package |
| `cloud/apps/auth-web/src/lib/events-contract.gen.ts` | The cloud's frame event route and schedule validator |
| `backend/app/utils/events_contract_gen.py` | The self-hosted backend |

| Runner of the fixtures | Covers |
|---|---|
| `frameos/src/frameos/tests/test_event_fixtures.nim` | `origins`, `log`, `sequences` — the code all three hosts compile |
| `frameos/src/frameos/tests/test_event_loop.nim` | `dispatcher` — the shared dispatcher around the real interpreter: queueing, origins, the command/event split, the render rule |
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

### The envelope and the dispatcher

What travels is an **envelope**: `{name, payload, target?, origin, seq, tMono}`.
`origin` is who is saying it, and it is set by the producer's own entry point —
the HTTP route, the scheduler, the hub client, the driver boundary, a dispatch
node — never read from the payload. `sendEvent(event, payload, origin)` has no
default: a new producer has to say who it is.

One dispatcher per runtime takes envelopes off a queue and, for each:

1. asks the allow-list (below) — a refused event is logged as `event:refused
   {name, origin, reason}` and goes nowhere;
2. logs it by the contract's `log` policy, with its origin;
3. routes it. A **device command** becomes a `RuntimeCommand` for the host and
   is never delivered to a scene. `render` is a request for a render pass.
   `setCurrentScene` asks the host to select a scene. `turnOn` / `turnOff` ask
   the host for display power, and then the scene hears them. Everything else
   is delivered to the scene.
4. when the queue is empty, applies the render rule (`renderAfter`, below):
   at most one render request per drain.

The host supplies `EventHost` — request a render, select a scene, display
power, a runtime command, and how to reach a scene instance — and nothing else.
There are two hosts, not three: the Linux runner (`runner.nim`: many scenes, a
thread of its own), and `frameos/single_scene_host.nim` for a runtime that
holds one scene on one task, which the ESP32 and the preview share — they
supply who owns a scene switch, what a device command does there and where a
log line goes.
On Linux the other threads reach the runner's dispatcher through the bounded
`eventChannel`; what is sent on the runner thread itself (a scene's dispatch)
goes straight into the queue. The ESP32 and the preview have one task and no
channel. On the ESP32 the firmware owns rendering, scene selection and the
device commands, so its C edge (`main/fos_events.c`, one function for HTTP,
schedule, cloud, console and buttons) asks the same allow-list and does those
itself — without waiting for the runtime lock a 90-second render holds — and
hands everything else to the dispatcher.

The queue has two lanes: **input** (what a person did, arriving in bursts from
a driver) waits behind everything else, so a reboot or a scene switch is never
stuck behind a drag. Within a lane, order of arrival. A full lane drops the
newest event and counts it (`events:dropped`).

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
| `input` | `pointerMove`, `pointerDown`, `pointerUp`, `pointerCancel`, `wheel`, `tap`, `doubleTap`, `longPress`, `swipe`, `keyDown`, `keyUp`, `textInput`, `button` — and the old names `mouseMove`, `mouseDown`, `mouseUp` | Something a person did. `device` says with what: `keyboard`, `pointer`, `button`. See [Input](#input). |
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

The allow-list is asked by the dispatcher, of every envelope, whatever its
origin. An edge that can answer sooner asks the same question for a better
answer than a log line: the frame's HTTP routes (a 401; the backend picks its
credential by the same list), a dispatch node (`interpreter:dispatch:ignored`
with its node id), the scheduler, the hub client's `scene_event`, the cloud's
event route and schedule validator. What it comes to:

- The frame access key is printed on the frame's QR code. It may pick a scene;
  it may not `reload`, `restart`, `reboot` or `uploadScenes`.
- A scene is untrusted code (anyone's store scene). Same four.
- A schedule is data nobody validated. It may switch, render, power, reload
  and reboot; it may not `uploadScenes`.
- The lifecycle events are the host's to say, at the moment they are true.
  Nobody else may emit `init`, `open` or `close` (an admin session may, as a
  debugging tool).
- The cloud sends what has a hub verb (`cloud.verb`). `scene_event {name,
  payload}` is the generic one: `button`, `setSceneState` and custom events
  ride on it. Keys, pointers and gestures have none: the route answers 404
  `unsupported_event`. `cloud.since` is the FrameOS version whose frames know
  the verb; an older frame gets `cloud.before` where there is one.

**Custom events** may always be sent by the scene itself, the frame's drivers,
its HTTP API and the preview (`customEvents.origins`). A **schedule** or the
**cloud** may fire one only at a scene that says so — `origins` on the event's
declaration:

```json
"customEvents": [{"name": "nextPage", "origins": ["schedule", "cloud"]}]
```

Which origins can be opted into is `customEvents.declarableOrigins`. The edges
that cannot see the scene (the scheduler, the hub verb, a control plane's
schedule validator) let such an event through, and the dispatcher asks the
scene that is showing: an undeclared one is `event:refused` with `reason:
"undeclared"`.

A refused event is dropped and logged (`event:refused`,
`interpreter:dispatch:ignored` with `reason: "runtimeVerb"`,
`scheduler:refused` / `schedule:refused`), or answered 401/404 on HTTP.

The lists for input events are still wide: a schedule or a scene may say
`button`, because scenes in the wild use that to reuse a handler. Narrowing
one is a line in the contract and a fixture. The browser preview (`preview`)
says what a frame's drivers say: pointers, the wheel, keys.

### Payloads, units and the wire

`payload` lists each field with its type and, where a number means something,
its `unit`. `catalog: false` keeps a field out of the editor's filter and
dispatch forms; `filter: "more"` keeps it in the catalog but folded in the
event node ("More filters") until a filter is set, so a `button` node shows
its role and action and not the pin, the label, the hold time and the wake
flag. A unit whose values are a list the contract keeps (`button-role`,
`button-action`, `swipe-direction`, `pointer-type`) reaches the editor as the
field's `options`: a select, never a free text. `listenDefault` on a field is
what a listener with no filter on it hears: only events where the field
equals that value.

- **Pointer position.** Every pointer event a scene hears carries `x`, `y` in
  **scene pixels**, rotation and flip applied. On the wire — driver → host,
  preview → host, `POST /event/pointerMove` — both axes run **0..32767**
  across the panel (`pointer.wireMax`), whatever the device reports. The host
  converts, and a payload without a position is at the pointer's last one.
- `setSceneState {state, render}` — `state` is applied to the scene's public
  state; `render: true` asks for a render afterwards. In the editor its
  dispatch form is the scene's own fields (`sceneState: "payload"`).
- `setCurrentScene {sceneId, state}` — one that names the scene already
  showing applies `state` and renders, without a switch.
- The input payloads are under [Input](#input).

### Input

What a person did reaches a scene through one piece of the dispatcher,
`frameos/src/frameos/input_state.nim`, on every host: it keeps where each
pointer is and what it holds, the one cursor a mouse moves, which modifier
keys are down, what a key means under the frame's keyboard layout, and which
GPIO buttons are held — and out of that makes the events below, so a driver,
the preview or an HTTP request has to say only what it saw. Input is delivered
to a scene **only under the names it listens for**; its payload is built at
delivery, so a scene with no pointer listeners costs nothing per motion
report.

**Aliases.** `mouseMove`, `mouseDown` and `mouseUp` are the old names of
`pointerMove`, `pointerDown` and `pointerUp` (`aliasOf` in the contract). A
listener on an old name keeps hearing it, with the old, smaller payload
(`mouseDown {button}`); a listener on the new name hears the new one. Both may
listen, each hears its own. An old name arriving on the wire (a 2026.9.21
preview bundle, a `POST /event/mouseMove`) is the new event. Aliases are
forever: store scenes are versioned and immutable. The editor offers the new
names.

**Pointer.** `pointerMove {x, y, pointerId, pointerType, buttons}` on every
motion report (`coalesce: latest`, per pointer). `pointerDown` / `pointerUp`
add `button`: 0 left (and a touch, a pen tip), 1 right, 2 middle, 3 side,
4 extra, 5 forward, 6 back, 7 task; `buttons` is the mask of what is held
(`1 << button`). `pointerId` 0 is the one mouse cursor; a finger or a pen
keeps an id while it is down (`pointerType`: `mouse`, `touch`, `pen`). Two
fingers are two pointers. `pointerCancel {x, y, pointerId, pointerType}` is a
pointer that was down and is lost without a release: the input lane overflowed
between a down and its up, the device went away, the kernel dropped events. A
scene holding a drag lets go. `wheel {deltaX, deltaY, x, y}` is in notches;
`deltaY` is positive scrolling down.

**The cursor.** A relative mouse reports motion only, so the dispatcher owns
its position — in scene pixels, so it moves along the picture's axes on a
rotated frame — clamps it to the picture, and emits `pointerMove` for pointer
0. It starts at the centre and follows every pointer (a mouse picked up after
a touch continues from where the finger was). On a Linux frame with a screen
that redraws in a blink (a framebuffer, a HyperPixel) the runner draws it over
the frame already on the panel, without re-running the scene, for
`CursorHideMs` (5 s) after it last moved; never on e-paper or an upload target.

**Gestures.** Made by the dispatcher from a pointer's primary button, with the
contract's `gestures` numbers, so every host agrees: `tap {x, y, pointerId,
pointerType}` — down and up within `tapSlopPx` and `tapMs`; `doubleTap` — a
second tap within `doubleTapMs` of the first, in the same place (the first
tap is delivered too); `longPress {…, durationMs}` — held `longPressMs`
without moving, delivered while it is still held where the host ticks the
dispatcher (the Linux runner and the preview do; the ESP32 asleep in a render
does not, and delivers it on release), and then no `tap`; `swipe {direction,
x, y, startX, startY, …}` — down and up at least `swipeMinPx` apart, in one of
`left` / `right` / `up` / `down`. Gestures render `if-state-changed`, like a
button; the raw pointer events never do.

**Keyboard.** `keyDown {code, key, repeat, shift, ctrl, alt, meta,
linuxCode?}` and `keyUp` (no `repeat`). `code` is the physical key as the W3C
`KeyboardEvent.code` (`KeyA`, `ArrowLeft`, `Numpad1`) — layout-independent,
and what a browser produces for free; the contract's `keyboard.codes` maps the
Linux `KEY_*` number to it, and `linuxCode` keeps that number when a driver
sent one. `key` is what the key means: a named key (`Enter`, `Shift`,
`AltGraph`; `keyboard.named`) or the character it types under the frame's
keyboard layout (`keyboard.layouts`, the `keyboardLayout` frame setting: `a`,
`A`, `ä`, `@`), shift, caps lock and AltGr applied; `Unidentified` for a key
the tables do not know (a gamepad button). Auto-repeat is a `keyDown` with
`repeat: true`. `textInput {text}` follows every `keyDown` that types a
character (no Ctrl / Meta / left-Alt chord) — made by the dispatcher when it
mapped the key itself, sent by a browser preview from its own key. Dead keys
and compose are not supported. On a Linux frame the evdev driver **grabs**
keyboards (`EVIOCGRAB`) while the runtime runs, so the console never sees a
key meant for a scene, Ctrl+Alt+Del included, and lets go when it stops;
`inputSettings.grabKeyboard` (default on) turns that off. Keyboards and
pointers plugged in after boot are found (inotify on `/dev/input`).

**Buttons.** `button {pin, label, role, action, durationMs?, heldSeconds?, wake?, atMs?, level?}`.
One event, `button`, in two layers; `action` says which.

- **Hardware layer: `down` and `up`.** What the line did, delivered the moment
  the driver reports it: `down` on the press, `up` on the release with
  `durationMs`. For a scene that wants the key itself: a counter that counts
  every tap, hold-to-show.
- **Button layer: `press`, `doublePress`, `longPress`.** What the person
  meant, and each press is exactly one of them. `press` is a short press, once
  it is over and `buttons.doublePressMs` (350) has passed since its `up` with
  no second down, so it arrives 350 ms after the release. `doublePress` is the
  second down inside that window; the pair is that and nothing more (no
  `press`, no `longPress`), and a third down starts over. `longPress` is the
  `up` of a press held at least `buttons.longPressMs` (1000), once, right
  after that `up`, with the same `durationMs` and `heldSeconds`; nothing is
  delivered while a key is held, and a long press is not also a `press`.

A tap is therefore `down`, `up`, then `press`; a double tap `down`, `up`,
`down`, `doublePress`, `up`; a 2.2 s hold `down`, then `up` and `longPress`
(`heldSeconds` 2) together. **A listener with no `action` filter hears `press`
only** (`listenDefault`): every listener from before the layers existed is
exactly that. A fast double tap reaches such a listener as nothing, since it
is a `doublePress`; a scene that must count every tap listens for `down`.
Drivers until 2026.10.16 sent their edges as `press` / `release`, and until
then `press` was the down edge itself, `release` the up, `longPress` came
while the key was held and `repeat` every second after; the dispatcher still
takes those edges by their `level`.

Each event has its sound on an ESP32 with a buzzer, at the instant it
happens: a click on `down`, a lower one on `up`, two rising notes for a
`doublePress` (in place of its down click), a short falling pair for a
`longPress` (in place of its up click). A `press` adds none: its clicks were
the down and the up
(`embedded/esp32/README.md`, "Button beep").

`atMs` is when the driver saw the edge, in milliseconds on the frame's
monotonic clock (the one the dispatcher's tick reads: `CLOCK_MONOTONIC` on
Linux, `esp_timer` on the ESP32), on `down` and `up` and passed on to the
`press` and `doublePress` they make. Every rule is timed from it: the hold
from the `down`'s `atMs` to the `up`'s, the double-press window between an
`up` and the next `down`, and the layer advances to an edge's time before the
edge applies, never to the moment it was delivered. An ESP32 drains its button
queue only between render passes, so a tap made during a 30 s refresh used to
arrive as a 30 s hold; now it is a tap, two taps in that time a
`doublePress`, and a hold through the refresh a `longPress` with the hold it
had. A `press` needs a tick to be delivered, so the hosts tick while a key is
down or a tap is in its window: the ESP32 waits in 50 ms slices then, and
does not deep-sleep until the decision is delivered; the preview ticks every
50 ms.

Debounce is kept to contact bounce, 30 ms on both kinds of frame: the ESP32
takes the first change as the edge and ignores changes for 30 ms after it, a
Pi asks lgpio for 30 ms of steady level. Until 2026.10.16 they waited 80 ms and
100 ms, which lost quick taps and the second tap of a quick double.

Anything that is not an edge (no `level`, and an `action` other than `down` /
`up`) is someone saying a button was pressed: HTTP, the cloud, a schedule, a
scene. It moved no line and has nothing to time, so it is delivered as said,
no `action` meaning `press`. `role` is what the button means:
`buttons.roles`: `primary`, `secondary`, `next`, `prev`, `up`, `down`, `back`,
`menu`, `refresh`. A store scene filters on `role: "next"` instead of a
silkscreen label: a frame configures one per button (`gpioButtons[].role`,
Linux frames), and `buttons.roleByLabel` is the default for a button without
one (`A` primary, `B` next, `C` prev, `D` back, `BOOT` primary, `KEY1` next,
`LEFT` prev, `RIGHT` next, `OK` primary, `HOME` menu, `EXIT` back, …). `wake:
true` marks the replayed `down` that booted an ESP32 out of deep sleep; it is
a `press` at once (no second down can have come while the chip slept), and
there is no hold to follow it. `level` is the line on an edge (0 down: the
line is pulled up).

**Privacy.** Key events are logged by name only (`log: name-only`), never with
what was typed; pointer events not at all.

**Hosts.** Pointer and keyboard events are described for every host and are
`hosts.esp32: false`: no board in the tree has a keyboard or touch, so the
ESP32 compiles only the button half of the input state (and none of the
alias or keyboard tables) — the pointer, keyboard and gesture code is behind
`when not defined(frameosEmbedded)`, and the contract's generated lookups are
procs, never inline iterators (an iterator's loop body is copied per `yield`;
with eighty payload keys that was 20 KB of flash in the interpreter). The
preview forwards the browser's pointer, wheel and keyboard from the focused
canvas (`frameos/wasm/src/pointer.ts`, kept twice with
`frontend/src/utils/previewPointer.ts`); a bundle from before input v2 says so
(`ready` without `inputEvents`) and gets the old mouse events and no keys.

**The driver boundary.** The Linux evdev driver sends input as a small C
struct (`DriverInputEvent`, `frameos/driver_abi.nim`) through a value
channel — nothing allocated on the way, nothing a second thread could hold —
and a driver `.so` through the optional `frameos_driver_set_input_hook`
symbol; a `.so` from before it keeps sending the old JSON events, which are
aliases. `drivers/evdev/translate.nim` is the pure translator (kernel
`input_event`s in, structs out; multitouch protocol B, pens, wheels, repeats)
and `tests/test_translate.nim` its evtest dumps; `tests/test_input_state.nim`
is the dispatcher's half.

**Scenes to try it with:** `repo/scenes/samples/Touch test` and
`Keyboard test` (also `e2e/scenes/inputTouch.json` and `inputKeyboard.json`,
which the snapshot harness drives with their `e2eEvents`).

### Policy columns

- **`log`** — what the frame log says when a host drains the event. `full`:
  name and payload. `name-only`: keys — the log is stored by the control plane
  and may be sent to the cloud, so from the moment a scene has a text field
  anything else makes the frame a keylogger. `none`: pointer events, one per
  motion report.
- **`coalesce`** — `latest`: consecutive queued events of this name collapse
  to the newest (`pointerMove`, per pointer; a relative mouse's counts add
  up), and the first other event behind them is kept in order. A full input
  lane drops the newest event — except a `pointerUp` or `pointerCancel`, which
  evicts a queued move instead, and when there is none, what is down gets a
  `pointerCancel` at the next drain.
- **`renderAfter`** — whether the frame renders once the event is handled,
  decided by the dispatcher when its queue is empty: `never` (pointer events: a
  frame does not render because a finger moved — a scene that wants a picture
  dispatches `render`), `always`, or `if-state-changed` (a handler changed the
  scene's state). One exception, because without it a slideshow would never
  stop refreshing: an event dispatched **from inside a render** (or an `init`,
  `open` or `close`), and whatever its handlers dispatch in turn, is the scene
  talking to itself and does not render by changing state. It renders by
  dispatching `render`. State an app keeps to itself is not scene state: say
  `render` for that too.
- **`hosts`** — whether a host produces or handles the event at all. Pointer
  and keyboard events are described for every host and are
  `hosts.esp32: false`: no board in the tree has touch, and nothing is built
  for hardware that is not there.
- **`aliasOf`** — an old name of another event; **`synthesized`** — made by
  the dispatcher out of other events (a tap, a textInput). See [Input](#input).
- **`schedule`** — the Schedule panel offers the event, under this label.
  `endsRuntime`: the runtime does not survive it, so the scheduler persists
  the minute it fired in, or it would fire again after the restart.

### Dispatch from a scene

What a handler dispatches is **queued**: it is delivered after the run that
dispatched it, never inside it — on every host. A run may dispatch 64 events;
the first one over is logged (`reason: "dispatchBudget"`), the rest are
dropped. `render` dispatched while handling `render` is ignored
(`reason: "renderSelfDispatch"`). A scene whose handler re-dispatches its own
event never empties the queue, so one drain delivers at most 32 events and
hands back with the rest still queued: the render loop (or the host's one task)
gets its turn, and nothing is dropped.

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

The dispatcher is shared, so these are about what a host *is*, not about what
an event means:

| Behaviour | Linux | ESP32 | wasm preview |
|---|---|---|---|
| Display power (`turnOn` / `turnOff`) | the driver acts, then the scene hears it | nothing to switch (e-paper holds its image unpowered); the scene hears it | nothing to switch; the scene hears it |
| Device commands | all five | `metrics` has no host; the rest are the firmware's (`fos_events.c`) | none: logged and ignored |
| When a queued event is delivered | the runner thread's message loop | on the task that sent it, before `frameos_nim_send_event` returns; what a render dispatched, right after the render | before `frameos_wasm_event` returns; right after a render |
| An event aimed at a scene that is not the current one (`target`) | delivered if that scene is in memory | dropped: one resident scene | dropped |
| An event before the current scene is built | not a state the runner has: scenes are built when selected | the event builds it (`single_scene_host.send`), so a boot's replayed button press reaches the scene it woke; a scene switch is served without building the scene being left | same as the ESP32 |
| `close` on `reload` / `uploadScenes` | not sent | not sent | — |

A frame on firmware older than `cloud.since` does not know `scene_event`: the
cloud sends it `cloud.before` where the contract has one (`setSceneState` rides
on `set_current_scene`, Linux only, as before) and refuses the rest.

A fixture runner for the wasm *host* (the bundle under node) is still missing:
the cloud's CI runs the wasm runtime of the pinned release, not of the tree, so
until a job builds the bundle from source such a runner would test last month's
code. The dispatcher the bundle compiles is covered by `test_event_loop.nim`.
