import json, options, strutils

# Evaluates "showIf" visibility conditions for state fields. The semantics
# mirror the frontend evaluator in frontend/src/utils/showIf.ts: top level
# conditions are OR-ed, "and" blocks are AND-ed, and a field with no
# conditions is always visible.

proc jsonTruthy*(node: JsonNode): bool =
  if node.isNil:
    return false
  case node.kind
  of JNull: false
  of JBool: node.getBool()
  of JInt: node.getInt() != 0
  of JFloat: node.getFloat() != 0.0
  of JString: node.getStr().len > 0
  # Containers are always truthy, matching JS `!!` in the other evaluators
  of JArray: true
  of JObject: true

proc jsonEquals(a, b: JsonNode): bool =
  if a.isNil or b.isNil:
    return a.isNil and b.isNil
  # Allow ints and floats to compare equal across kinds, like JS `===` on numbers
  if a.kind in {JInt, JFloat} and b.kind in {JInt, JFloat}:
    return a.getFloat() == b.getFloat()
  a == b

proc jsonCompare(a, b: JsonNode): Option[int] =
  if a.isNil or b.isNil:
    return none(int)
  if a.kind in {JInt, JFloat} and b.kind in {JInt, JFloat}:
    return some(cmp(a.getFloat(), b.getFloat()))
  if a.kind == JString and b.kind == JString:
    return some(cmp(a.getStr(), b.getStr()))
  none(int)

proc jsonIncludes(value, actual: JsonNode): bool =
  if value.isNil:
    return false
  case value.kind
  of JArray:
    for item in value:
      if jsonEquals(item, actual):
        return true
    false
  of JString:
    not actual.isNil and actual.kind == JString and value.getStr().contains(actual.getStr())
  else:
    false

proc matchCondition(condition: JsonNode, values: JsonNode, currentFieldName: string): bool =
  if condition.isNil or condition.kind != JObject:
    return false
  if condition.hasKey("and"):
    let group = condition["and"]
    if group.kind != JArray:
      return false
    for sub in group:
      if not matchCondition(sub, values, currentFieldName):
        return false
    return true

  let fieldName = condition{"field"}.getStr()
  let field = if fieldName.len > 0: fieldName else: currentFieldName
  let hasValue = condition.hasKey("value") and condition["value"].kind != JNull
  let value = condition{"value"}
  let operator = condition{"operator"}.getStr()
  let actual = if not values.isNil and values.kind == JObject and values.hasKey(field):
      values[field]
    else:
      nil

  case operator
  of "eq": jsonEquals(actual, value)
  of "ne": not jsonEquals(actual, value)
  of "gt":
    let c = jsonCompare(actual, value)
    c.isSome and c.get() > 0
  of "lt":
    let c = jsonCompare(actual, value)
    c.isSome and c.get() < 0
  of "gte":
    let c = jsonCompare(actual, value)
    c.isSome and c.get() >= 0
  of "lte":
    let c = jsonCompare(actual, value)
    c.isSome and c.get() <= 0
  of "in": jsonIncludes(value, actual)
  of "notIn": not jsonIncludes(value, actual)
  of "empty": not jsonTruthy(actual)
  of "notEmpty": jsonTruthy(actual)
  else:
    if hasValue: jsonEquals(actual, value) else: jsonTruthy(actual)

proc shouldShowField*(showIf: JsonNode, values: JsonNode, currentFieldName = ""): bool =
  ## Returns true when a field with the given showIf conditions should be
  ## visible for the given values (a JObject of field name -> value).
  if showIf.isNil or showIf.kind != JArray or showIf.len == 0:
    return true
  for condition in showIf:
    if matchCondition(condition, values, currentFieldName):
      return true
  false
