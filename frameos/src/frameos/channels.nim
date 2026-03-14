import json
import options
import times
import frameos/types

# Event

var eventChannel*: Channel[(Option[SceneId], string, JsonNode)]
eventChannel.open()

# Send an event to the current scene
proc sendEvent*(event: string, payload: JsonNode) {.gcsafe.} =
  eventChannel.send((none(SceneId), event, payload))

# Send an event to a specific scene
proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) =
  eventChannel.send((scene, event, payload))

# Log

var logChannel*: Channel[(float, JsonNode)]
logChannel.open()

var logBroadcastChannel*: Channel[(float, JsonNode)]
logBroadcastChannel.open(5000)

proc log*(event: JsonNode) =
  let payload = (epochTime(), event)
  echo payload
  logChannel.send(payload)
  discard logBroadcastChannel.trySend(payload)

proc debug*(message: string) =
  log(%*{"event": "debug", "message": message})

# Server

var serverChannel*: Channel[bool]
serverChannel.open(1)

proc triggerServerRender*() =
  discard serverChannel.trySend(true)
