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
## A map is kept as the JSON it arrived in (an ESP32 holds eight rules at
## most, and a press is rare: a type of its own would cost more flash than
## the walk costs time). What is not a rule — no `event` name, neither an
## `as` object nor an `emit` name — never matches, and is never fatal: a
## frame with an odd map still renders. Values are compared in their string
## form (`"17"` matches the pin 17), the way an event node's filters are
## (values.nim, eventPayloadValueMatches).
import std/json
import frameos/values

# Written with the `{}` accessors throughout: on a JsonNode every `[]` is a
# raise site of its own, and this runs on a 3 MB firmware. `{}` is nil for a
# key that is not there, and nil has no `kind`: hence isObject.

proc isObject(node: JsonNode): bool {.inline.} =
  not node.isNil and node.kind == JObject

proc eventMapRuleEmits*(rule: JsonNode): string =
  ## The event a rule emits in place of the one it matched, "" for a rewrite.
  rule{"emit"}.getStr()

proc eventMapRuleMatches*(rule: JsonNode, name: string, payload: JsonNode): bool =
  ## A rule (an object with an event name, and an `as` object or an `emit`
  ## name) of `name` whose every `match` value the payload carries.
  if not rule.isObject or rule{"event"}.getStr() != name:
    return false
  if not rule{"as"}.isObject and rule.eventMapRuleEmits().len == 0:
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

proc matchingEventMapRule*(rules: JsonNode, name: string, payload: JsonNode,
                           index: var int): JsonNode =
  ## The first rule that matches and its position, or nil when none does (or
  ## there is no map).
  if rules.isNil or rules.kind != JArray:
    return nil
  index = 0
  for rule in rules.elems:
    if rule.eventMapRuleMatches(name, payload):
      return rule
    inc index
  nil

proc eventMapRuleWrites*(rule: JsonNode): JsonNode =
  ## The rule's `as`: the fields a rewrite sets, or the payload an `emit`
  ## carries. An empty object when the rule has none.
  result = rule{"as"}
  if not result.isObject:
    result = newJObject()

proc applyEventMapRule*(rule: JsonNode, payload: JsonNode): JsonNode =
  ## The payload the scene gets from a rewrite: a copy with the rule's `as`
  ## written over it. (An `emit` rule's payload is its `as` alone.)
  result = if payload.isNil or payload.kind != JObject: newJObject() else: copy(payload)
  for key, value in rule.eventMapRuleWrites().pairs:
    result[key] = copy(value)
