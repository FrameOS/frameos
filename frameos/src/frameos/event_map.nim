## The event map of an installed scene (docs/events.md, "Event map").
##
## A frame has the buttons it has (LEFT, RIGHT, REFRESH) and a scene listens
## for the ones its author had (A, B, C, D). The map is the installed copy's
## list of rules, kept by the control plane beside the scene — next to `nodes`,
## never inside them, so a scene update leaves it alone — and applied by the
## one dispatcher (event_loop.nim) on every host, right before a scene is
## asked whether it listens: an event of the rule's name whose payload carries
## every `match` value is delivered with `as` written over its payload. The
## first rule that matches wins; a payload no rule matches is delivered as it
## came. A rule changes fields, never the event's name.
##
##   {"event": "button", "match": {"label": "REFRESH", "action": "longPress"},
##    "as": {"label": "B", "role": "next", "action": "press"}}
##
## The map is kept as the JSON it arrived in (an ESP32 holds eight rules at
## most, and a press is rare: a type of its own would cost more flash than
## the walk costs time). What is not a rule — no `event` name, no `as` object
## — never matches, and is never fatal: a scene with an odd map still renders.
## Values are compared in their string form (`"17"` matches the pin 17), the
## way an event node's filters are (values.nim, eventPayloadValueMatches).
import std/json
import frameos/values

proc isEventMapRule*(rule: JsonNode): bool =
  ## An object with an event name and an `as` object.
  not rule.isNil and rule.kind == JObject and rule{"event"}.getStr().len > 0 and
    rule{"as"}.kind == JObject

proc eventMapRuleMatches*(rule: JsonNode, name: string, payload: JsonNode): bool =
  ## A rule of `name` whose every `match` value the payload carries.
  if not rule.isEventMapRule() or rule["event"].getStr() != name:
    return false
  let match = rule{"match"}
  if match.isNil:
    return true
  if match.kind != JObject:
    return false
  for key, expected in match.pairs:
    if not eventPayloadValueMatches(payload, key, eventFilterValue(expected)):
      return false
  true

proc matchingEventMapRule*(rules: JsonNode, name: string, payload: JsonNode): int =
  ## The index of the first rule that matches, -1 when none does (or there
  ## is no map).
  if rules.isNil or rules.kind != JArray:
    return -1
  for index, rule in rules.elems:
    if rule.eventMapRuleMatches(name, payload):
      return index
  -1

proc applyEventMapRule*(rule: JsonNode, payload: JsonNode): JsonNode =
  ## The payload the scene gets: a copy with the rule's `as` written over it.
  result = if payload.isNil or payload.kind != JObject: newJObject() else: copy(payload)
  for key, value in rule["as"].pairs:
    result[key] = copy(value)
