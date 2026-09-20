## What the frame log may say about a scene event. The log is stored by the
## control plane and, with telemetry on, sent to the cloud — so a key event is
## logged by name and never with its payload: from the moment a scene has a
## text field, anything else makes the frame a keylogger. Pointer and wheel
## events are not logged at all (one per motion report).
##
## Which event is which is the `log` column of docs/events-contract.json.

import std/json
import ./events

export events.eventIsLogged, events.eventLogsPayload

proc withEventPayload*(entry: JsonNode, event: string, payload: JsonNode): JsonNode =
  ## `entry` with the event's payload added, when that event's payload may be
  ## logged at all.
  if eventLogsPayload(event):
    entry["payload"] = if payload.isNil: newJNull() else: payload
  entry
