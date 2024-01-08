import json

var eventChannel*: Channel[(string, JsonNode)]
eventChannel.open()

var logChannel*: Channel[JsonNode]
logChannel.open()
