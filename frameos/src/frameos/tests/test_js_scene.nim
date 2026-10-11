import std/[base64, json, strutils, tables]
import pixie, pixie/fileformats/png
import ../interpreter
import ../js_scene
import ../types

# Pure JS scenes (settings.execution == "js", docs/pure-js-scenes.md):
# - the registry builds them from `sources` and they init/render/run events
#   through the interpreter's entry points like any scene
# - `scene.state` reads and writes the scene's state, public fields arrive
#   through setSceneState, the refresh interval is a state field
# - the canvas draws straight into the frame's image: rects, cells, text,
#   gradients, polylines, pixels, offscreen images, data URLs, SVG
# - a module that does not load renders an error instead of crashing
# - the canvas handed to render() is dead after it

var logged: seq[JsonNode] = @[]

proc testConfig(width = 40, height = 30): FrameConfig =
  FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, timeZone: "Europe/Brussels", assetsPath: "/tmp/frameos-test-assets")

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logged.add(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc sceneJson(id: string, sources: JsonNode, fields = "[]", settings = ""): string =
  let settingsJson = if settings.len > 0: settings else: """{"execution": "js", "refreshInterval": 120, "backgroundColor": "#ffffff"}"""
  """{"id": """" & id & """", "name": "JS """ & id & """", "settings": """ & settingsJson &
    """, "fields": """ & fields & """, "nodes": [], "edges": [], "sources": """ & $sources & "}"

proc redDataUrl(): string =
  let dot = newImage(1, 1)
  dot.fill(rgbx(255, 0, 0, 255))
  "data:image/png;base64," & encode(encodePng(dot))

let drawingScene = %*{
  "scene.ts": """
import { helper } from "./lib";
let renders = 0;
let keptCanvas: any = null;
export function init(scene) {
  scene.state.initRan = true;
  scene.state.helper = helper(20);
  scene.state.tz = scene.timeZone;
}
export function render(scene, canvas) {
  renders += 1;
  scene.state.renders = renders;
  scene.state.size = canvas.width + "x" + canvas.height;
  canvas.fillRect(0, 0, 10, 10, "#ff0000");
  canvas.fillRect(10, 0, 10, 10, 0x00ff00);
  const cell = canvas.cell(20, 0, 10, 10);
  cell.clear("#0000ff");
  cell.fillRect(-5, -5, 100, 100, "#0000ff"); // clipped to the cell
  canvas.gradient(0, 10, 40, 10, { from: "#000000", to: "#ffffff", angle: 90 });
  canvas.polyline([0, 25.5, 39, 25.5], "#000000", 1);
  canvas.setPixel(39, 29, "#123456");
  const m = canvas.measureText("Hi", { size: 8 });
  scene.state.measuredOk = m.width > 0 && m.height > 0;
  const t = canvas.text("Hi", 0, 20, { size: 8, color: "#000000" });
  scene.state.textOk = t.width > 0;
  const off = scene.newImage(4, 4);
  off.clear("#ff00ff");
  canvas.draw(off, 30, 20);
  off.free();
  const okImage = canvas.image("RED_DATA_URL", { x: 34, y: 20, width: 2, height: 2, fit: "stretch" });
  scene.state.imageOk = okImage;
  const okSvg = canvas.svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#00ffff"/></svg>',
    { x: 36, y: 20, width: 2, height: 2 });
  scene.state.svgOk = okSvg;
  try {
    const px = canvas.pixels();
    scene.state.pixelBytes = px.length;
    scene.state.pixelType = Object.prototype.toString.call(px) + " buf=" + px.buffer.byteLength + " bl=" + px.byteLength + " re=" + new Uint8Array(px.buffer).length + " off=" + px.byteOffset;
  } catch (e) { scene.state.pixelBytes = "error: " + e.message; }
  scene.state.firstPixel = canvas.getPixel(0, 0);
  scene.state.format = canvas.format;
  keptCanvas = canvas;
  if (scene.state.city !== undefined) scene.state.sawCity = scene.state.city;
  scene.setNextSleep(7);
}
export function onEvent(scene, event, payload) {
  scene.state.lastEvent = event;
  if (event === "keyDown") scene.state.lastKey = payload.key;
  if (event === "poke") {
    try { keptCanvas.fillRect(0, 0, 1, 1, "#000000"); scene.state.staleCanvas = "drew"; }
    catch (e) { scene.state.staleCanvas = String(e.message); }
    scene.dispatch("setSceneState", { state: { city: "Tallinn" } });
  }
}
""",
  "lib.ts": "export const helper = (n: number): number => n * 2;",
}
drawingScene["scene.ts"] = %drawingScene["scene.ts"].getStr().replace("RED_DATA_URL", redDataUrl())

let brokenScene = %*{"scene.ts": "export function render(scene, canvas) { this is not javascript }"}
let noRenderScene = %*{"scene.ts": "export function init(scene) { scene.state.x = 1 }"}

let scenesJson = "[" & sceneJson("tests/js/drawing", drawingScene,
    fields = """[{"name": "city", "type": "string", "value": "Brussels", "access": "public"},
                 {"name": "secret", "type": "string", "value": "hush", "access": "private"}]""") & "," &
  sceneJson("tests/js/broken", brokenScene) & "," &
  sceneJson("tests/js/norender", noRenderScene) & "," &
  """{"id": "tests/js/graph", "name": "graph", "settings": {"execution": "interpreted", "refreshInterval": 300},
      "nodes": [], "edges": [], "fields": []}""" & "]"

let inputs = parseInterpretedSceneInputs(scenesJson)
doAssert inputs.len == 4
doAssert inputs[0].settings.execution == "js"
doAssert inputs[0].sources.kind == JObject and inputs[0].sources.hasKey("scene.ts")
let built = buildInterpretedScenes(inputs)
doAssert built["tests/js/drawing".SceneId] of ExportedJsScene
doAssert not (built["tests/js/graph".SceneId] of ExportedJsScene)
setUploadedInterpretedScenes(built)
resetInterpretedScenes()

block test_export_shape:
  let exported = ExportedJsScene(built["tests/js/drawing".SceneId])
  doAssert exported.name == "JS tests/js/drawing"
  doAssert exported.mainName == "scene.ts"
  doAssert exported.refreshInterval == 120
  # The implicit refresh interval field is public and last; the private field is not public.
  doAssert exported.publicStateFields.len == 2, $exported.publicStateFields.len
  doAssert exported.publicStateFields[0].name == "city"
  doAssert exported.publicStateFields[1].name == "refreshInterval"
  doAssert exported.stateFields.len == 3

block test_init_render_and_state:
  logged.setLen(0)
  let config = testConfig()
  let scene = init("tests/js/drawing".SceneId, config, testLogger(config), %*{})
  doAssert scene of JsFrameScene
  doAssert scene.state{"initRan"}.getBool(), "init did not run: " & $scene.state
  doAssert scene.state{"helper"}.getInt() == 40, "imports resolve beside scene.ts"
  doAssert scene.state{"tz"}.getStr() == "Europe/Brussels"
  doAssert scene.state{"city"}.getStr() == "Brussels", "fields seed the state"
  doAssert scene.state{"secret"}.getStr() == "hush"
  doAssert scene.refreshInterval == 120

  var context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  let image = render(scene, context)
  doAssert not image.isNil and image.width == 40 and image.height == 30
  doAssert scene.state{"renders"}.getInt() == 1
  doAssert scene.state{"size"}.getStr() == "40x30"
  doAssert context.nextSleep == 7, "setNextSleep travels on the context"
  doAssert image[0, 0] == rgbx(255, 0, 0, 255), $image[0, 0]
  doAssert image[15, 5] == rgbx(0, 255, 0, 255), "numeric colors: " & $image[15, 5]
  doAssert image[25, 5] == rgbx(0, 0, 255, 255), "cell draws through: " & $image[25, 5]
  doAssert image[19, 5] == rgbx(0, 255, 0, 255), "a cell clips to its rectangle: " & $image[19, 5]
  doAssert image[31, 5] == rgbx(255, 255, 255, 255), "a cell clips on the right too: " & $image[31, 5]
  doAssert image[0, 15].r < 20 and image[39, 15].r > 235, "gradient runs left to right: " & $image[0, 15] & " " & $image[39, 15]
  doAssert image[20, 25].r < 80, "polyline: " & $image[20, 25]
  doAssert image[39, 29] == rgbx(0x12, 0x34, 0x56, 255), "setPixel: " & $image[39, 29]
  doAssert image[31, 21] == rgbx(255, 0, 255, 255), "offscreen image drawn: " & $image[31, 21]
  doAssert scene.state{"imageOk"}.getBool(), "data URL image: " & $logged
  doAssert image[34, 20].r == 255 and image[34, 20].g == 0, "decoded into the target rect: " & $image[34, 20]
  doAssert scene.state{"svgOk"}.getBool(), "svg: " & $logged
  doAssert image[36, 20] == rgbx(0, 255, 255, 255), "svg into target: " & $image[36, 20]
  doAssert scene.state{"measuredOk"}.getBool() and scene.state{"textOk"}.getBool()
  doAssert scene.state{"pixelBytes"}.getInt() == 40 * 30 * 4, $scene.state{"pixelBytes"} & " " & $scene.state{"pixelType"}
  doAssert scene.state{"firstPixel"}.getInt() == 0xff0000
  doAssert scene.state{"format"}.getStr() == "rgbx"
  doAssert scene.state{"sawCity"}.getStr() == "Brussels"

  # Public state arrives through setSceneState; private fields stay put.
  runEvent(scene, ExecutionContext(scene: scene, event: "setSceneState",
    payload: %*{"state": {"city": "Tartu", "secret": "leak", "refreshInterval": 45}}, hasImage: false, loopIndex: 0, loopKey: "."))
  doAssert scene.state{"city"}.getStr() == "Tartu"
  doAssert scene.state{"secret"}.getStr() == "hush"
  doAssert scene.refreshInterval == 45, "the refresh interval is a state field: " & $scene.refreshInterval
  doAssert scene.state{"lastEvent"}.getStr() == "setSceneState", "onEvent hears state changes too"

  # Input events reach onEvent with their payload.
  doAssert sceneListensTo(scene, "keyDown")
  runEvent(scene, ExecutionContext(scene: scene, event: "keyDown", payload: %*{"key": "KEY_B"},
    hasImage: false, loopIndex: 0, loopKey: "."))
  doAssert scene.state{"lastKey"}.getStr() == "KEY_B"

  # The canvas of a finished render is dead; dispatch goes out as a scene event.
  runEvent(scene, ExecutionContext(scene: scene, event: "poke", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: "."))
  doAssert scene.state{"staleCanvas"}.getStr().contains("no longer valid"), $scene.state{"staleCanvas"}

  # A second render into a host-provided canvas (the ESP32 way) works the same.
  let canvas = newImage(40, 30)
  var context2 = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: true, image: canvas,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  discard render(scene, context2)
  doAssert context2.image == canvas
  doAssert scene.state{"renders"}.getInt() == 2
  doAssert canvas[0, 0] == rgbx(255, 0, 0, 255)
  cleanupJsScene(scene)

block test_broken_module_renders_an_error:
  logged.setLen(0)
  let config = testConfig(120, 60)
  let scene = init("tests/js/broken".SceneId, config, testLogger(config), %*{})
  doAssert JsFrameScene(scene).loadError.len > 0
  var loadErrors = 0
  for entry in logged:
    if entry{"event"}.getStr() == "jsScene:loadError": inc loadErrors
  doAssert loadErrors == 1, $logged
  var context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  let image = render(scene, context)
  doAssert not image.isNil and image.width == 120
  var dark = 0
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      if image[x, y].r < 128: inc dark
  doAssert dark > 0, "an error message is drawn"
  # Events do not crash a scene that never loaded.
  runEvent(scene, ExecutionContext(scene: scene, event: "keyDown", payload: %*{"key": "KEY_A"},
    hasImage: false, loopIndex: 0, loopKey: "."))
  cleanupJsScene(scene)

block test_missing_render_is_reported:
  logged.setLen(0)
  let config = testConfig()
  let scene = init("tests/js/norender".SceneId, config, testLogger(config), %*{})
  doAssert scene.state{"x"}.getInt() == 1
  doAssert not sceneListensTo(scene, "keyDown"), "no onEvent: input events are not built"
  var noRender = 0
  for entry in logged:
    if entry{"event"}.getStr() == "jsScene:noRender": inc noRender
  doAssert noRender == 1
  var context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  discard render(scene, context)
  cleanupJsScene(scene)

block test_persisted_state_wins_over_defaults:
  let config = testConfig()
  let scene = init("tests/js/drawing".SceneId, config, testLogger(config), %*{"city": "Riga"})
  doAssert scene.state{"city"}.getStr() == "Riga"
  cleanupJsScene(scene)

echo "test_js_scene: ok"
