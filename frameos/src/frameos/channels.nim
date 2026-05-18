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
  import frameos/ids
  import frameos/types

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

  var logChannel*: Channel[SerializedLog]
  logChannel.open()

  var logBroadcastChannel*: Channel[SerializedLog]
  logBroadcastChannel.open(5000)

  proc log*(eventPayload: JsonNode) {.gcsafe.} =
    let eventName = if eventPayload.kind == JObject: eventPayload{"event"}.getStr("log") else: "log"
    let payload = SerializedLog(timestamp: epochTime(), event: eventName, line: $eventPayload)
    logChannel.send(payload)
    discard logBroadcastChannel.trySend(payload)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})

  # Server

  var serverChannel*: Channel[bool]
  serverChannel.open(1)

  proc triggerServerRender*() =
    discard serverChannel.trySend(true)
