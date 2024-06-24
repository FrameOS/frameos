import json
import options
import frameos/types

# Event

var eventChannel*: Channel[(Option[SceneId], string, JsonNode)]
eventChannel.open()

# Send an event to the current scene
proc sendEvent*(event: string, payload: JsonNode) =
  eventChannel.send((none(SceneId), event, payload))

# Send an event to a specific scene
proc sendEvent*(scene: Option[SceneId], event: string, payload: JsonNode) =
  eventChannel.send((scene, event, payload))

# Log

var logChannel*: Channel[JsonNode]
logChannel.open()

proc log*(event: JsonNode) =
  logChannel.send(event)

proc debug*(message: string) =
  logChannel.send(%*{"event": "debug", "message": message})

# Server

var serverChannel*: Channel[bool]
serverChannel.open(1)

proc triggerServerRender*() =
  discard serverChannel.trySend(true)
