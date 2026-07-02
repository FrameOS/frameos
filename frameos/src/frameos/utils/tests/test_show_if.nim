import json
import frameos/utils/show_if

block no_conditions_always_visible:
  doAssert shouldShowField(nil, %*{"a": 1})
  doAssert shouldShowField(newJArray(), %*{"a": 1})
  doAssert shouldShowField(%*[], %*{})

block eq_and_ne:
  let showIf = %*[{"field": "mode", "operator": "eq", "value": "clock"}]
  doAssert shouldShowField(showIf, %*{"mode": "clock"})
  doAssert not shouldShowField(showIf, %*{"mode": "weather"})
  doAssert not shouldShowField(showIf, %*{})
  let neCond = %*[{"field": "mode", "operator": "ne", "value": "clock"}]
  doAssert not shouldShowField(neCond, %*{"mode": "clock"})
  doAssert shouldShowField(neCond, %*{"mode": "weather"})

block numeric_comparisons:
  doAssert shouldShowField(%*[{"field": "n", "operator": "gt", "value": 5}], %*{"n": 6})
  doAssert not shouldShowField(%*[{"field": "n", "operator": "gt", "value": 5}], %*{"n": 5})
  doAssert shouldShowField(%*[{"field": "n", "operator": "gte", "value": 5}], %*{"n": 5})
  doAssert shouldShowField(%*[{"field": "n", "operator": "lt", "value": 5}], %*{"n": 4.5})
  doAssert shouldShowField(%*[{"field": "n", "operator": "lte", "value": 5.0}], %*{"n": 5})
  # Missing or non-numeric values never satisfy relational operators
  doAssert not shouldShowField(%*[{"field": "n", "operator": "gt", "value": 5}], %*{})
  doAssert not shouldShowField(%*[{"field": "n", "operator": "gt", "value": 5}], %*{"n": "abc"})

block in_and_not_in:
  let inCond = %*[{"field": "mode", "operator": "in", "value": ["a", "b"]}]
  doAssert shouldShowField(inCond, %*{"mode": "a"})
  doAssert not shouldShowField(inCond, %*{"mode": "c"})
  let notInCond = %*[{"field": "mode", "operator": "notIn", "value": ["a", "b"]}]
  doAssert not shouldShowField(notInCond, %*{"mode": "a"})
  doAssert shouldShowField(notInCond, %*{"mode": "c"})

block empty_and_not_empty:
  let emptyCond = %*[{"field": "url", "operator": "empty"}]
  doAssert shouldShowField(emptyCond, %*{"url": ""})
  doAssert shouldShowField(emptyCond, %*{})
  doAssert not shouldShowField(emptyCond, %*{"url": "http://x"})
  let notEmptyCond = %*[{"field": "url", "operator": "notEmpty"}]
  doAssert not shouldShowField(notEmptyCond, %*{"url": ""})
  doAssert shouldShowField(notEmptyCond, %*{"url": "http://x"})
  doAssert not shouldShowField(notEmptyCond, %*{"url": false})
  doAssert shouldShowField(notEmptyCond, %*{"url": 1})

block containers_are_truthy_like_js:
  let notEmptyCond = %*[{"field": "data", "operator": "notEmpty"}]
  doAssert shouldShowField(notEmptyCond, %*{"data": []})
  doAssert shouldShowField(notEmptyCond, %*{"data": {}})
  let emptyCond = %*[{"field": "data", "operator": "empty"}]
  doAssert not shouldShowField(emptyCond, %*{"data": []})
  doAssert not shouldShowField(emptyCond, %*{"data": {}})

block boolean_values:
  let showIf = %*[{"field": "showMetadata", "operator": "eq", "value": true}]
  doAssert shouldShowField(showIf, %*{"showMetadata": true})
  doAssert not shouldShowField(showIf, %*{"showMetadata": false})

block or_of_top_level_conditions:
  let showIf = %*[
    {"field": "mode", "operator": "eq", "value": "a"},
    {"field": "mode", "operator": "eq", "value": "b"}
  ]
  doAssert shouldShowField(showIf, %*{"mode": "a"})
  doAssert shouldShowField(showIf, %*{"mode": "b"})
  doAssert not shouldShowField(showIf, %*{"mode": "c"})

block and_groups:
  let showIf = %*[{"and": [
    {"field": "mode", "operator": "eq", "value": "a"},
    {"field": "n", "operator": "gt", "value": 1}
  ]}]
  doAssert shouldShowField(showIf, %*{"mode": "a", "n": 2})
  doAssert not shouldShowField(showIf, %*{"mode": "a", "n": 1})
  doAssert not shouldShowField(showIf, %*{"mode": "b", "n": 2})

block default_operator:
  # No operator + value: equality
  doAssert shouldShowField(%*[{"field": "mode", "value": "a"}], %*{"mode": "a"})
  doAssert not shouldShowField(%*[{"field": "mode", "value": "a"}], %*{"mode": "b"})
  # No operator, no value: truthy check
  doAssert shouldShowField(%*[{"field": "flag"}], %*{"flag": true})
  doAssert not shouldShowField(%*[{"field": "flag"}], %*{"flag": false})
  doAssert not shouldShowField(%*[{"field": "flag"}], %*{})

block condition_field_defaults_to_current_field:
  let showIf = %*[{"operator": "notEmpty"}]
  doAssert shouldShowField(showIf, %*{"me": "set"}, "me")
  doAssert not shouldShowField(showIf, %*{"me": ""}, "me")

block int_float_equality:
  doAssert shouldShowField(%*[{"field": "n", "operator": "eq", "value": 5}], %*{"n": 5.0})
  doAssert shouldShowField(%*[{"field": "n", "operator": "eq", "value": 5.0}], %*{"n": 5})

echo "test_show_if: all assertions passed"
