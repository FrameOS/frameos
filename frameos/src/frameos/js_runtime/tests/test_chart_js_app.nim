## The Chart app (repo/apps/image/chart), the JavaScript that replaced the
## built-in render/chart, run for real through the JS app runtime: the SVG it
## builds (sized to the area it is drawn into, every data shape the built-in
## app read) and the image the runtime rasterizes from it.

import std/[json, os, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "chart"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

## Answers the SVG markup the app hands frameos.svg, instead of the image.
const probeSource = """
import { get as chart } from './app'
export function get(app, context) {
  const svg = frameos.svg
  let markup = ''
  frameos.svg = (s, spec) => { markup = s; return svg(s, spec) }
  try { chart(app, context) } finally { frameos.svg = svg }
  return markup
}
"""

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime

proc newHarness(probe: bool): Harness =
  let config = FrameConfig(width: 400, height: 240, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false)
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/chart-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 3.NodeId, nodeName: "chart", appKeyword: "chart", scene: scene, frameConfig: config)
  let sources = %*{"app.ts": appSource, "config.json": appConfigJson, "probe.ts": probeSource}
  let runtime = newJsAppRuntime(category = "data", outputType = (if probe: "text" else: "image"),
    source = (if probe: probeSource else: appSource), sourceName = (if probe: "probe.ts" else: "app.ts"),
    sources = sources)
  Harness(scene: scene, owner: owner, runtime: runtime)

proc context(h: Harness, width, height: int): ExecutionContext =
  ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: width > 0,
    image: (if width > 0: newImage(width, height) else: nil), loopIndex: 0, loopKey: ".", nextSleep: -1)

proc svg(config: JsonNode, width = 200, height = 120): string =
  let h = newHarness(probe = true)
  h.runtime.get(h.owner, config, h.context(width, height)).asString()

suite "Chart app":
  test "the SVG is the size of the area it draws into":
    let markup = svg(%*{"data": [1, 3, 2]})
    check markup.startsWith("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="200" height="120">""")
    check markup.endsWith("</svg>")

  test "without a canvas it fails rather than guess the panel's size":
    expect JsAppError:
      discard svg(%*{"data": [1, 3, 2]}, width = 0, height = 0)
    check not appSource.contains("rotate")

  test "a line chart: one stroked path, axes, grid and the range labels":
    let markup = svg(%*{"data": [1, 3, 2], "chartType": "line"})
    check markup.count("""fill="none"/>""") == 3  # grid, the line, the axes
    check markup.contains("""stroke="#2a78d6"""")
    check markup.contains(">3</text>") and markup.contains(">1</text>")

  test "bars and areas":
    let bars = svg(%*{"data": [1, 3, 2], "chartType": "bar"})
    check bars.count("h") >= 3
    check bars.contains(">0</text>")  # bars start from zero
    let area = svg(%*{"data": [1, 3, 2], "chartType": "area"})
    check area.contains("""fill-opacity="0.35"""")

  test "the grid falls on round steps, and an automatic end moves out to one":
    let markup = svg(%*{"data": [1, 4, 2, 6, 3, 8, 5, 9, 4, 7], "chartType": "area"})
    for level in ["10", "7.5", "5", "2.5", "0"]:
      check markup.contains(">" & level & "</text>")
    check not markup.contains(">9</text>")

  test "every data shape the built-in app read":
    let labelled = svg(%*{"data": [{"label": "Mon", "value": 3}, {"label": "Tue", "value": 5}]})
    check labelled.contains(">Mon</text>") and labelled.contains(">Tue</text>")
    let series = svg(%*{"data": {"labels": ["a", "b"], "series": [
      {"name": "x", "color": "#ff0000", "values": [1, 2]}, {"values": [2, 1]}]}})
    check series.contains("""stroke="#ff0000"""") and series.contains("""stroke="#1baf7a"""")
    check svg(%*{"data": "[4, 5, 6]"}).contains(">6</text>")
    check svg(%*{"data": [1, "2", nil, 4]}).contains(">4</text>")

  test "no data says so":
    check svg(%*{"data": []}).contains(">No chart data</text>")
    check svg(%*{"data": "not json"}).contains(">No chart data</text>")

  test "the title is escaped, and a set size keeps its pixels":
    let markup = svg(%*{"data": [1, 2], "title": "Rain & <snow>", "fontSize": 10})
    check markup.contains(">Rain &amp; &lt;snow&gt;</text>")
    check markup.contains("""font-size="12.5"""")  # the title is 1.25 x fontSize
    check svg(%*{"data": [1, 2], "minY": "0", "maxY": "10"}).contains(">10</text>")

  test "an opaque background, when asked":
    check svg(%*{"data": [1, 2], "transparentBackground": false, "backgroundColor": "#102030"}).contains(
      """<rect width="200" height="120" fill="#102030"/>""")

  test "the runtime draws it":
    let h = newHarness(probe = false)
    let value = h.runtime.get(h.owner, %*{"data": [1, 3, 2], "transparentBackground": false}, h.context(200, 120))
    check value.kind == fkImage
    let image = value.asImage()
    check image.width == 200 and image.height == 120
    check image[100, 5] == rgbx(255, 255, 255, 255)  # the background
    var lineSeen = false
    for x in 0 ..< image.width:
      for y in 0 ..< image.height:
        let px = image[x, y]
        if px.b > 150 and px.r < 120:
          lineSeen = true
    check lineSeen
