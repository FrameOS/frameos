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

  var logChannel*: Channel[(float, string)]
  logChannel.open()

  var logBroadcastChannel*: Channel[(float, string)]
  logBroadcastChannel.open(5000)

  proc log*(event: JsonNode) {.gcsafe.} =
    let payload = (epochTime(), $event)
    logChannel.send(payload)
    discard logBroadcastChannel.trySend(payload)

  proc debug*(message: string) =
    log(%*{"event": "debug", "message": message})

  # Server

  var serverChannel*: Channel[bool]
  serverChannel.open(1)

  proc triggerServerRender*() =
    discard serverChannel.trySend(true)
