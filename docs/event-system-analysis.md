# The FrameOS event system: audit and proposal

Written 2026-09-20 against local `main` (`111a7103a`) plus `origin/main`
(`94c91e42b`, which adds #508, browser-preview pointer input). Line numbers are
from those trees. Everything under "Findings" was read out of the code; nothing
here was bench-tested, and the items that need hardware to confirm say so.

**Status.** The P0 bug list (§5) shipped together with this document, so §2–§3
describe the tree *before* it. Fixed since: §3.3's `close` payload, the ESP32's
scene-dispatched `setCurrentScene` and its render-on-every-press; §3.4's first
and third bullets (`init`/`open` now reach top-level interpreted scenes on all
three hosts, `close` too, with no payload); §3.5 #1–#3, #9 and #12 (relative
mice, key repeat, tool buttons, key payloads in the log, a tested translator);
and the small catalog/linter/duplicate items at the end of §3.1. `wheel` is a
new event.

P1 (§5) shipped next: `docs/events-contract.json`, its generator, the prose
spec `docs/events.md` and the conformance corpus `docs/event-fixtures.json`
with runners. §2.1 ("the catalog") and the table in §3.1 describe the tree
before it — the thirteen lists are generated tables or imports of them now,
and `docs/events.md` says which.

P2 (§5) shipped after that: `frameos/src/frameos/event_loop.nim` is the one
dispatcher all three hosts compile. §2.2 ("transport, per host"), §3.2, §3.3
and §3.7 describe the tree before it; `docs/events.md` describes it now, and
its "Known host differences" is what is left of §3.3. §4.5 onwards (input v2,
routing, focus, timers, the driver thread) stands as the plan.

Scope: the scene event layer on every host that runs scenes — the Linux runtime
(Raspberry Pi), the ESP32 firmware, the browser wasm preview — and the control
planes and editor that feed it. The Pico thin client runs no scenes and has no
event layer; it is out of scope.

## 1. Verdict

The instinct is right: there is no spec. What exists is a **14-row JSON file that
the editor uses as a node picker** (`frontend/schema/events.json`), and the
device runtimes do not read it. Every behaviour a scene author depends on —
which events fire, in what order, with what payload, in what units, whether a
render follows, what happens when a handler dispatches again — is defined by
whichever host's code you happen to be reading, and the three hosts answer
differently.

The layer works for what it has been asked to do so far: "a GPIO button
re-renders the scene" (that is 8 of the 8 input listeners in every sample scene
in the repo; nothing in the repo listens for a key or a mouse event). It is not
a base for keyboard, pointer, focus or widgets. Concretely:

1. **One string namespace carries four unrelated things**: device commands
   (`reload`, `restart`, `reboot`, `uploadScenes`, `metrics`), scene lifecycle
   (`init`, `open`, `close`, `render`), scene commands (`setSceneState`,
   `setCurrentScene`, `turnOn`, `turnOff`) and input (`keyDown`, `mouseMove`,
   `button`). Security is three separate deny-lists bolted on afterwards.
2. **Three hosts, three dispatchers**, with different ordering, re-entrancy,
   render-after-event and scene-switch semantics (table in §3.3). The ESP32
   re-implements the command subset in C, three times.
3. **Lifecycle is broken for the default execution mode**: a top-level
   interpreted scene never receives `init` or `open`. Only legacy compiled
   scenes do.
4. **The input driver has real bugs**: a relative (i.e. every ordinary USB)
   mouse produces no movement and a log line per motion event; keyboard
   auto-repeat is reported as `keyUp`; no hotplug; no wheel, modifiers, text,
   multitouch; every keystroke is written to the frame log and shipped to the
   control plane.
5. **Flow control is a single thread**: input waits for the render *and* the
   panel refresh. There is no routing below "the current scene" — an embedded
   child scene never sees input, there is no hit-testing, focus, timer, or
   long-press.
6. **At least 13 hand-kept lists** of event names or of the `context` shape
   exist across the repo, and several already disagree (§3.1).

The good news is that the repo already has the pattern that fixes this, twice:
`docs/cloud-frames-contract.json` + `fos_cloud_contract_gen.h` + fixtures for
the hub verbs, and `docs/scene-execution-fixtures.json` for the execution rule.
The event layer needs the same treatment — one machine-readable contract,
generated constants for Nim/C/TS/Python, and a fixture corpus every host must
pass — and then one dispatcher in Nim that all three hosts share. §4 is that
proposal; §5 orders the work.

## 2. What exists today

### 2.1 The catalog

`frontend/schema/events.json`: `init, render, open, close, keyDown, keyUp,
mouseMove, mouseDown, mouseUp, turnOn, turnOff, button, setSceneState,
setCurrentScene`. Per entry: `name`, `description`, `canListen`, `canDispatch`,
`fields[]` (name/label/type/required). No units, no direction, no origin, no
host support, no ordering, no version.

Real readers: the editor (`frontend/src/utils/frameEvents.ts`), the legacy
compiled-scene codegen (`backend/app/codegen/scene_nim.py:16-22` — via a
CWD-relative path that silently yields `[]` on a miss, producing payload-less
dispatch nodes with no diagnostic), and the cloud AI context generator
(→ `ai-context.json` → the system prompt and `scene-lint.ts`). **No device
runtime reads it.** `canDispatch`/`canListen` are editor hints only; nothing on
a device enforces them.

Scenes can also declare `customEvents` (editor-only concept,
`frontend/src/types.tsx:1026`). The runtime knows nothing about them; they work
because the runtime dispatches any string to any listener with that string.

### 2.2 Transport, per host

| | Linux (Pi) | ESP32 | wasm preview |
|---|---|---|---|
| Entry | `sendEvent` → `eventChannel` (bounded 1000, drop-newest, counter) `channels.nim:116-156` | `frameos_nim_send_event` → `embeddedEventHook` `embedded_runtime.nim:253` | `frameos_wasm_event` → same hook `wasm_main.nim:231` |
| Delivery | **Queued**; runner thread drains it between renders `runner.nim:600-792` | **Synchronous**, on the caller's stack | **Synchronous** |
| Payload | `JsonNode`, deep-copied per send (ORC channel moves) | `JsonNode` parsed from a C string | `JsonNode` parsed from a JS string |
| Driver → host | `.so` ABI: JSON text as `cstring` (`driver_abi.nim`), re-parsed by `drivers.nim:142-153` | C structs → `snprintf` JSON | `postMessage` → JSON string |

So one mouse motion on a Pi is: evdev struct → `JsonNode` → `$` → `cstring` →
`parseJson` → `copy()` → channel → runner → (for a JS listener) `jsonToJS`.
Four allocations of a tree per event, at up to 125–1000 Hz from a mouse. It is
fine for buttons; it is the wrong shape for pointer streams.

### 2.3 Producers

| Producer | Events | Where |
|---|---|---|
| evdev driver (own thread, 10 ms poll) | `mouseMove` (0..32767), `mouseDown`/`mouseUp` `{button}`, `keyDown`/`keyUp` `{key, code}` | `drivers/evdev/evdev.nim` |
| gpioButton (lgpio alert thread) | `button` `{pin, label, level}` | `drivers/gpioButton/gpioButton.nim:18-24` |
| ESP32 buttons (20 ms poll task → queue of 16 → render task) | `button`, same payload | `embedded/esp32/main/fos_buttons.c` |
| Scheduler | any name from the schedule, minus a deny-list | `scheduler.nim:139-162`, `fos_schedule.c:286-322` |
| HTTP on the frame | any name: `/event/@name`, `/api/frames/@id/event/@name`, `/api/frames/@id/event` | `web_routes.nim:375-398`, `admin_api_routes.nim:217-263`, `fos_http.c:1900-1945` |
| Cloud hub client | `uploadScenes`, `reload`, `restart`, `setCurrentScene`, `render`, `turnOn/Off` — from verbs, no generic event verb | `hub_client.nim:1322-1391`, `fos_cloud.c:2500+` |
| Scenes (`dispatch` node) | any name, minus a deny-list, 64 per run | `interpreter.nim:752-876` |
| Portal / device flow / settings | `setCurrentScene`, `render`, `restart` | `portal.nim`, `device_flow.nim`, `settings_apply.nim` |
| Browser preview | `button`, `setSceneState`, listener-node buttons; since #508 `mouseMove/Down/Up` | `frameos/wasm/src/pointer.ts`, `frontend/src/utils/previewPointer.ts` |

### 2.4 Consumers

**The Linux runner** (`runner.nim:653-767`) is a `case event` that is both the
command interpreter and the scene dispatcher: `render`, `turnOn`, `turnOff`,
`metrics`, `mouseMove` (rescales 0..32767 into scene pixels, honouring
rotate/flip), `setCurrentScene` (resolves `uploaded/` ids, dispatches `close`
to the old scene, inits the new one, dispatches `setCurrentScene` to it),
`reload`, `restart`, `reboot`, `uploadScenes`. Anything that does not
`continue` then goes to `dispatchSceneEvent` for the **current scene only**.
Consecutive `mouseMove`s are coalesced to the newest.

**The interpreter** (`interpreter.nim:1593-1667`) applies `state` for
`setSceneState`/`setCurrentScene`, prepares the canvas for `render`, then runs
every `event` node whose `keyword` matches and whose `config` filter
(string-compare per payload key; legacy `data.label`) passes. A filtered-out
event logs `runEvent:noListenerMatched`. Child scenes (`scene` nodes) receive
an event only if the parent's flow for that same event walks through the scene
node (`interpreter.nim:1120-1126`) — in practice that means `render` only.

**JS** sees `context.event` and `context.payload`
(`js_runtime/app_runtime.nim:668-674`). JS apps export `init`/`get`/`run`;
there is no `onEvent`, no way to dispatch from JS, no handler registration.

**Control planes.** The backend forwards any event name verbatim with no
validation (`backend/app/api/frames.py:1477-1539`); only `uploadScenes` has a
payload validator. The cloud route maps six names onto hub verbs and 404s the
rest, **including `setSceneState` and every custom event**
(`cloud/apps/auth-web/app/api/frames/[frameId]/event/[eventName]/route.ts:112-252`).
The one arbitrary-name channel from the cloud to a device is `set_schedule`,
whose validator accepts any ≤63-char `event` string
(`cloud/apps/auth-web/src/lib/frames.ts:510-577`).

## 3. Findings

### 3.1 No source of truth — the lists

Beyond `events.json` and its generated twin in `ai-context.json`:

| # | Where | What | Drift |
|---|---|---|---|
| 1 | `server/auth.nim:371` `ControlEvents` | `reload restart reboot uploadScenes` | none of these are in the catalog |
| 2 | `scheduler.nim` `schedulerRefusedEvents` / `schedulerRebootEvents` | what a schedule may not fire | separate from #1 and #3 |
| 3 | `interpreter.nim:23` `sceneRefusedDispatchEvents` | what a scene may not dispatch | "keep in step with scheduler.nim" is a comment |
| 4 | `backend/app/utils/frame_http.py:222` `_CONTROL_EVENT_NAMES` | Python copy of #1 | |
| 5 | `runner.nim:653-766` | the `case` — the actual command set, incl. `metrics` | `metrics` is in no list |
| 6 | `fos_http.c:1917-1940`, `fos_schedule.c:294-321`, `fos_cloud.c` | three C re-implementations of the command subset | each handles a different subset |
| 7 | cloud event route `switch` | `render metrics turnOn turnOff setCurrentScene uploadScenes` | no `setSceneState`; backend forwards it |
| 8 | `frontend/src/utils/scheduleEvents.ts` | `setCurrentScene restart reboot` | "a UI allowlist, not a protocol one" |
| 9 | `livePreviewLogic.tsx:191` and `frameos/wasm/src/types.ts:116` | `LIFECYCLE_EVENTS`, twice, unlinked | both omit `turnOn`/`turnOff` |
| 10 | `EventNode.tsx:38` vs `appNodeLogic.ts:453` vs `diagramLogic.tsx:1781` | "events whose fields are the scene's state" | three different sets |
| 11 | `codeNodeTypeDeclarations.ts:46`, `appTypeDeclarations.ts:122`, `scene-convert/src/prompt.ts:90`, `scene-convert/src/nim-expression.ts:903`, `docs/js-apps-and-code-nodes.md:23` | the shape of `context` | five spellings |
| 12 | `log.py:309`, `ha/sync.py:34`, `framesModel.tsx:119`, `controlLogic.tsx:431-442` | log-event names that mean "the scene changed" | four lists, all different |
| 13 | `pointer.nim` `PointerRange`, `image.nim` `PointerAxisMax`, `pointer.ts`, `previewPointer.ts` | the 0..32767 pointer contract | four constants; the TS pair is held together by one test |

Small, already-wrong details that fall out of this: `setCurrentScene`'s
description in the catalog is a copy of `setSceneState`'s and is quoted
verbatim into the AI system prompt; `scene-lint.ts:441-450` ignores
`customEvents` and warns on legitimately declared ones; `duplicateScenes.ts:50`
does not remap scene ids in `event` node filters; `ConnectionAppNextPrev` omits
`dispatch` as a chain source; `Counter/scenes.json` carries a `data.button` key
nothing reads, with values swapped relative to its `label`.

### 3.2 One namespace, four kinds of message

`/event/restart` and `/event/keyDown` are the same route. That is why there are
three deny-lists: each was added after someone noticed an origin that should
not be able to say a particular word (the frame access key must not
`uploadScenes`; a schedule must not; a store scene must not). The model is
"everything is allowed, subtract". The next origin — a JSX `onClick`, a widget
library, an MQTT bridge — starts from "may `reboot`" again.

The same conflation makes the catalog lie about direction. `turnOn` is both "a
command to the display driver" and "an event a scene can listen for";
`setCurrentScene` is a command to the runner that is *also* delivered to the
new scene as an event in place of `open`.

### 3.3 The hosts disagree

| Behaviour | Linux | ESP32 | wasm |
|---|---|---|---|
| A handler dispatches an event | queued, runs after the current run | runs **now**, nested inside the current run | runs now — unless already inside a handler, then **silently dropped** (`handlingEvent` latch) |
| Re-dispatch limit | 64 per run; loop yields to render every 32 | 64 per run **and** depth 4 | depth 1 |
| `dispatch render` during `render` | ignored (logged) | ignored | ignored |
| Render after an event | never, unless the scene dispatches `render` | a button press **always** requests a render before the event is even delivered (`fos_buttons.c:85`); HTTP/schedule only if the scene asked | **always**, except pointer events (#508) |
| Scene dispatches `setCurrentScene` | switches scene, `close` to old | **does not switch**: goes to the *current* scene's `runEvent`, which applies `payload.state` to it. Switching exists only in the C paths (HTTP, schedule, cloud) | switches (special-cased in the hook) |
| `close` | sent to old scene, carrying the *new* scene's `setCurrentScene` payload (catalog: no fields) | never | never |
| `turnOn`/`turnOff` | drives the driver, then also delivered to the scene | delivered to the scene only; no display action | delivered only |
| `reload`/`restart`/`uploadScenes` from a schedule | refused by list | `restart`/`reboot` → `esp_restart`; others go to the scene | n/a |
| `mouseMove` units at the scene | scene pixels | n/a (no pointer) | scene pixels (#508) |
| `mouseMove` units on the wire (`/event/mouseMove`) | 0..32767 — undocumented; the catalog says "integer" | — | 0..32767 |
| `button` edges | falling edge only, 100 ms lgpio debounce | press only, 80 ms debounce, plus a replayed wake press | synthesized `level: 0` |
| Event while rendering | waits in the queue | the C side defers to the render task | runs inline |

The catalog says `button` fires "when a GPIO button is pressed or released".
No host sends a release.

The ordering difference in the first row is the one that will bite a widget
layer: `onClick → setState → dispatch("render")` inside a handler that itself
was reached from a dispatch behaves three ways.

### 3.4 Lifecycle is not what the catalog says

- **`init` and `open` never fire for a top-level interpreted scene.** The only
  `event: "init"` runs in the interpreter are for *child* scenes
  (`interpreter.nim:1072`, `:1506`); `open` appears nowhere in `frameos/src`.
  The runner, the embedded runtime and the wasm host all call
  `exportedScene.init(...)` and go straight to `render`. Only the legacy
  compiled codegen fires them (`scene_nim.py:1316-1320`, `:1396-1400`).
  Interpreted is the default execution mode, so for practical purposes these
  two catalog rows are dead — and the editor offers them.
- A scene that is switched *back to* (already in `self.scenes`) gets neither
  `init` nor `open`; it gets a `setCurrentScene` event. There is no "I became
  visible again" signal, which is what `open` is documented to be.
- `close` exists on Linux only and carries the wrong payload.
- There is no teardown event on `reload`/`uploadScenes`
  (`cleanupSceneRuntime` just drops the scene).

### 3.5 Input: evdev

Read from `drivers/evdev/evdev.nim`; items marked † want a bench check.

1. **Relative mice do not work.** `getListener` accepts a device because it has
   `EV_REL`, but the read loop handles `EV_SYN`, `EV_MSC`, `EV_KEY`, `EV_ABS`
   and sends everything else to `log({"event": "event:unknown", …})`. An
   ordinary USB mouse therefore delivers clicks, no movement, and **one log
   line per motion event** into a 5000-slot log channel that is shipped to the
   control plane. Touchscreens and absolute digitizers are the only pointers
   that work. †
2. **Key auto-repeat is reported as `keyUp`.**
   `let name = if ev.value == 1: "keyDown" else: "keyUp"` — the kernel sends
   `value == 2` for repeat. Hold a key and the scene sees
   `keyDown, keyUp, keyUp, keyUp, …`.
3. **Every button code in `BTN_MISC..BTN_GEAR_UP` is a mouse button.** Gamepad
   buttons, `BTN_TOOL_FINGER`, `BTN_TOOL_PEN` arrive as `mouseDown {button: -1}`.
   A touchpad sends two "mouse downs" per tap.
4. **No hotplug.** `/dev/input/event*` is walked once at start. A keyboard
   plugged in after boot is never seen; when the last device goes away the
   thread exits for good ("All input devices gone, stopping").
5. **No wheel** (`REL_WHEEL`/`REL_HWHEEL` fall into #1's log branch), no
   multitouch (`ABS_MT_*` ignored — works only through the kernel's
   single-touch emulation), no pressure, no pen.
6. **Keyboard payload is a kernel constant name**: `{"key": "KEY_A", "code": 30}`.
   No modifiers, no layout, no text, no `repeat` flag. A scene cannot tell `a`
   from `A`, cannot read a typed string without shipping its own keymap, and
   `code` is the Linux number, which no other host can produce.
7. **`mouseDown`/`mouseUp` carry no position.** A scene has to have listened to
   `mouseMove` and stored x/y in state first (that is exactly what the
   touch-test recipe in `docs/manual-testing-todo.md` does). With move
   coalescing in the runner the last move before a down is preserved, so it is
   correct — just hostile.
8. **All devices feed one anonymous pointer.** There is no device or pointer
   id; a touchscreen and a mouse interleave into one stream.
9. **Keystrokes are logged and uploaded.** `runner.nim:650-651` logs every
   non-`mouse*` event with its payload through `logSignal`, which bypasses the
   fast-render log pause. The moment a scene has a text field, what is typed
   into it is in the frame log, the backend database and (with
   `telemetry:logs`) the cloud.
10. **The device is not grabbed** (`EVIOCGRAB`). The service `Conflicts=` with
    `getty@tty1`, so there is no login prompt eating keys, but the kernel VT
    still gets them: Ctrl+Alt+Del reaches systemd's `ctrl-alt-del.target`,
    SysRq works, and on a framebuffer console keystrokes can echo. †
11. **10 ms sleep-poll** over non-blocking fds instead of `poll()`. Harmless on
    a Pi 4; a measurable idle cost on a Zero.
12. Tests cover `scalePointerAxis` only (`tests/test_pointer.nim`). The
    event-translation loop — where bugs 1–3 live — has none, because it is
    welded to libevdev.

### 3.6 Input: GPIO buttons

- Press only (see §3.3). No release, so no hold duration, no long-press, no
  chord. No repeat. `docs/ui-todo.md` plans focus navigation on exactly these
  buttons; "hold to go back" is not expressible today.
- Linux: the lgpio alert callback runs on lgpio's own pthread, builds a
  `JsonNode` there and reads a module-level `ref` `Table` (`pinLabels`). The
  table is write-once so it is not the AGENTS.md cross-thread-ref crash, but it
  is a Nim allocation on a thread Nim did not create; worth a `-d:useMalloc`
  four-thread test of the kind AGENTS.md prescribes. †
- ESP32 sends `fos_client_render_now()` on every press whether or not any scene
  listens (on a Spectra panel that is a 20–30 s refresh for nothing).
- The filter is the scene author's only tool, and it compares *labels*, which
  are per-frame configuration. A store scene that filters on `"A"` is dead on a
  board whose buttons are labelled `BOOT`/`KEY1`. The interpreter's
  `noListenerMatched` log is the mitigation; a semantic role (`primary`,
  `next`, `prev`, `back`) is the fix.

### 3.7 Flow control

- **Input latency = scene render + panel refresh.** Both loops share one
  thread and `drivers.render` is synchronous (`runner.nim:404`, "TODO: render
  the driver part in another thread"). On e-paper a keypress waits up to ~30 s
  to even be *read*; on a 60 Hz framebuffer it waits one full scene render.
- **Overflow drops the newest event**, of any kind. A burst of `mouseMove`
  while a render blocks the queue (1000 slots ≈ 1–8 s of mouse) can drop the
  `mouseUp` that ends the drag; the scene is then stuck "pressed". Coalescing
  happens at the consumer, after the queue, so it does not protect the queue.
- **No priorities.** A `reload` from the control plane queues behind 900 mouse
  moves.
- **Routing stops at the current scene.** No delivery to child scenes, no
  hit-testing, no capture/bubble, no focus, no "handled" — every matching
  listener always runs.
- **No timers.** The only clock is `refreshInterval`/`nextSleep`, i.e. a
  render. "Do X 500 ms after this press" (debounce, long-press, double-tap,
  auto-hide an overlay) cannot be written. PR #496 (scene rhythm) gives child
  scenes their own *render* due-times, which is adjacent but not this.
- **Event → state → render is convention, not contract.** A handler must end in
  `dispatch render`, except on wasm (automatic) and for ESP32 buttons
  (automatic, early). Scenes written against the preview over-render on a
  frame; scenes written against a frame look fine in the preview either way.
- **Filters are string equality on top-level payload keys.** No ranges (a
  rectangle for a touch target), no key combos, no `in`.

### 3.8 Typing and the editor

- Payloads are untyped `JsonNode` end to end; `fields[]` in the catalog are for
  the editor's filter inputs, which are all plain text boxes whatever the
  field type.
- The edge-based way to read a payload field (`code/context.payload.x` source
  handles on the event node) is deprecated in the editor ("keep showing nodes
  that are connected"); the replacement is "read `context.payload` in code",
  with the five-way-inconsistent typings of §3.1 #11 and no per-event payload
  type, so Monaco offers `payload: any`.
- The canvas node picker offers non-listenable events as listeners; the Events
  panel filters them. 
- No sample scene, template or e2e scene uses a key or pointer event, so
  nothing exercises them: not the snapshot harness, not the AI evals, not the
  linter.

## 4. Proposal

Design goals, in priority order: (1) one contract, generated everywhere;
(2) identical semantics on all three hosts, proved by shared fixtures;
(3) commands separated from events, with an allow-model by origin;
(4) an input model that the JSX/widget plan in `docs/ui-todo.md` can sit on;
(5) old scenes keep working — every current name stays valid as an alias.

### 4.1 The contract: `docs/events-contract.json`

Promote the catalog out of `frontend/schema/` and make it the spec. Per entry:

```jsonc
{
  "name": "pointerDown",
  "class": "input",            // lifecycle | input | scene-command | device-command | notification
  "aliases": ["mouseDown"],    // delivered under both names for one deprecation window
  "payload": {                 // JSON Schema subset → generates TS types + Monaco d.ts + lint
    "x": {"type": "integer", "unit": "scene-px"},
    "y": {"type": "integer", "unit": "scene-px"},
    "button": {"type": "integer", "enum": [0,1,2,3,4]},
    "buttons": {"type": "integer"},
    "pointerId": {"type": "integer"},
    "pointerType": {"enum": ["mouse","touch","pen"]}
  },
  "wire": {"x": "0..32767", "y": "0..32767"},   // only where wire ≠ delivered
  "origins": ["driver", "preview", "http:write"], // who may emit — ALLOW list
  "listen": true,
  "renderAfter": "never",      // never | always | if-state-changed
  "coalesce": "latest",        // none | latest
  "log": "name-only",          // full | name-only | none
  "hosts": {"linux": true, "esp32": false, "wasm": true},
  "since": "2026.10.0"
}
```

Generated from it, the same way `fos_cloud_contract_gen.h` is generated from
the hub contract: `frameos/src/frameos/events_gen.nim` (name consts, class,
origin masks, coalesce/log/render policy tables), `fos_events_gen.h`,
`frontend/src/generated/events.ts` (names as a union + payload interfaces, fed
to both Monaco declaration files so `context` has one shape and
`context.payload` narrows on `context.event`), a Python module for the backend,
and the AI context. Lists 1–13 in §3.1 become imports or disappear.

Alongside it, **`docs/event-fixtures.json`**: scripted sequences — "scene A
with these nodes; inject these events from these origins; expect this ordered
trace of listener runs, state, render requests, refusals". Runners: a Nim test
for the shared dispatcher (covers Linux and ESP32 since both compile it), the
wasm bundle under node, and the cloud/backend routes for the origin matrix.
"Add a case here first; a runner that disagrees is the bug" — the rule that
already governs `scene-execution-fixtures.json`.

And **`docs/events.md`**: the prose spec — lifecycle order, delivery
guarantees, units, the render rule, the routing rule. Short, normative, and
the thing `docs/ui.md` later builds on.

### 4.2 Split commands from events, and tag every message with its origin

The envelope becomes `{name, payload, target?, origin, seq, tMono}` where
`origin ∈ driver | preview | scene | schedule | http:write | http:admin | cloud
| system`. The producer's entry point sets `origin`; it is never taken from
the payload.

- **Device commands** (`reload`, `restart`, `reboot`, `uploadScenes`,
  `metrics`) leave the scene namespace. They keep their HTTP routes for
  compatibility, but internally they are a `RuntimeCommand` enum handled before
  scene dispatch and never delivered to a scene. Permission is
  `contract.origins`, checked in one place — the three deny-lists and their
  Python twin go away, and a new origin starts with nothing.
- **Scene commands** (`setSceneState`, `setCurrentScene`, `render`,
  `turnOn`/`turnOff`) stay dispatchable by scenes. What the scene *hears* is a
  lifecycle notification, not the command: `setCurrentScene` → old scene gets
  `close`, new scene gets `open`; `turnOff` → `displayOff` notification after
  the driver acted.
- The cloud gains one verb, `scene_event {name, payload}`, accepted only for
  contract entries whose `origins` include `cloud` plus the target scene's
  declared `customEvents`. That closes the `setSceneState`/custom-event gap
  (§2.4) without reopening "any string".

### 4.3 One dispatcher, in Nim, for all hosts

New `frameos/src/frameos/event_loop.nim`, compiled into Linux, ESP32 and wasm:

- A small ring queue (values, not refs, for input — see §4.5) with the
  contract's coalescing applied **at enqueue** (a `pointerMove` replaces a
  queued `pointerMove` for the same pointer; `pointerUp` is never dropped — if
  the queue is full it evicts a move, and if a down/up pair must be lost the
  scene gets `pointerCancel`). Two lanes: commands ahead of input.
- **Queued delivery everywhere.** A dispatch made inside a run is appended and
  delivered after that run returns. That is today's Linux behaviour; the ESP32
  and wasm hosts get it by draining the queue at the end of
  `frameos_nim_send_event` / the render pass. The depth-4 guard and the
  `handlingEvent` latch are deleted; the 64-per-run budget remains the one
  limit, identical on all hosts.
- The host supplies four callbacks and nothing else: `requestRender()`,
  `selectScene(id)`, `displayPower(on)`, `runtimeCommand(cmd)`. The ESP32's
  three C switch statements (`fos_http.c`, `fos_schedule.c`, `fos_cloud.c`)
  collapse to `frameos_nim_send_event(origin, name, payload)`; scene switching
  from a `dispatch` node starts working on the ESP32 as a consequence.
- **The render rule is the contract's `renderAfter`**, defaulting to
  `if-state-changed`: after the queue drains, if any handler changed scene
  state (the interpreter already detects this for `setSceneState`) or
  dispatched `render`, request one render. Hosts stop having opinions; the
  ESP32 stops refreshing e-paper for a button nobody listens to; scenes that
  end in `dispatch render` still work.

### 4.4 Lifecycle, fixed and tested

`init` (once per scene instance, after apps init) → `open {sceneId, reason:
boot|switch|reload|wake}` (every time the scene becomes current, including
switching back) → `render`* → `close {reason}` → (`destroy` on unload). Fire
them from the shared dispatcher so interpreted scenes on all hosts get them.
`wake` deserves a place: the ESP32 already knows a boot was a button wake
(`fos_buttons_wake_boot`) and replays a synthetic press; `open {reason: "wake",
button}` says it honestly.

Compatibility: scenes do not currently depend on these (nothing in the repo
listens for them and they do not fire), so turning them on is low-risk; gate
with a fixture that a scene with an `init` listener that sets state renders
that state on its first frame.

### 4.5 Input model

**Pointer.** `pointerDown / pointerMove / pointerUp / pointerCancel / wheel`,
payload as in §4.1: position on *every* event, scene pixels, `pointerId`,
`pointerType`, `buttons` bitmask. `mouseMove/Down/Up` remain as aliases with
today's payloads. The 0..32767 wire form stays as the driver/preview → host
contract (it is resolution-independent, which the `.so` ABI and the preview
need) and is written down once.

- Relative mice: the *host* owns a cursor. The driver sends deltas
  (`EV_REL`), the dispatcher accumulates, clamps to the panel, and emits
  `pointerMove`. Add an optional runner-drawn cursor overlay, enabled only when
  a relative pointer is present and the panel is not e-paper; it composes onto
  the last canvas without re-running the scene (the driver-retry path in
  `runner.nim:492-547` already re-presents a held canvas — same mechanism).
- Multitouch: track `ABS_MT_SLOT`/`TRACKING_ID` → `pointerId`. Cheap once the
  translation is a pure function.
- Gestures synthesized **in the shared layer**, so every host and the preview
  get the same ones: `tap` (down+up within slop and 500 ms), `longPress`,
  `doubleTap`, `swipe {direction}`. These are what e-paper scenes actually
  want; raw move streams are for framebuffer scenes.

**Keyboard.** `keyDown / keyUp {code, key, repeat, shift, ctrl, alt, meta}` and
`textInput {text}`.

- `code` = the W3C `KeyboardEvent.code` string (`"KeyA"`, `"ArrowLeft"`) —
  physical, layout-independent, and what the browser preview produces for
  free. Table from Linux `KEY_*` generated into the contract. Keep the numeric
  Linux code as `linuxCode` for the alias window.
- `key` = the layout-mapped value (`"a"`, `"A"`, `"Enter"`). Start with a
  built-in US table plus a frame setting `keyboardLayout` and a handful of
  generated tables; no xkbcommon dependency (Buildroot images, static link,
  ESP32 parity — §6). Compose/dead keys wait until somebody needs them, behind
  the same payload.
- `repeat: true` for `value == 2` — and the bug in §3.5 #2 dies with it.
- `EVIOCGRAB` keyboards while a scene is running (setting, default on), so the
  VT never sees Ctrl+Alt+Del; release the grab when the runtime stops so a
  rescue console still works.
- Hotplug: `inotify` on `/dev/input` (no udev dependency), re-enumerate on
  change; `poll()` on the fd set instead of the 10 ms sleep.
- **Privacy:** contract `log: "name-only"` for key and text events. No key
  payloads in the frame log, ever; a debug setting may log `code` only.
- Preview: forward `keydown/keyup/beforeinput` from the focused canvas — the
  payload maps 1:1, which is the point of choosing the W3C names.

**Buttons.** `button {pin, label, role, action: press|release|longPress|repeat,
durationMs, wake}`. Both edges on both hosts (lgpio `LG_BOTH_EDGES`; the ESP32
poll loop already sees the release). `role` (`primary|next|prev|back|…`) is a
per-button frame setting with board-preset defaults, so a store scene filters
on `role: "next"` instead of a silkscreen label. Legacy listeners keep working
because the alias rule is "a listener without an `action` filter hears `press`
only".

**Driver boundary.** Split `evdev.nim` into a pure translator
(`input_event` stream in → typed `InputEvent` values out; fully unit-testable
with recorded event dumps, which is where §3.5 #1–3 get regression tests) and
the libevdev I/O shell. Carry input across the `.so` ABI as a small C struct
(`kind, deviceId, code, x, y, value, tMono`) through a new *optional* symbol,
the same way `frameos_driver_earlier_render_seconds` was added; JSON stays for
everything low-rate. JSON is built once, at delivery, only if a listener
exists for that event — a scene with no pointer listeners should cost nothing
per mouse motion.

### 4.6 Routing, focus, timers

This is where the event layer meets `docs/ui-todo.md` (retained hit-test list,
focus, `onClick`), and the order matters: build routing in the dispatcher, not
in the widget layer, so node-graph scenes get it too.

- **Targets.** Pointer events are routed by hit-test against a retained list
  of rects → target ids. Two producers of that list: the JSX layout result
  (ui-todo item 4) and, for node scenes, the rectangles child scenes were
  painted into — which PR #496's paint log already records. That makes "touch
  inside the embedded clock goes to the clock scene, in its local coordinates"
  fall out for free, and fixes "child scenes never see input".
- **Propagation.** Target → ancestors → scene-level listeners, with
  `handled` stopping it. Keyboard and `button` events go to the focused target
  first, then up.
- **Focus.** One focus owner per scene tree; `button role: next/prev` moves it,
  `primary` activates (synthesizes `tap` on the focused target). Default
  behaviour only when the scene has focusable targets; a scene with a raw
  `button` listener still gets raw buttons (ui-todo already promises this).
- **Timers.** `after(ms, eventName, payload)` / `every(ms, …)` owned by the
  dispatcher, delivered as ordinary queued events with `origin: "scene"`,
  cancelled on `close`. On the ESP32 a pending timer is an input to the sleep
  forecast (shorter of next render and next timer; timers under a threshold
  hold the device awake, above it they are dropped at sleep and the scene is
  told via `close {reason: "sleep"}`).
- **Filters.** Keep string equality as the node-graph filter; add `in`-lists
  and numeric ranges through the contract's field types so a node can say
  "x in 0..200". Anything richer belongs in code.

### 4.7 The thread problem

None of the above makes e-paper interactive, and it should not try to
(`ui-todo`: "e-paper latency is physics"). But two things are fixable:

1. Move `drivers.render` off the runner thread (the existing TODO). The canvas
   handed to the driver is already a finished, held image; the rule from
   AGENTS.md applies — hand over an owned buffer, not a shared `ref`. Then
   input is *read* and state updated during a 30 s refresh, and the next
   render shows the net result instead of replaying a backlog.
2. For framebuffer/HyperPixel, the "fast loop" of ui-todo item 5: a render
   requested by an input event skips the scheduler sleep and the snapshot/PNG
   work, and coalesces to at most one in flight.

### 4.8 JS surface

```ts
// in a JS app or code node
export function onEvent(ctx: FrameOSContext<"pointerDown" | "keyDown">) { … }   // typed by the contract
frameos.dispatch("render")               // same budget, same origin rules as a dispatch node
frameos.after(500, "hideOverlay")
```

`context.event`/`context.payload` stay. The gain is types (generated), and that
an app can own its own input handling without the author wiring five event
nodes into it.

## 5. Order of work

**P0 — bugs, no design needed.** Shipped with this document. What it left
for the later steps, on purpose:

- The relative-mouse cursor lives in the evdev driver, in panel pixels, and is
  not drawn. It does not know the frame's `rotate` (the driver context has no
  such field), so on a rotated frame the mouse moves along the panel's axes.
  The host-owned, drawn cursor is P3.
- Key auto-repeat is dropped, not flagged; `repeat: true` is P3's payload.
- "Handled" on the ESP32 means "a listener ran": a button press renders when
  one did or when the scene dispatched `render`. The `renderAfter` rule is P2.
- wasm still drops a dispatch made inside a handler (the `handlingEvent`
  latch), a scene-dispatched `setCurrentScene` included. Queued delivery is P2.
- The cloud's `setSceneState` rides on `set_current_scene` for the scene the
  frame last reported, Linux profile only; the ESP32 verb drops `state`. The
  `scene_event` verb (P2) replaces it.
- No `close` on `reload` / `uploadScenes`, no `destroy`, no `reason` on `open`
  (§4.4).

**P1 — the spec.** Shipped: `docs/events-contract.json`,
`frameos/tools/generate_events_contract.py`, `docs/events.md`,
`docs/event-fixtures.json` with runners in Nim, C, Python and TypeScript; the
lists in §3.1 are generated or gone. The contract records what each origin
*can* do today, so nothing a scene relies on moved. What the fixtures exposed,
and what changed because of it:

- A schedule entry firing `uploadScenes` was refused on a Pi and delivered to
  the scene on an ESP32, and the cloud accepted it either way. The firmware
  refuses it now (`schedule:refused`), and the cloud's validator refuses the
  schedule.
- The preview offered buttons for `turnOn` / `turnOff` listeners (both
  `LIFECYCLE_EVENTS` copies forgot them); they are scene commands.
- The fleet list followed a frame's scene by a different set of log lines than
  the backend; both read `logEvents.sceneChanged` now.
- The legacy codegen found the catalog relative to the working directory.

Left for the later steps, on purpose:

- The contract's `origins` are enforced where a host can tell an origin today
  (`enforcedOrigins`, a column P2 deleted: every origin is asked now); the envelope that carries it everywhere is P2, and with
  it the narrowing of the input and lifecycle rows (decision 5 in §6
  included: a custom event's own `origins`).
- `renderAfter` is the rule the hosts converge on, not what they do: only
  `never` for pointer events holds everywhere (`docs/events.md`, "Known host
  differences"). Enforcing it is the dispatcher's job, P2.
- No fixture runner for the wasm *host*: the cloud's CI runs the pinned
  release's bundle, not the tree's. The interpreter the bundle compiles is
  covered by the Nim runner.
- §3.1 #11's prose copies of the `context` shape (two prompts, one doc page)
  cannot import a table; a test holds them to the contract's keys.
  `scene-convert` still emits `context.imageWidth` / `imageHeight` for a code
  node, which has neither.
- The ESP32's C switches use the generated names and allow-list but are still
  three switches; they collapse in P2.

**P2 — one dispatcher.** Shipped: `frameos/src/frameos/event_loop.nim`, the
envelope with its origin (`sendEvent` has no default origin — a new producer
says who it is), the command/event split (`RuntimeCommand`, generated from the
contract's device commands), queued delivery on the ESP32 and in the preview
(the depth-4 guard and the `handlingEvent` latch are gone), the `renderAfter`
rule, custom events' own `origins` (decision 5), the cloud's `scene_event`
verb, and a `dispatcher` section in the fixtures with a runner around the real
interpreter. What changed for a scene, deliberately:

- A handler that changes scene state is drawn, on every host, without
  dispatching `render`. Linux used to need the dispatch; the ESP32 rendered
  whenever a `button` listener ran, the preview after every event.
- A press nobody's state reacts to draws nothing, on every host.
- `init`, `open` and `close` are the host's to say: a scene, a schedule and the
  access key can no longer fake them.
- A schedule fires a custom event only at a scene that declares it with
  `origins: ["schedule"]`. The Schedule panel never offered custom events, so
  this reaches schedules somebody wrote by hand.
- On the ESP32 and in the preview a handler's dispatch now runs after the
  handler, not inside it, and a scene-dispatched `setCurrentScene` switches
  scenes in the preview too.

Where it departs from §4.3, and why:

- **The render rule has an exception the proposal did not see.** A slideshow's
  render dispatches `setSceneState` to turn its page; with a plain
  "if state changed, render" every render causes the next, forever, on
  e-paper. An event dispatched from inside the host's own run of a scene (a
  render, `init`, `open`, `close`) — and whatever its handlers dispatch in turn
  — renders only by dispatching `render`. For the dispatcher to know, what is
  sent on the runner thread goes straight into its queue instead of through
  the channel (`channels.localEventSink`).
- **Two lanes, but only input waits.** "Commands ahead of input" as written
  would reorder a scene's own dispatches (a custom event, then a
  `setCurrentScene`). Only the input class has its own lane.
- **The ESP32's switches collapsed into C, not into Nim.** Rendering, scene
  selection and the device commands are the firmware's, and the cloud
  WebSocket task must not park behind the runtime lock a 90-second render
  holds. `main/fos_events.c` is the one C edge for HTTP, schedule, cloud,
  console and buttons: it asks the generated allow-list, does the firmware's
  own part, and hands the rest to the dispatcher. The Nim host's callbacks land
  in the same C functions, so a scene's dispatch and an HTTP request take the
  same path from there.
- **The deny-lists are one question asked in more than one place.** The
  dispatcher asks `originMayEmit` of every envelope. The HTTP route, the
  dispatch node, the scheduler and the hub verb still ask first, because a 401
  or a log line with a node id is a better answer than `event:refused`.
- A full lane drops the newest event and counts it. "Never drop `pointerUp`,
  synthesize `pointerCancel`" needs the P3 payloads.

Both control planes got the same things: the Events panel's custom event
editor has "A schedule may fire it" / "FrameOS Cloud may send it", the Schedule
panel offers the custom events a scene declares for it, and the cloud's event
route sends `button`, `setSceneState` and declared custom events as
`scene_event` (a frame older than 2026.9.21 keeps the `set_current_scene`
stand-in for `setSceneState`, and is told to update for the rest). The
self-hosted backend already forwards any event to the frame's `/event/<name>`
as `http:admin`.

Cleaned up afterwards, because a dispatcher that only adds code has not
replaced anything: the ESP32 runtime and the preview share one host
(`frameos/single_scene_host.nim` — their two copies of the scene lifetime,
the lifecycle events and the EventHost had already drifted: the preview leaked
its JS app runtimes on every scene switch, and handed a switch's `state` to
`init` as persisted state instead of applying its public fields);
`enforcedOrigins` left the contract (every origin is asked); the C table lost
the policy columns only the Nim dispatcher reads; `dispatchSceneEvent`,
`triggerRender`, `isControlEvent`, `scheduleMayFire`, `eventCoalescesLatest`
and `refusedEvents` are gone.

Left for the later steps: no `close` on `reload` / `uploadScenes`, no
`destroy`, no `reason` on `open` (§4.4); a scheduled custom event goes to the
scene showing at that minute, not to the scene it was declared in (that needs
a `target` on the schedule entry — §6 decision 2); no fixture runner for the
wasm host; on ESP32 hardware the console, render-rule, queued-dispatch,
scene-switch and device-command paths have run (a reTerminal E1002 — it found
a nil dereference in the host's `selectScene` that the preview had hidden,
since wasm does not trap on address 1), the cloud and schedule paths have not
(`docs/manual-testing-todo.md`).

**P3 — input v2.** Pointer/keyboard/button payloads with aliases, host cursor,
hotplug, grab, layouts, gestures, struct ABI, preview keyboard forwarding.
Ship a touch-test and a keyboard-test scene in `repo/scenes/samples` and in
the e2e snapshot harness (the recipe in `manual-testing-todo.md` currently
refers to a scene that is not in the repo).

**P4 — routing, focus, timers, the driver thread, the fast loop.** Lands
together with ui-todo items 4–5; the dispatcher work here *is* the first half
of those items.

Cloud/backend parity (AGENTS.md): P0.7, P1 and P2 touch both planes — the
contract generators, the event route/verb, the schedule validator and the
shared SPA. P3's frame settings (`keyboardLayout`, button roles, grab) need the
usual frame-key plumbing on both, including
`FRAME_KEY_INTRODUCED_FRAMEOS_VERSION`.

## 6. Decisions

The open questions of the first draft, as answered on 2026-09-21.

1. **Aliases are forever.** Store scenes are versioned and immutable, so an old
   event name never stops working; the generated alias table makes that free
   at run time. There is no deprecation window to manage.
2. **`dispatch` to a named scene: not as a global id.** The transport has
   carried `Option[SceneId]` since the beginning and nothing uses it. If this
   becomes a feature it arrives with routing (§4.6), as "dispatch to a child
   scene node". No commitment either way before that.
3. **No xkbcommon.** Buildroot images are the target that matters most, and
   they are where a new shared-library dependency costs the most. The built-in
   layout tables (§4.5) are the plan, not the floor under an optional
   dependency; compose and dead keys wait until somebody needs them.
4. **ESP32 input beyond buttons: standardize, do not implement.** The contract
   describes pointer and keyboard events for every host and marks them
   `hosts.esp32: false`. No board in the tree has touch, and nothing is built
   for hardware that is not there.
5. **A schedule may fire custom scene events — explicitly.** Today it can by
   accident (any string ≤63 chars). Under §4.2 it is `origins: ["schedule"]` on
   the custom event's declaration.

## Appendix: file map

| Concern | Files |
|---|---|
| Catalog | `frontend/schema/events.json`, `frontend/src/utils/frameEvents.ts`, `cloud/apps/auth-web/src/generated/ai-context.json` |
| Linux transport + dispatch | `frameos/src/frameos/channels.nim`, `runner.nim:568-792`, `driver_abi.nim`, `drivers/drivers.nim:128-153` |
| Interpreter | `frameos/src/frameos/interpreter.nim:752-876` (dispatch), `:1552-1696` (listen), `js_runtime/run_budget.nim` |
| Input drivers | `frameos/src/drivers/evdev/{evdev,pointer}.nim`, `drivers/gpioButton/gpioButton.nim`, `frameos/input_sources.nim` |
| ESP32 | `frameos/src/embedded/embedded_runtime.nim:124-135, 253-282`; `embedded/esp32/main/fos_buttons.c`, `fos_http.c:1900-1945`, `fos_schedule.c:286-322`, `fos_cloud.c` |
| wasm | `frameos/src/wasm/wasm_main.nim:231-280, 408-420`; `frameos/wasm/src/{pointer,preview,types}.ts`; `frontend/src/utils/previewPointer.ts` |
| Origins | `scheduler.nim`, `server/routes/{web,admin_api,frame_api}_routes.nim`, `server/auth.nim:371-390`, `cloud/hub_client.nim:1322-1391` |
| Control planes | `backend/app/api/frames.py:1477-1539`, `backend/app/utils/frame_http.py:222-275`, `cloud/apps/auth-web/app/api/frames/[frameId]/event/[eventName]/route.ts`, `cloud/apps/auth-web/src/lib/frames.ts:273-292, 510-577`, `docs/cloud-frames-contract.json` |
| Editor | `frontend/src/scenes/frame/panels/Diagram/{EventNode,AppNode}.tsx`, `appNodeLogic.ts`, `newNodePickerLogic.tsx`, `panels/Events/*`, `livePreviewLogic.tsx` |
| Legacy codegen | `backend/app/codegen/scene_nim.py:983-1041, 1188-1233, 1291-1320, 1396-1400` |
| Plans this touches | `docs/ui-todo.md` (items 4, 5, 7, 8), PR #496 (scene rhythm paint log), `docs/manual-testing-todo.md:22-66` |
