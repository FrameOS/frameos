# `frameosSharedLibrary` used to select this branch too — it built a scene as
# its own `.so`. Those modes are gone (see LEGACY_COMPILATION_MODES in
# backend/app/codegen/drivers_nim.py); drivers are the only thing that still
# crosses a `.so` boundary.
when defined(frameosDriverLibrary):
  import json
  import options
  import frameos/ids
  import frameos/driver_abi

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

  # Send an event to the current scene
  proc sendEvent*(event: string, payload: JsonNode) {.gcsafe.} =
    if not sharedHostSendEventHook.isNil:
      let payloadText = $payload
      sharedHostSendEventHook(nil, event.cstring, payloadText.cstring)

  # Send an event to a specific scene
  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.} =
    if not sharedHostSendEventHook.isNil:
      let payloadText = $payload
      let sceneText = if scene.isSome: scene.get().string else: ""
      sharedHostSendEventHook(
        if scene.isSome: sceneText.cstring else: nil,
        event.cstring,
        payloadText.cstring,
      )

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

  type
    EmbeddedLogHook* = proc(payload: JsonNode) {.gcsafe, nimcall.}
    EmbeddedEventHook* = proc(sceneId: Option[SceneId], event: string,
                             payload: JsonNode) {.gcsafe, nimcall.}

  var embeddedLogHook*: EmbeddedLogHook
  var embeddedEventHook*: EmbeddedEventHook

  proc setSharedHostCallbacks*(logHook: HostLogProc, sendEventHook: HostSendEventProc) =
    discard

  proc sendEvent*(event: string, payload: JsonNode) {.gcsafe.} =
    if not embeddedEventHook.isNil:
      embeddedEventHook(none(SceneId), event, payload)

  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.} =
    if not embeddedEventHook.isNil:
      embeddedEventHook(scene, event, payload)

  proc log*(eventPayload: JsonNode) {.gcsafe.} =
    if not embeddedLogHook.isNil:
      embeddedLogHook(eventPayload)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})

  proc triggerServerRender*() =
    discard
else:
  import json
  import options
  import times
  import std/atomics
  import frameos/ids
  import frameos/driver_abi
  import frameos/types

  proc setSharedHostCallbacks*(logHook: HostLogProc, sendEventHook: HostSendEventProc) =
    discard

  # Event

  # Bounded: the runner drains this on a single thread that can be busy for
  # the full duration of an e-ink render or a slow event handler. Producers
  # (touch input, HTTP routes, scheduler) must drop instead of growing the
  # queue without limit; the runner reports drops once it catches up.
  var eventChannel*: Channel[(Option[SceneId], string, JsonNode)]
  eventChannel.open(1000)

  # Count of events dropped because eventChannel was full; the runner
  # resets it and reports the total when it catches up.
  var eventsDroppedCounter*: Atomic[int]

  # Send an event to the current scene
  proc sendEvent*(event: string, payload: JsonNode) {.gcsafe.} =
    if not eventChannel.trySend((none(SceneId), event, payload)):
      atomicInc(eventsDroppedCounter)

  # Send an event to a specific scene
  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.} =
    if not eventChannel.trySend((scene, event, payload)):
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
