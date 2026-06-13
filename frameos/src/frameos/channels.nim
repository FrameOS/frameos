when defined(frameosDriverLibrary) or defined(frameosSharedLibrary):
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

  # Send an event to the current scene
  proc sendEvent*(event: string, payload: JsonNode) {.gcsafe.} =
    if not sharedHostSendEventHook.isNil:
      sharedHostSendEventHook(none(SceneId), event, payload)

  # Send an event to a specific scene
  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.} =
    if not sharedHostSendEventHook.isNil:
      sharedHostSendEventHook(scene, event, payload)

  proc log*(event: JsonNode) {.gcsafe.} =
    if not sharedHostLogHook.isNil:
      sharedHostLogHook(event)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})
elif defined(frameosEmbedded):
  # Single-task embedded runtime: no OS threads, so no Nim channels. Logs and
  # events go straight through hooks that the embedded runtime installs (logs
  # end up at ESP_LOGI via the firmware's C log hook; events trigger renders).
  import json
  import options
  import frameos/ids
  import frameos/driver_abi

  var embeddedLogHook*: proc(payload: JsonNode) {.gcsafe.}
  var embeddedEventHook*: proc(sceneId: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.}

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

  # Count of logs dropped because logChannel was full; the logger thread
  # resets it and reports the total when it catches up.
  var logsDroppedCounter*: Atomic[int]

  proc log*(eventPayload: JsonNode) {.gcsafe.} =
    let eventName = if eventPayload.kind == JObject: eventPayload{"event"}.getStr("log") else: "log"
    let payload = SerializedLog(timestamp: epochTime(), event: eventName, line: $eventPayload)
    if not logChannel.trySend(payload):
      atomicInc(logsDroppedCounter)
    discard logBroadcastChannel.trySend(payload)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})

  # Server

  var serverChannel*: Channel[bool]
  serverChannel.open(1)

  proc triggerServerRender*() =
    discard serverChannel.trySend(true)
