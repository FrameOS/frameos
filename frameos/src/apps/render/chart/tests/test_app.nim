import std/[json, unittest]
import pixie
import chroma

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc newTestApp(data: JsonNode, chartType: string, logs: LogStore): App =
  let scene = FrameScene(state: %*{}, logger: newLogger(logs))
  result = App(
    nodeId: 1.NodeId,
    nodeName: "render/chart",
    scene: scene,
    frameConfig: FrameConfig(width: 40, height: 30),
    appConfig: AppConfig(
      data: data,
      chartType: chartType,
      color: parseHtmlColor("#2a78d6"),
      axisColor: parseHtmlColor("#333333"),
      transparentBackground: true,
      showGrid: true,
      showLabels: false,
      fontSize: 6.0,
      lineWidth: 2.0,
      padding: 2.0,
    )
  )
  result.init()

proc drawnPixels(image: Image): int =
  for p in image.data:
    if p.a > 0:
      inc result

suite "render/chart data parsing":
  test "array of numbers becomes a single series":
    let data = parseChartData(%*[1, 2.5, 3])
    check data.series.len == 1
    check data.series[0].values == @[1.0, 2.5, 3.0]
    check data.labels.len == 0

  test "array of label/value objects extracts labels and values":
    let data = parseChartData(%*[
      {"label": "Mon", "value": 3},
      {"label": "Tue", "value": 5.5},
      {"label": "Wed", "value": "7"}
    ])
    check data.series.len == 1
    check data.series[0].values == @[3.0, 5.5, 7.0]
    check data.labels == @["Mon", "Tue", "Wed"]

  test "series object shape with names, colors and shared labels":
    let data = parseChartData(%*{
      "series": [
        {"name": "a", "color": "#ff0000", "values": [1, 2]},
        {"values": [3, 4]},
        [5, 6]
      ],
      "labels": ["x", "y"]
    })
    check data.series.len == 3
    check data.series[0].name == "a"
    check data.series[0].color == "#ff0000"
    check data.series[0].values == @[1.0, 2.0]
    check data.series[1].values == @[3.0, 4.0]
    check data.series[2].values == @[5.0, 6.0]
    check data.labels == @["x", "y"]

  test "missing and null values parse as NaN":
    let data = parseChartData(parseJson("""[{"label": "a"}, {"value": null}, 4]"""))
    check data.series.len == 1
    check data.series[0].values.len == 3
    check not isFiniteValue(data.series[0].values[0])
    check not isFiniteValue(data.series[0].values[1])
    check data.series[0].values[2] == 4.0

  test "degenerate inputs give no series":
    check parseChartData(nil).series.len == 0
    check parseChartData(%*[]).series.len == 0
    check parseChartData(%*{}).series.len == 0
    check parseChartData(%*"hello").series.len == 0
    check not hasFiniteValues(parseChartData(parseJson("""[null, null]""")))

suite "render/chart y-range math":
  test "auto range spans the data":
    let data = parseChartData(%*[1, 5, 3])
    check computeYRange(data, "", "", false) == (1.0, 5.0)
    check computeYRange(data, "", "", true) == (0.0, 5.0)

  test "all-equal values get padded":
    let data = parseChartData(%*[5, 5, 5])
    check computeYRange(data, "", "", false) == (4.0, 6.0)

  test "all-zero values get padded":
    let data = parseChartData(%*[0, 0])
    check computeYRange(data, "", "", false) == (-1.0, 1.0)

  test "manual overrides win and junk is ignored":
    let data = parseChartData(%*[1, 5])
    check computeYRange(data, "0", "10", false) == (0.0, 10.0)
    check computeYRange(data, "abc", "", false) == (1.0, 5.0)

  test "inverted overrides are swapped":
    let data = parseChartData(%*[1, 5])
    check computeYRange(data, "10", "2", false) == (2.0, 10.0)

  test "negative values include zero baseline when asked":
    let data = parseChartData(%*[-3, -1])
    check computeYRange(data, "", "", true) == (-3.0, 0.0)

suite "render/chart geometry math":
  test "valueToY maps range onto the plot":
    check valueToY(0.0, 0.0, 10.0, 5.0, 100.0) == 105.0
    check valueToY(10.0, 0.0, 10.0, 5.0, 100.0) == 5.0
    check valueToY(5.0, 0.0, 10.0, 5.0, 100.0) == 55.0

  test "pointX centers bars and spreads line points":
    check pointX(0, 4, 0.0, 400.0, "bar") == 50.0
    check pointX(3, 4, 0.0, 400.0, "bar") == 350.0
    check pointX(0, 3, 0.0, 400.0, "line") == 0.0
    check pointX(1, 3, 0.0, 400.0, "line") == 200.0
    check pointX(2, 3, 0.0, 400.0, "line") == 400.0
    check pointX(0, 1, 0.0, 400.0, "line") == 200.0

  test "barSlot lays out single and grouped bars":
    let single = barSlot(0, 4, 0, 1, 400.0)
    check single.x == 10.0
    check single.w == 80.0

    let grouped = barSlot(1, 4, 1, 2, 400.0)
    check grouped.x == 151.0
    check grouped.w == 39.0

    check barSlot(0, 0, 0, 1, 400.0) == (0.0, 0.0)

  test "labelStep thins out labels that do not fit":
    check labelStep(10, 400.0, 40.0) == 1
    check labelStep(10, 200.0, 40.0) == 2
    check labelStep(0, 200.0, 40.0) == 1
    check labelStep(5, 0.0, 40.0) == 1

suite "render/chart formatting and colors":
  test "formatValue trims float noise":
    check formatValue(2.0) == "2"
    check formatValue(2.5) == "2.5"
    check formatValue(-3.25) == "-3.25"
    check formatValue(NaN) == ""

  test "seriesColor prefers explicit color, then base, then palette":
    let base = parseHtmlColor("#2a78d6")
    let explicit = seriesColor(base, ChartSeries(color: "#ff0000"), 0)
    check explicit.r > 0.99
    check explicit.g < 0.01
    check seriesColor(base, ChartSeries(), 0) == base
    check seriesColor(base, ChartSeries(), 1) == parseHtmlColor(seriesPalette[1])
    check seriesColor(base, ChartSeries(color: "not-a-color"), 0) == base

suite "render/chart config and rendering":
  test "init normalizes bad config":
    let app = App(appConfig: AppConfig(chartType: "pie", minY: " 1 ", maxY: ""))
    app.init()
    check app.appConfig.chartType == "line"
    check app.appConfig.fontSize == 16.0
    check app.appConfig.lineWidth == 2.0
    check app.appConfig.minY == "1"

  test "smoke render draws line chart pixels":
    let logs = LogStore(items: @[])
    let app = newTestApp(%*[1, 3, 2], "line", logs)
    let image = app.get(ExecutionContext(image: newImage(40, 30), hasImage: true))
    check image.width == 40
    check image.height == 30
    check drawnPixels(image) > 0
    check logs.items.len == 0

  test "smoke render draws bar and area charts":
    for chartType in ["bar", "area"]:
      let logs = LogStore(items: @[])
      let app = newTestApp(%*[2, 1, 4], chartType, logs)
      let image = app.get(ExecutionContext(image: newImage(40, 30), hasImage: true))
      check drawnPixels(image) > 0
      check logs.items.len == 0

  test "background fill only when not transparent":
    let logs = LogStore(items: @[])
    let app = newTestApp(%*[1, 2], "line", logs)
    app.appConfig.transparentBackground = false
    app.appConfig.backgroundColor = parseHtmlColor("#ffffff")
    let image = app.get(ExecutionContext(image: newImage(40, 30), hasImage: true))
    check drawnPixels(image) == 40 * 30
    var nonWhite = 0
    for p in image.data:
      if p.r != 255 or p.g != 255 or p.b != 255:
        inc nonWhite
    check nonWhite > 0
    check logs.items.len == 0

  test "degenerate data renders a friendly message without crashing":
    for data in [%*[], parseJson("""[null, null]"""), %*{}, %*[5]]:
      let logs = LogStore(items: @[])
      let app = newTestApp(data, "line", logs)
      let image = app.get(ExecutionContext(image: newImage(40, 30), hasImage: true))
      check image.width == 40
      check drawnPixels(image) > 0
      check logs.items.len == 0

  test "multiple series render without errors":
    let logs = LogStore(items: @[])
    let app = newTestApp(%*{
      "series": [
        {"name": "a", "values": [1, 2, 3]},
        {"name": "b", "values": [3, 2, 1]}
      ],
      "labels": ["x", "y", "z"]
    }, "bar", logs)
    app.appConfig.showLabels = true
    let image = app.get(ExecutionContext(image: newImage(120, 80), hasImage: true))
    check drawnPixels(image) > 0
    check logs.items.len == 0

suite "render/chart string-wrapped data":
  test "json delivered as a string parses like the object form":
    let text = """{"labels": ["a", "b"], "series": [{"values": [1, 2]}]}"""
    let fromString = parseChartData(%*text)
    check fromString.series.len == 1
    check fromString.series[0].values == @[1.0, 2.0]
    check fromString.labels == @["a", "b"]

  test "junk strings give no data instead of raising":
    check parseChartData(%*"not json").series.len == 0
    check parseChartData(%*"").series.len == 0
