## What the frame log may say about a scene event. The log is stored by the
## control plane and, with telemetry on, sent to the cloud — so a key event is
## logged by name and never with its payload: from the moment a scene has a
## text field, anything else makes the frame a keylogger. Pointer and wheel
## events are not logged at all (one per motion report).
##
## docs/event-system-analysis.md §4.1 turns this into a per-event `log` column
## of a generated contract; until then this is the one place that knows.

import std/json

proc eventIsLogged*(event: string): bool =
  event.len < 5 or (event[0 .. 4] != "mouse" and event != "wheel")

proc eventLogsPayload*(event: string): bool =
  event != "keyDown" and event != "keyUp"

proc withEventPayload*(entry: JsonNode, event: string, payload: JsonNode): JsonNode =
  ## `entry` with the event's payload added, when that event's payload may be
  ## logged at all.
  if eventLogsPayload(event):
    entry["payload"] = if payload.isNil: newJNull() else: payload
  entry
