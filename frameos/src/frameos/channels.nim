import json

# Event

var eventChannel*: Channel[(string, JsonNode)]
eventChannel.open()

proc sendEvent*(event: string, payload: JsonNode) =
  eventChannel.send((event, payload))

# Log

var logChannel*: Channel[JsonNode]
logChannel.open()

proc log*(event: JsonNode) =
  logChannel.send(event)

# Server

var serverChannel*: Channel[bool]
serverChannel.open(1)

proc triggerServerRender*() =
  discard serverChannel.trySend(true)
