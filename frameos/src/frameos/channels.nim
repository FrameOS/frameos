import json
import options
import times
import frameos/types

# Event

var eventChannel*: Channel[(Option[SceneId], string, JsonNode)]
eventChannel.open()

proc sendCurrentEventLocal(event: string, payload: JsonNode) {.cdecl, gcsafe.} =
  eventChannel.send((none(SceneId), event, payload))

proc sendSceneEventLocal(scene: Option[SceneId], event: string, payload: JsonNode) {.cdecl, gcsafe.} =
  eventChannel.send((scene, event, payload))

var sendCurrentEventHook: SendCurrentEventHook = sendCurrentEventLocal
var sendSceneEventHook: SendSceneEventHook = sendSceneEventLocal

# Send an event to the current scene
proc sendEvent*(event: string, payload: JsonNode) {.gcsafe.} =
  sendCurrentEventHook(event, payload)

# Send an event to a specific scene
proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) {.gcsafe.} =
  sendSceneEventHook(scene, event, payload)

# Log

var logChannel*: Channel[(float, JsonNode)]
logChannel.open()

var logBroadcastChannel*: Channel[(float, JsonNode)]
logBroadcastChannel.open(5000)

proc logLocal(event: JsonNode) {.cdecl, gcsafe.} =
  let payload = (epochTime(), event)
  echo payload
  logChannel.send(payload)
  discard logBroadcastChannel.trySend(payload)

var logEventHook: LogEventHook = logLocal

proc log*(event: JsonNode) {.gcsafe.} =
  logEventHook(event)

proc debug*(message: string) =
  log(%*{"event": "debug", "message": message})

# Server

var serverChannel*: Channel[bool]
serverChannel.open(1)

proc triggerServerRenderLocal() {.cdecl, gcsafe.} =
  discard serverChannel.trySend(true)

var triggerServerRenderHook: TriggerServerRenderHook = triggerServerRenderLocal

proc triggerServerRender*() {.gcsafe.} =
  triggerServerRenderHook()

proc getCompiledRuntimeHooks*(): CompiledRuntimeHooks =
  CompiledRuntimeHooks(
    sendCurrentEvent: sendCurrentEventHook,
    sendSceneEvent: sendSceneEventHook,
    logEvent: logEventHook,
    triggerServerRender: triggerServerRenderHook,
  )

proc bindCompiledRuntimeHooks*(hooks: ptr CompiledRuntimeHooks) =
  if hooks.isNil:
    return
  if hooks.sendCurrentEvent != nil:
    sendCurrentEventHook = hooks.sendCurrentEvent
  if hooks.sendSceneEvent != nil:
    sendSceneEventHook = hooks.sendSceneEvent
  if hooks.logEvent != nil:
    logEventHook = hooks.logEvent
  if hooks.triggerServerRender != nil:
    triggerServerRenderHook = hooks.triggerServerRender
