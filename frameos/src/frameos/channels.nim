# `frameosSharedLibrary` used to select this branch too — it built a scene as
# its own `.so`. Those modes are gone (see LEGACY_COMPILATION_MODES in
# backend/app/codegen/drivers_nim.py); drivers are the only thing that still
# crosses a `.so` boundary.
when defined(frameosDriverLibrary):
  import json
  import options
  import frameos/ids
  import frameos/driver_abi
  import frameos/events_gen
  export events_gen.EventOrigin

  var
    sharedHostLogHook: HostLogProc
    sharedHostSendEventHook: HostSendEventProc

  proc setSharedHostCallbacks*(logHook: HostLogProc, sendEventHook: HostSendEventProc) =
    sharedHostLogHook = logHook
    sharedHostSendEventHook = sendEventHook

  # Serialise before the call, never after: the JSON text has to be a local
  # whose lifetime spans the callee, and `($node).cstring` as an argument
  # expression is a temporary the compiler is free to free first. The host
  # copies what it needs before returning (frameos/driver_abi).

  # The origin does not cross the `.so` boundary: whatever a driver library
  # sends, the host stamps `driver` on it (drivers/drivers.nim). The parameter
  # is here so a driver's source reads the same compiled in or as a library.

  # Send an event to the current scene
  proc sendEvent*(event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    if not sharedHostSendEventHook.isNil:
      let payloadText = $payload
      sharedHostSendEventHook(nil, event.cstring, payloadText.cstring)

  # Send an event to a specific scene
  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    if not sharedHostSendEventHook.isNil:
      let payloadText = $payload
      let sceneText = if scene.isSome: scene.get().string else: ""
      sharedHostSendEventHook(
        if scene.isSome: sceneText.cstring else: nil,
        event.cstring,
        payloadText.cstring,
      )

  proc sendEventOwned*(event: string, payload: sink JsonNode, origin: EventOrigin) {.gcsafe.} =
    sendEvent(event, payload, origin)

  var sharedHostInputHook: HostInputEventProc

  proc setSharedHostInputHook*(hook: HostInputEventProc) =
    sharedHostInputHook = hook

  proc sendInputEvent*(event: DriverInputEvent) {.gcsafe.} =
    ## Input as a struct (frameos/driver_abi). A host from before the hook
    ## existed gets the old JSON events instead, positions included; what the
    ## old host cannot take — a relative mouse's counts, which it has no cursor
    ## for — goes nowhere.
    if not sharedHostInputHook.isNil:
      var copy = event
      sharedHostInputHook(addr copy)
      return
    case DriverInputKind(event.kind)
    of dikPointerAbs: sendEvent("mouseMove", %*{"x": event.x.int, "y": event.y.int}, eoDriver)
    of dikPointerDown: sendEvent("mouseDown", %*{"button": event.code.int}, eoDriver)
    of dikPointerUp: sendEvent("mouseUp", %*{"button": event.code.int}, eoDriver)
    of dikWheel: sendEvent("wheel", %*{"deltaX": event.x.int, "deltaY": event.y.int}, eoDriver)
    of dikKeyDown, dikKeyUp:
      if event.value != 2:
        sendEvent(if event.kind == ord(dikKeyDown).cint: "keyDown" else: "keyUp",
          %*{"key": "", "code": event.code.int}, eoDriver)
    of dikPointerRel, dikPointerCancel, dikNone: discard

  proc log*(event: JsonNode) {.gcsafe.} =
    if not sharedHostLogHook.isNil:
      let eventText = $event
      sharedHostLogHook(eventText.cstring)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})
elif defined(frameosEmbedded) or defined(frameosWasm):
  # Single-task embedded/wasm runtime: no OS threads, so no Nim channels.
  # Logs and events go straight through hooks that the host runtime installs
  # (ESP_LOGI via the firmware's C log hook on ESP32; postMessage via the
  # emscripten JS glue in the browser). Events trigger renders.
  import json
  import options
  import frameos/ids
  import frameos/driver_abi
  import frameos/events_gen
  export events_gen.EventOrigin

  type
    EmbeddedLogHook* = proc(payload: JsonNode) {.gcsafe, nimcall.}
    EmbeddedEventHook* = proc(sceneId: Option[SceneId], event: string,
                             payload: JsonNode, origin: EventOrigin) {.gcsafe, nimcall.}

  var embeddedLogHook*: EmbeddedLogHook
  var embeddedEventHook*: EmbeddedEventHook

  proc setSharedHostCallbacks*(logHook: HostLogProc, sendEventHook: HostSendEventProc) =
    discard

  # The hook queues (frameos/event_loop): what a scene dispatches is delivered
  # after the run that dispatched it, here like on Linux.
  proc sendEvent*(event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    if not embeddedEventHook.isNil:
      embeddedEventHook(none(SceneId), event, payload, origin)

  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    if not embeddedEventHook.isNil:
      embeddedEventHook(scene, event, payload, origin)

  proc sendEventOwned*(event: string, payload: sink JsonNode, origin: EventOrigin) {.gcsafe.} =
    sendEvent(event, payload, origin)

  proc sendInputEvent*(event: DriverInputEvent) {.gcsafe.} =
    ## No input drivers on these hosts: the page and the firmware send JSON.
    discard

  proc log*(eventPayload: JsonNode) {.gcsafe.} =
    if not embeddedLogHook.isNil:
      embeddedLogHook(eventPayload)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})

  proc triggerServerRender*() =
    discard

  proc noteSceneImageSaved*() {.gcsafe.} =
    discard

  proc sceneImageGenerationValue*(): int {.gcsafe.} =
    0
else:
  import json
  import options
  import times
  import std/atomics
  import frameos/ids
  import frameos/driver_abi
  import frameos/types
  import frameos/events_gen
  export events_gen.EventOrigin

  proc setSharedHostCallbacks*(logHook: HostLogProc, sendEventHook: HostSendEventProc) =
    discard

  # Event

  # One message: the target scene (none = the current one), the event, its
  # payload, and the origin — who is saying it. The origin is set by the
  # producer's own entry point and never read from the payload; the runner's
  # dispatcher (frameos/event_loop) asks the contract's allow-list of it.
  type EventMessage* = (Option[SceneId], string, JsonNode, EventOrigin)

  # Bounded: the runner drains this on a single thread that can be busy for
  # the full duration of an e-ink render or a slow event handler. Producers
  # (touch input, HTTP routes, scheduler) must drop instead of growing the
  # queue without limit; the runner reports drops once it catches up.
  var eventChannel*: Channel[EventMessage]
  eventChannel.open(1000)

  # Count of events dropped because eventChannel was full; the runner
  # resets it and reports the total when it catches up.
  var eventsDroppedCounter*: Atomic[int]

  # The payload changes threads here, and under ORC a Channel MOVES its
  # message — the deep copy in the channel docs is refc's (system/
  # channels_builtin: `copyMem` when usesDestructors). Sending the caller's
  # node would leave the HTTP worker (or the scheduler, the hub client, a
  # touch driver) and the runner holding one JsonNode, each moving its
  # refcounts without the other knowing: the sender's scope exit races the
  # runner's first read. So the runner gets a tree nobody else has.
  proc isolatedPayload(payload: JsonNode): JsonNode =
    if payload.isNil: nil else: copy(payload)

  # The runner thread owns the dispatcher, so what is sent ON it — a scene's
  # dispatch node, mostly — goes straight into the dispatcher's queue: no copy,
  # no channel slot, and the dispatcher sees it arrive while the run that sent
  # it is still going, which is how it knows a render's own dispatches from
  # everybody else's (event_loop.nim, `hostRun`). Every other thread has no
  # sink and uses the channel.
  type LocalEventSink* = proc(scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.}
  var localEventSink* {.threadvar.}: LocalEventSink

  proc queueEvent(scene: Option[SceneId], event: string, payload: sink JsonNode, origin: EventOrigin,
                  owned: bool): bool {.gcsafe.} =
    if not localEventSink.isNil:
      localEventSink(scene, event, payload, origin)
      return true
    result = eventChannel.trySend((scene, event, (if owned: payload else: isolatedPayload(payload)), origin))
    if not result:
      atomicInc(eventsDroppedCounter)

  # Send an event to the current scene
  proc sendEvent*(event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    discard queueEvent(none(SceneId), event, payload, origin, owned = false)

  # Send an event to a specific scene
  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    discard queueEvent(scene, event, payload, origin, owned = false)

  proc trySendEvent*(event: string, payload: JsonNode, origin: EventOrigin): bool {.gcsafe.} =
    ## sendEvent for a caller that has to know whether the event was queued
    ## (the hub client must not ack a scene push the runner never saw).
    queueEvent(none(SceneId), event, payload, origin, owned = false)

  proc sendEventOwned*(event: string, payload: sink JsonNode, origin: EventOrigin) {.gcsafe.} =
    ## sendEvent without the copy, for a payload too big to hold twice (a
    ## scene upload is megabytes of JSON on a 512 MB frame). The caller gives
    ## the tree up: pass a fresh parse with `move`, keep no reference to it or
    ## to any node inside it.
    discard queueEvent(none(SceneId), event, payload, origin, owned = true)

  # Input from a driver as a plain struct (frameos/driver_abi): values only, so
  # a mouse at 1000 Hz allocates nothing on its way to the runner, and nothing
  # of it is a ref two threads could hold. Bounded like eventChannel; the
  # runner drains it into the dispatcher's input lane (event_loop.enqueueInput),
  # which coalesces moves and never drops a release without a cancel.
  var inputChannel*: Channel[DriverInputEvent]
  inputChannel.open(1000)

  proc sendInputEvent*(event: DriverInputEvent) {.gcsafe.} =
    if not inputChannel.trySend(event):
      atomicInc(eventsDroppedCounter)

  # Log

  # Bounded: if the logger thread stalls (e.g. sending logs over a flaky
  # network), producers must drop logs instead of growing this queue until
  # the device swaps itself into an unreachable state.
  var logChannel*: Channel[SerializedLog]
  logChannel.open(5000)

  var logBroadcastChannel*: Channel[SerializedLog]
  logBroadcastChannel.open(5000)

  # Bounded feed for the cloud hub client (frameos/cloud/hub_client.nim).
  # Only written while a managed-mode session with the telemetry:logs scope is
  # live — gated by the flag below so an idle channel never accumulates stale
  # lines that would all be replayed on the next connect.
  var cloudLogChannel*: Channel[SerializedLog]
  cloudLogChannel.open(1000)
  var cloudLogForwardingEnabled*: Atomic[bool]

  # Count of logs dropped because logChannel was full; the logger thread
  # resets it and reports the total when it catches up.
  var logsDroppedCounter*: Atomic[int]

  # Same, for the cloud forwarding queue. A frame whose uplink is slower than
  # it logs silently ships an incomplete picture otherwise; the hub client
  # reports and resets this alongside its batches.
  var cloudLogsDroppedCounter*: Atomic[int]

  proc log*(eventPayload: JsonNode) {.gcsafe.} =
    let eventName = if eventPayload.kind == JObject: eventPayload{"event"}.getStr("log") else: "log"
    let payload = SerializedLog(timestamp: epochTime(), event: eventName, line: $eventPayload)
    if not logChannel.trySend(payload):
      atomicInc(logsDroppedCounter)
    discard logBroadcastChannel.trySend(payload)
    if cloudLogForwardingEnabled.load(moRelaxed):
      if not cloudLogChannel.trySend(payload):
        atomicInc(cloudLogsDroppedCounter)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})

  # Server

  var serverChannel*: Channel[bool]
  serverChannel.open(1)

  proc triggerServerRender*() =
    discard serverChannel.trySend(true)

  # Bumped every time the runner writes a per-scene snapshot PNG. The cloud
  # hub client polls it (an int read, not a channel, because several readers
  # must be able to observe the same render and a channel has one consumer)
  # and tells the provider "there is a new preview to fetch" — but only while
  # someone has the frame open, so an unwatched frame costs one atomic
  # increment and nothing else. See docs/cloud-frames.md, "Previews".
  var sceneImageGeneration: Atomic[int]

  proc noteSceneImageSaved*() {.gcsafe.} =
    atomicInc(sceneImageGeneration)

  proc sceneImageGenerationValue*(): int {.gcsafe.} =
    sceneImageGeneration.load(moRelaxed)

  # Bumped after every push to the display driver. The admin panel's
  # `/api/frames/1/image` encodes what the panel shows into a PNG on demand
  # — a second and more at 1080p on a Pi, nine on a busy one — and caches the
  # result under this number (server/api.nim), so the two workspace tiles and
  # the two "render" signals that ask after one render cost one encode.
  var driverRenderGeneration: Atomic[int]

  proc noteDriverRendered*() {.gcsafe.} =
    atomicInc(driverRenderGeneration)

  proc driverRenderGenerationValue*(): int {.gcsafe.} =
    driverRenderGeneration.load(moRelaxed)
