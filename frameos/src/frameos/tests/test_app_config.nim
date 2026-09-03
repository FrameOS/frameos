import std/[json, options, unittest]
import pixie
import ../app_config
import ../ids
import ../types
import ../values

type
  # Shaped like a generated AppConfig: scalars the descriptor table covers,
  # mixed with the ref/option/seq fields the loader still fills in by hand, so
  # the offsets have to survive a realistic layout.
  DemoConfig = object
    theme: string
    inputImage: Option[Image]
    year: int
    ratio: float
    startWeekOnMonday: bool
    background: Color
    events: JsonNode
    target: NodeId
    rows: seq[int]
    label: string

const demoFields = [
  cfgFieldStr(DemoConfig, theme),
  cfgFieldInt(DemoConfig, year),
  cfgFieldFloat(DemoConfig, ratio),
  cfgFieldBool(DemoConfig, startWeekOnMonday),
  cfgFieldColor(DemoConfig, background),
  cfgFieldNode(DemoConfig, target),
  cfgFieldStr(DemoConfig, label),
]

proc defaults(): DemoConfig =
  DemoConfig(
    theme: "light",
    inputImage: none(Image),
    year: 2000,
    ratio: 1.5,
    startWeekOnMonday: true,
    background: parseHtmlColor("#ffffff"),
    events: newJArray(),
    target: 0.NodeId,
    rows: @[1, 2, 3],
    label: "unset",
  )

suite "app config descriptor tables":
  test "offsets address the right field":
    var config = defaults()
    applyConfigParams(addr config, demoFields, %*{
      "theme": "dark",
      "year": 2026,
      "ratio": 2.25,
      "startWeekOnMonday": false,
      "background": "#808080",
      "target": 7,
      "label": "hello",
    })
    check config.theme == "dark"
    check config.year == 2026
    check config.ratio == 2.25
    check config.startWeekOnMonday == false
    check config.background == parseHtmlColor("#808080")
    check config.target.int == 7
    check config.label == "hello"
    # the fields the table does not describe are untouched
    check config.inputImage.isNone
    check config.events.kind == JArray
    check config.rows == @[1, 2, 3]

  test "absent keys keep their defaults":
    var config = defaults()
    applyConfigParams(addr config, demoFields, %*{"year": 1999})
    check config.year == 1999
    check config.theme == "light"
    check config.ratio == 1.5
    check config.startWeekOnMonday
    check config.background == parseHtmlColor("#ffffff")
    check config.label == "unset"

  test "numbers and booleans may arrive as strings":
    var config = defaults()
    applyConfigParams(addr config, demoFields, %*{
      "year": "2026",
      "ratio": "2.5",
      "startWeekOnMonday": "no",
      "target": "9",
    })
    check config.year == 2026
    check config.ratio == 2.5
    check config.startWeekOnMonday == false
    check config.target.int == 9

  test "unreadable values leave the default in place":
    var config = defaults()
    applyConfigParams(addr config, demoFields, %*{
      "year": "not a number",
      "theme": 12,
      "background": "not a colour",
      "startWeekOnMonday": true,
    })
    check config.year == 2000
    check config.theme == "light"
    check config.background == parseHtmlColor("#ffffff")
    check config.startWeekOnMonday

  test "a null config object is a no-op":
    var config = defaults()
    applyConfigParams(addr config, demoFields, nil)
    applyConfigParams(addr config, demoFields, newJArray())
    check config.theme == "light"
    check config.year == 2000

  test "setConfigField assigns wired values by name":
    var config = defaults()
    check setConfigField(addr config, demoFields, "theme", VString("wired"))
    check setConfigField(addr config, demoFields, "year", VInt(4))
    check setConfigField(addr config, demoFields, "ratio", VFloat(0.25))
    check setConfigField(addr config, demoFields, "startWeekOnMonday", VBool(false))
    check setConfigField(addr config, demoFields, "background", VColor(parseHtmlColor("#010203")))
    check setConfigField(addr config, demoFields, "target", VNode(42.NodeId))
    check config.theme == "wired"
    check config.year == 4
    check config.ratio == 0.25
    check config.startWeekOnMonday == false
    check config.background == parseHtmlColor("#010203")
    check config.target.int == 42

  test "setConfigField reports fields it does not cover":
    var config = defaults()
    check not setConfigField(addr config, demoFields, "events", VJson(newJObject()))
    check not setConfigField(addr config, demoFields, "nope", VInt(1))
    check config.events.kind == JArray

  test "strings assigned repeatedly do not leak their old payload":
    var config = defaults()
    for i in 0 ..< 100:
      check setConfigField(addr config, demoFields, "label",
                           VString("value-" & $i & "-padded-out-past-the-small-string"))
    check config.label == "value-99-padded-out-past-the-small-string"

  test "cfgInt reads a sibling dimension out of the raw config":
    let params = %*{"rows": 4, "cols": "6", "bad": "x"}
    check cfgInt(params, "rows", 1) == 4
    check cfgInt(params, "cols", 1) == 6
    check cfgInt(params, "bad", 3) == 3
    check cfgInt(params, "missing", 7) == 7
