## Event maps (docs/events.md, "Event map"): the frame's and an installed
## scene's.
##
## A frame has the buttons it has (LEFT, RIGHT, REFRESH) and a scene listens
## for the ones its author had (A, B, C, D). A map is a list of rules, each
## `{event, match, as, emit?}`: an event of the rule's name whose payload
## carries every `match` value is
##
## - **rewritten** when the rule has no `emit`: delivered with `as` written
##   over its payload ("a press of REFRESH is the scene's A");
## - **replaced** when it has one: the event `emit` names is dispatched with
##   `as` as its payload, from the origin `eventMap`, and the matched event
##   goes no further ("a long press of LEFT is the previous scene").
##
## Two maps, applied in this order by the one dispatcher (event_loop.nim) on
## every host, right before a scene is asked whether it listens: the frame's
## (frame.json `eventMap`, the control plane's "Button actions"), which needs
## no scene and wins over any scene, then the installed scene's (`eventMap`
## beside `nodes`, written by "Map buttons", kept across scene updates). In
## each, the first rule that matches wins; a payload no rule matches goes on
## as it came. What a rule emits is never mapped again.
##
##   {"event": "button", "match": {"label": "REFRESH", "action": "longPress"},
##    "as": {"label": "B", "role": "next", "action": "press"}}
##   {"event": "button", "match": {"label": "LEFT", "action": "longPress"},
##    "emit": "setCurrentScene", "as": {"direction": "prev"}}
##
## Values are compared in their string form (`"17"` matches the pin 17), the
## way an event node's filters are (interpreter.nim, eventFilterValue).
import std/[json, strutils]
import frameos/types

export EventMapRule

proc eventMapValue*(value: JsonNode): string =
  ## A payload or rule value as the string an event node's filter would see.
  if value.isNil:
    return ""
  case value.kind
  of JString: value.getStr().strip()
  of JInt: $value.getInt()
  of JFloat: $value.getFloat()
  of JBool: (if value.getBool(): "true" else: "false")
  of JNull: "null"
  else: $value

proc parseEventMap*(map: JsonNode): seq[EventMapRule] =
  ## The rules a control plane wrote, in order. What is not a rule — no event
  ## name, neither an `as` object nor an `emit` name, a `match` that is not an
  ## object — is skipped, never fatal: a frame with an odd map still renders.
  if map.isNil or map.kind != JArray:
    return @[]
  for item in map:
    if item.kind != JObject:
      continue
    let event = item{"event"}.getStr().strip()
    let emit = item{"emit"}.getStr().strip()
    var write = item{"as"}
    if event.len == 0:
      continue
    if write.isNil or write.kind != JObject:
      if emit.len == 0:
        continue
      write = newJObject()
    var rule = EventMapRule(event: event, write: write, emit: emit)
    let match = item{"match"}
    if not match.isNil:
      if match.kind != JObject:
        continue
      for key, value in match.pairs:
        rule.match.add((key, eventMapValue(value)))
    result.add(rule)

proc toJson*(rule: EventMapRule): JsonNode =
  ## The rule as a control plane writes it (the inverse of parseEventMap).
  result = %*{"event": rule.event}
  if rule.match.len > 0:
    var match = newJObject()
    for (key, value) in rule.match:
      match[key] = %value
    result["match"] = match
  if rule.emit.len > 0:
    result["emit"] = %rule.emit
  result["as"] = if rule.write.isNil: newJObject() else: copy(rule.write)

proc eventMapJson*(rules: seq[EventMapRule]): JsonNode =
  result = newJArray()
  for rule in rules:
    result.add(rule.toJson())

proc eventMapRuleMatches*(rule: EventMapRule, name: string, payload: JsonNode): bool =
  if rule.event != name:
    return false
  for (key, expected) in rule.match:
    let actual = if payload.isNil or payload.kind != JObject: nil else: payload{key}
    if eventMapValue(actual) != expected:
      return false
  true

proc matchingEventMapRule*(rules: seq[EventMapRule], name: string, payload: JsonNode): int =
  ## The index of the first rule that matches, -1 when none does.
  for index, rule in rules:
    if rule.eventMapRuleMatches(name, payload):
      return index
  -1

proc applyEventMapRule*(rule: EventMapRule, payload: JsonNode): JsonNode =
  ## The payload the scene gets from a rewrite: a copy with the rule's `as`
  ## written over it. (An `emit` rule's payload is its `as` alone.)
  result = if payload.isNil or payload.kind != JObject: newJObject() else: copy(payload)
  for key, value in rule.write.pairs:
    result[key] = copy(value)

proc applyEventMap*(rules: seq[EventMapRule], name: string, payload: JsonNode): JsonNode =
  ## The first matching rewrite rule applied, or nil when no rule matches
  ## (deliver what came). Emit rules are the dispatcher's to act on.
  let index = matchingEventMapRule(rules, name, payload)
  if index < 0 or rules[index].emit.len > 0: nil else: applyEventMapRule(rules[index], payload)
