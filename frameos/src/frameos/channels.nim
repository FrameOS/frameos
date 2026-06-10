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

  var eventChannel*: Channel[(Option[SceneId], string, JsonNode)]
  eventChannel.open()

  # Send an event to the current scene
  proc sendEvent*(event: string, payload: JsonNode) {.gcsafe.} =
    eventChannel.send((none(SceneId), event, payload))

  # Send an event to a specific scene
  proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.} =
    eventChannel.send((scene, event, payload))

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
