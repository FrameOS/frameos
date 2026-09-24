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
##   has drained;
## - **input**: what a person did goes through `input_state.nim` — the one
##   pointer position, the cursor, the modifiers, the layout, the gestures — and
##   a scene hears each event under its name and its old names (the contract's
##   aliases), only when it listens for it.
##
## What a host supplies is `EventHost` and nothing else. A loop belongs to one
## thread — the runner's on Linux, the only one there is elsewhere. On Linux
## other threads reach it through `channels.eventChannel`, which the runner
## empties into `enqueue`.

import std/[deques, hashes, json, monotimes, options, tables]
import ./events
import ./event_log
import ./types
import ./driver_abi
import ./input_state

export events
export input_state.InputState, input_state.cursorVisible, input_state.takeCursorDirty,
  input_state.pointersDown, input_state.buttonsHeld

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
    preprocessed*: bool ## already through input_state (a tick's longPress): deliver as it is
    when not defined(frameosEmbedded):
      # A driver's struct (the Linux evdev thread), no JSON until a listener
      # wants it. The one-task hosts have no drivers, and 256 lane slots of it
      # would be 10 KB of an ESP32's RAM.
      hasInput*: bool   ## `input` is the message and `payload` nil
      input*: DriverInputEvent

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
    sceneListens*: proc (scene: FrameScene, event: string): bool
      ## Whether the scene has a listener for `event`. Input is delivered only
      ## then — its payload is built at delivery, and a scene with no pointer
      ## listeners should cost nothing per motion report. nil: always deliver.
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
    inputState*: InputState

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
    main: initDeque[EventEnvelope](), input: initDeque[EventEnvelope](),
    inputState: initInputState(frameConfig))

proc pending*(loop: EventLoop): int =
  loop.main.len + loop.input.len

proc log(loop: EventLoop, entry: JsonNode) =
  if not loop.host.log.isNil:
    loop.host.log(entry)

# ------------------------------------------------------------------ enqueue

proc isStructInput(envelope: EventEnvelope): bool =
  when defined(frameosEmbedded): false
  else: envelope.hasInput

proc isPointerMoveEnvelope(envelope: EventEnvelope): bool =
  envelope.name == evPointerMove or envelope.name == evMouseMove

proc laneFull(loop: EventLoop, envelope: EventEnvelope, lane: var Deque[EventEnvelope], policy: EventPolicy) =
  ## A full lane drops the newest event and counts it — except the end of a
  ## pointer's life: a `pointerUp` or `pointerCancel` evicts the newest queued
  ## move to make room, and when there is none to evict, what is down gets a
  ## `pointerCancel` at the next drain, so a scene is never stuck "pressed".
  when defined(frameosEmbedded):
    inc loop.dropped
  else:
    if envelope.name == evPointerUp or envelope.name == evMouseUp or envelope.name == evPointerCancel:
      var evicted = false
      var kept: seq[EventEnvelope]
      while lane.len > 0:
        let last = lane.popLast()
        if last.isPointerMoveEnvelope:
          evicted = true
          break
        kept.add(last)
      for index in countdown(kept.len - 1, 0):
        lane.addLast(kept[index])
      if evicted:
        lane.addLast(envelope)
        inc loop.dropped
        return
      loop.inputState.pointerInputLost = true
    elif policy.device == edPointer:
      loop.inputState.pointerInputLost = true
    inc loop.dropped

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
      lane[].peekLast.target == target and lane[].peekLast.origin == origin and
      not lane[].peekLast.isStructInput and
      lane[].peekLast.payload{"pointerId"}.getInt(0) == envelope.payload{"pointerId"}.getInt(0):
    lane[].peekLast = envelope
    return
  if lane[].len >= loop.laneCapacity:
    loop.laneFull(envelope, lane[], policy)
    return
  lane[].addLast(envelope)

when not defined(frameosEmbedded):
  proc inputEventName(event: DriverInputEvent): string =
    case DriverInputKind(event.kind)
    of dikPointerAbs, dikPointerRel: evPointerMove
    of dikPointerDown: evPointerDown
    of dikPointerUp: evPointerUp
    of dikPointerCancel: evPointerCancel
    of dikWheel: evWheel
    of dikKeyDown: evKeyDown
    of dikKeyUp: evKeyUp
    of dikNone: ""

  proc enqueueInput*(loop: EventLoop, origin: EventOrigin, event: DriverInputEvent) =
    ## One struct from an input driver: no JSON until a listener wants it. A
    ## motion report replaces the queued one for the same pointer; a relative
    ## mouse's counts add up, so a drag the panel refresh held back lands where
    ## the hand is and not where it was a slot ago.
    let name = inputEventName(event)
    if name.len == 0:
      return
    let envelope = EventEnvelope(name: name, hasInput: true, input: event, origin: origin,
      seq: loop.nextSeq, tMono: getMonoTime(), fromRender: loop.hostRunDepth > 0 or loop.handlingFromRender)
    inc loop.nextSeq
    if loop.input.len > 0 and loop.input.peekLast.hasInput and loop.input.peekLast.origin == origin:
      let last = addr loop.input.peekLast
      if last.input.kind == event.kind and event.kind == ord(dikPointerRel).cint:
        last.input.x += event.x
        last.input.y += event.y
        return
      if last.input.kind == event.kind and event.kind == ord(dikPointerAbs).cint and
          last.input.pointerId == event.pointerId:
        last[] = envelope
        return
    if loop.input.len >= loop.laneCapacity:
      loop.laneFull(envelope, loop.input, eventPolicy(name))
      return
    loop.input.addLast(envelope)

# ----------------------------------------------------------------- delivery

proc stateHash(scene: FrameScene): Hash =
  if scene.isNil or scene.state.isNil: 0.Hash else: hash(scene.state)

proc runOnScene(loop: EventLoop, scene: FrameScene, name: string, payload: JsonNode,
                policy: EventPolicy, fromRender: bool) =
  ## One run of the scene, then the render rule for that event.
  let watchState = policy.renderAfter == raIfStateChanged and not fromRender
  let before = if watchState: stateHash(scene) else: 0.Hash
  loop.host.runScene(scene, name, payload)
  case policy.renderAfter
  of raAlways: loop.renderWanted = true
  of raIfStateChanged:
    if watchState and stateHash(scene) != before:
      loop.renderWanted = true
  of raNever: discard

proc deliver(loop: EventLoop, envelope: EventEnvelope, policy: EventPolicy): bool =
  let scene = loop.host.sceneFor(envelope.target)
  if scene.isNil:
    return false
  if not originMayEmit(envelope.origin, envelope.name, scene.customEventOrigins.getOrDefault(envelope.name)):
    loop.log(%*{"event": "event:refused", "name": envelope.name, "origin": $envelope.origin,
      "sceneId": scene.id.string, "reason": "undeclared"})
    return false
  loop.runOnScene(scene, envelope.name, envelope.payload, policy, envelope.fromRender)
  true

proc listens(loop: EventLoop, scene: FrameScene, name: string): bool =
  loop.host.sceneListens.isNil or loop.host.sceneListens(scene, name)

when not defined(frameosEmbedded):
  proc aliasPayload(alias: string, payload: JsonNode): JsonNode =
    ## The alias's own, smaller payload: the keys its contract row lists.
    result = newJObject()
    for index in 0 ..< eventPayloadKeyCount(alias):
      let key = eventPayloadKey(alias, index)
      if payload.hasKey(key):
        result[key] = payload[key]

proc deliverInput(loop: EventLoop, target: Option[SceneId], delivery: InputDelivery, fromRender: bool): bool =
  ## An input event to the scene: under its name, and under each old name it
  ## has (`mouseMove` for `pointerMove`), each only when the scene listens.
  # Logged before the scene is asked for, like every other event: a press
  # nobody could hear is still a press somebody made.
  if eventIsLogged(delivery.name):
    loop.log(withEventPayload(%*{"event": "event:" & delivery.name, "origin": $delivery.origin},
      delivery.name, delivery.payload))
  let scene = loop.host.sceneFor(target)
  if scene.isNil:
    return false
  if loop.listens(scene, delivery.name):
    loop.runOnScene(scene, delivery.name, delivery.payload, eventPolicy(delivery.name), fromRender)
    result = true
  # The old names are pointer events' (docs/events-contract.json `aliasOf`),
  # and the ESP32 has no pointer: leaving this out there leaves the generated
  # alias and payload-key tables out of its image too.
  when not defined(frameosEmbedded):
    for index in 0 ..< eventAliasCount(delivery.name):
      let alias = eventAlias(delivery.name, index)
      if loop.listens(scene, alias):
        loop.runOnScene(scene, alias, aliasPayload(alias, delivery.payload), eventPolicy(alias), fromRender)
        result = true

proc processInput(loop: EventLoop, envelope: EventEnvelope): bool =
  ## What a person did, through the input state: the position every pointer
  ## event carries, the key a code means, the gestures, the button's role and
  ## action. A `preprocessed` envelope (a tick's `longPress`) is already that.
  var deliveries: seq[InputDelivery]
  if envelope.preprocessed:
    deliveries.add(InputDelivery(name: envelope.name, payload: envelope.payload, origin: envelope.origin))
  elif envelope.isStructInput:
    when not defined(frameosEmbedded):
      loop.inputState.applyDriverInput(envelope.input, envelope.origin, envelope.tMono, deliveries)
  elif not loop.inputState.applyNamedInput(envelope.name, envelope.payload, envelope.origin,
      envelope.tMono, deliveries):
    return loop.deliver(envelope, eventPolicy(envelope.name))
  for delivery in deliveries:
    if loop.deliverInput(envelope.target, delivery, envelope.fromRender):
      result = true

proc process(loop: EventLoop, envelope: EventEnvelope): bool =
  ## False when the event came to nothing: refused, or no scene to take it.
  let policy = eventPolicy(envelope.name)
  # A custom event's allow-list depends on the scene it reaches; `deliver` asks.
  if policy.class != ecCustom and not originMayEmit(envelope.origin, envelope.name):
    loop.log(%*{"event": "event:refused", "name": envelope.name, "origin": $envelope.origin,
      "reason": "origin"})
    return false
  if policy.class == ecInput:
    # Logged per delivered event, in deliverInput: a key is one line by name,
    # a motion report none.
    return loop.processInput(envelope)
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
    when not defined(frameosEmbedded):
      if loop.inputState.pointerInputLost:
        # The lane dropped pointer input: whatever is down lets go, ahead of
        # everything else, so a drag does not resume from a position it never had.
        var cancels: seq[InputDelivery]
        loop.inputState.cancelPointers(eoDriver, cancels)
        for cancel in cancels:
          discard loop.deliverInput(none(SceneId), cancel, false)
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

proc tick*(loop: EventLoop, now = getMonoTime()): int =
  ## Time passing for the input state: a held pointer or button becomes a
  ## `longPress`, a held button `repeat`s, an idle cursor hides. What it makes
  ## is queued (input lane) for the drain that follows; returns how many.
  var made: seq[InputDelivery]
  loop.inputState.tick(now, made)
  for delivery in made:
    if loop.input.len >= loop.laneCapacity:
      inc loop.dropped
      continue
    loop.input.addLast(EventEnvelope(name: delivery.name, payload: delivery.payload, origin: delivery.origin,
      seq: loop.nextSeq, tMono: now, preprocessed: true))
    inc loop.nextSeq
    inc result

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
