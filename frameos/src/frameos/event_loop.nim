## The scene event dispatcher: one piece of Nim that the Linux runner, the ESP32
## runtime and the wasm preview all compile, so an event means the same thing on
## each of them. docs/events.md is the spec, docs/events-contract.json the
## tables, docs/event-fixtures.json (`dispatcher`) the cases this is held to.
##
## What it owns:
## - the **envelope**: every message carries the origin its producer's entry
##   point stamped on it (never anything read from the payload), and the
##   contract's allow-list is asked here, of every origin, once;
## - the **command/event split**: a device command becomes a `RuntimeCommand`
##   for the host and is never delivered to a scene; `render`,
##   `setCurrentScene`, `turnOn` / `turnOff` are asked of the host;
## - **queued delivery**: what a handler dispatches is appended and delivered
##   after the run that dispatched it, on every host;
## - the **render rule**: the contract's `renderAfter`, applied once the queue
##   has drained.
##
## What a host supplies is `EventHost` and nothing else. A loop belongs to one
## thread — the runner's on Linux, the only one there is elsewhere. On Linux
## other threads reach it through `channels.eventChannel`, which the runner
## empties into `enqueue`.

import std/[deques, hashes, json, monotimes, options, tables]
import ./events
import ./event_log
import ./types
import ./utils/image

export events

const
  DefaultLaneCapacity* = 256
  ## Events one `drain` call delivers before it returns with the rest still
  ## queued. A scene whose handler re-dispatches its own event never empties the
  ## queue; the hosts are one thread (or one task) each, so the loop has to hand
  ## it back for the frame to render at all.
  DefaultDrainBudget* = 32

type
  EventEnvelope* = object
    name*: string
    payload*: JsonNode
    target*: Option[SceneId]
    origin*: EventOrigin
    seq*: uint64      ## order of arrival at this loop
    tMono*: MonoTime  ## when it arrived
    fromRender*: bool ## dispatched by a render (or an `init` / `open` / `close`), or by a handler of such an event

  EventHost* = object
    ## The four things a host does for the dispatcher…
    requestRender*: proc ()
    selectScene*: proc (payload: JsonNode): bool
      ## `setCurrentScene`: switch (close, init, open — the host's lifecycle),
      ## or apply `state` when the scene named is the one showing. False when
      ## nothing changed: no such scene, or the one showing and no state for it.
    displayPower*: proc (on: bool)
    runtimeCommand*: proc (command: RuntimeCommand, payload: JsonNode)
    ## …and how it reaches a scene: the instance an event goes to (nil when
    ## there is none yet) and one run of it.
    sceneFor*: proc (target: Option[SceneId]): FrameScene
    runScene*: proc (scene: FrameScene, event: string, payload: JsonNode)
    log*: proc (entry: JsonNode)

  EventLoop* = ref object of RootObj
    host*: EventHost
    frameConfig*: FrameConfig
    laneCapacity*: int
    # Two lanes. Input — what a person did, arriving in bursts from a driver —
    # waits behind everything else, so a reboot or a scene switch is never stuck
    # behind a drag. Within a lane, order of arrival.
    main: Deque[EventEnvelope]
    input: Deque[EventEnvelope]
    nextSeq: uint64
    draining: bool
    renderWanted: bool
    # The render rule's one exception. `if-state-changed` exists so that what a
    # person, a schedule or a control plane did shows up without the scene
    # having to ask. A render that dispatches `setSceneState` to turn its own
    # page is the scene talking to itself: were that to count, every render
    # would cause the next one, forever. So an event is marked when it was
    # dispatched from inside the host's render or lifecycle run (`hostRun`), or
    # by a handler of an event so marked, and a marked event renders only by
    # dispatching `render`.
    hostRunDepth: int
    handlingFromRender: bool
    # `dispatchNow`: the envelope whose fate its caller wants to hear.
    watchSeq: uint64
    watching, watchedOk: bool
    dropped*: int ## events refused because a lane was full; the host reports and resets it

proc hasStatePayload*(payload: JsonNode): bool =
  ## Whether an event's payload carries a `state` object. `payload{"state"}` is
  ## nil when the key is absent, and `.kind` on that is a nil dereference: a
  ## `setCurrentScene` without state took an ESP32 down with exactly that
  ## (LoadProhibited, found on the bench 2026-09-21) — and wasm does not trap on
  ## address 1, so the preview hid it. Hosts ask this instead.
  if payload.isNil or payload.kind != JObject:
    return false
  let state = payload{"state"}
  not state.isNil and state.kind == JObject

proc newEventLoop*(host: EventHost, frameConfig: FrameConfig,
                   laneCapacity = DefaultLaneCapacity): EventLoop =
  EventLoop(host: host, frameConfig: frameConfig, laneCapacity: laneCapacity,
    main: initDeque[EventEnvelope](), input: initDeque[EventEnvelope]())

proc pending*(loop: EventLoop): int =
  loop.main.len + loop.input.len

proc log(loop: EventLoop, entry: JsonNode) =
  if not loop.host.log.isNil:
    loop.host.log(entry)

# ------------------------------------------------------------------ enqueue

proc enqueue*(loop: EventLoop, origin: EventOrigin, name: string, payload: JsonNode,
              target = none(SceneId)) =
  ## Appends one event. The contract's `coalesce: latest` is applied here: a
  ## `mouseMove` replaces the `mouseMove` it would queue behind, so a drag that
  ## piles up while the panel refreshes costs one slot, and whatever else is
  ## queued keeps its place.
  let policy = eventPolicy(name)
  # A payload is a JSON object (docs/events.md). Whatever else an HTTP body or a
  # hub message held — nothing, a list, a number — reaches the hosts and the
  # scene as {}: `hasKey` on a list is not something to find out about in the
  # field.
  let envelope = EventEnvelope(name: name,
    payload: (if payload.isNil or payload.kind != JObject: newJObject() else: payload),
    target: target, origin: origin, seq: loop.nextSeq, tMono: getMonoTime(),
    fromRender: loop.hostRunDepth > 0 or loop.handlingFromRender)
  inc loop.nextSeq
  let lane = if policy.class == ecInput: addr loop.input else: addr loop.main
  if policy.coalesceLatest and lane[].len > 0 and lane[].peekLast.name == name and
      lane[].peekLast.target == target and lane[].peekLast.origin == origin:
    lane[].peekLast = envelope
    return
  if lane[].len >= loop.laneCapacity:
    inc loop.dropped
    return
  lane[].addLast(envelope)

# ----------------------------------------------------------------- delivery

proc stateHash(scene: FrameScene): Hash =
  if scene.isNil or scene.state.isNil: 0.Hash else: hash(scene.state)

proc scenePayload(loop: EventLoop, name: string, payload: JsonNode): JsonNode =
  ## Pointer positions arrive 0..PointerWireMax across the panel and reach a
  ## scene in its own pixels, rotation and flip applied.
  if name == evMouseMove and not loop.frameConfig.isNil and loop.frameConfig.width > 0 and
      loop.frameConfig.height > 0 and payload.kind == JObject:
    let point = pointerToScenePoint(payload{"x"}.getInt(), payload{"y"}.getInt(),
      loop.frameConfig.width, loop.frameConfig.height, loop.frameConfig.rotate, loop.frameConfig.flip)
    result = copy(payload)
    result["x"] = %point.x
    result["y"] = %point.y
  else:
    result = payload

proc deliver(loop: EventLoop, envelope: EventEnvelope, policy: EventPolicy): bool =
  let scene = loop.host.sceneFor(envelope.target)
  if scene.isNil:
    return false
  if not originMayEmit(envelope.origin, envelope.name, scene.customEventOrigins.getOrDefault(envelope.name)):
    loop.log(%*{"event": "event:refused", "name": envelope.name, "origin": $envelope.origin,
      "sceneId": scene.id.string, "reason": "undeclared"})
    return false
  let watchState = policy.renderAfter == raIfStateChanged and not envelope.fromRender
  let before = if watchState: stateHash(scene) else: 0.Hash
  loop.host.runScene(scene, envelope.name, loop.scenePayload(envelope.name, envelope.payload))
  case policy.renderAfter
  of raAlways: loop.renderWanted = true
  of raIfStateChanged:
    if watchState and stateHash(scene) != before:
      loop.renderWanted = true
  of raNever: discard
  true

proc process(loop: EventLoop, envelope: EventEnvelope): bool =
  ## False when the event came to nothing: refused, or no scene to take it.
  let policy = eventPolicy(envelope.name)
  # A custom event's allow-list depends on the scene it reaches; `deliver` asks.
  if policy.class != ecCustom and not originMayEmit(envelope.origin, envelope.name):
    loop.log(%*{"event": "event:refused", "name": envelope.name, "origin": $envelope.origin,
      "reason": "origin"})
    return false
  if eventIsLogged(envelope.name):
    loop.log(withEventPayload(%*{"event": "event:" & envelope.name, "origin": $envelope.origin},
      envelope.name, envelope.payload))

  if policy.class == ecDeviceCommand:
    loop.host.runtimeCommand(runtimeCommandOf(envelope.name).get(), envelope.payload)
    return true
  case envelope.name
  of evRender:
    # A request, not a delivery: the scene hears "render" from the render pass.
    loop.renderWanted = true
    result = true
  of evSetCurrentScene:
    result = loop.host.selectScene(envelope.payload)
    if result:
      loop.renderWanted = true
  of evTurnOn, evTurnOff:
    loop.host.displayPower(envelope.name == evTurnOn)
    discard loop.deliver(envelope, policy)
    result = true
  else:
    result = loop.deliver(envelope, policy)

proc drain*(loop: EventLoop, budget = DefaultDrainBudget): int =
  ## Delivers what is queued, oldest first, the main lane ahead of input, until
  ## the queue is empty or `budget` events ran; returns how many did. What a
  ## handler dispatches meanwhile is queued behind and delivered by this same
  ## call. Then the render rule: one `requestRender` if anything asked for it.
  ## A `drain` from inside a handler is a no-op — the outer one is already
  ## going to get there.
  if loop.draining:
    return 0
  loop.draining = true
  try:
    while result < budget and loop.pending > 0:
      let envelope = if loop.main.len > 0: loop.main.popFirst() else: loop.input.popFirst()
      inc result
      loop.handlingFromRender = envelope.fromRender
      try:
        let ok = loop.process(envelope)
        if loop.watching and envelope.seq == loop.watchSeq:
          loop.watchedOk = ok
      except Exception as e:
        if loop.watching and envelope.seq == loop.watchSeq:
          loop.watchedOk = false
        loop.log(%*{"event": "event:error", "name": envelope.name, "error": e.msg,
          "stacktrace": e.getStackTrace()})
      finally:
        loop.handlingFromRender = false
  finally:
    loop.draining = false
  if loop.renderWanted:
    loop.renderWanted = false
    loop.host.requestRender()

template hostRun*(loop: EventLoop, body: untyped) =
  ## Around the host's own runs of a scene — its render, its init — so that
  ## what they dispatch is known to come from there (see `hostRunDepth`).
  inc loop.hostRunDepth
  try:
    body
  finally:
    dec loop.hostRunDepth

proc dispatchNow*(loop: EventLoop, origin: EventOrigin, name: string, payload: JsonNode,
                  budget = DefaultDrainBudget): bool =
  ## `enqueue` and `drain`, for a host with one task and a caller waiting on an
  ## answer (an HTTP request, a console command). False when the event came to
  ## nothing — refused, no such scene; true when it ran, or is still queued
  ## behind a run in progress.
  loop.watching = true
  loop.watchSeq = loop.nextSeq
  loop.watchedOk = true
  let droppedBefore = loop.dropped
  loop.enqueue(origin, name, payload)
  discard loop.drain(budget)
  loop.watching = false
  loop.watchedOk and loop.dropped == droppedBefore

proc deliverLifecycle*(loop: EventLoop, scene: FrameScene, event: string, payload: JsonNode) =
  ## `open` and `close`: said by the host at the moment they are true, so they
  ## are not queued — a `close` has to reach the scene before it is gone. What
  ## their listeners dispatch is queued like anything else, and `open` renders
  ## by the same rule as any event (the host is about to render anyway).
  if scene.isNil:
    return
  if eventIsLogged(event):
    loop.log(withEventPayload(%*{"event": "event:" & event, "origin": $eoSystem,
      "sceneId": scene.id.string}, event, payload))
  loop.hostRun:
    try:
      loop.host.runScene(scene, event, payload)
    except Exception as e:
      loop.log(%*{"event": "event:error", "name": event, "error": e.msg,
        "stacktrace": e.getStackTrace()})
