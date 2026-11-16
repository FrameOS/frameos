## `app.frame.fast`, `paper` and `color` say what the frame's panel is in
## every phase a JS app runs: init(), get(), onEvent, a JSX handler and what
## comes after an await. They come from the host (panel_shape.boardPanelFormat
## on a board, the device on a Pi), never from the context's canvas, which
## only a render has: on an ESP32 an event read e-paper on the SenseCAP's LCD,
## and in get() a 13.3" color e-paper on 8 MB, whose canvas is RGB565, read
## like an LCD. Today `fast` is `paper`'s opposite on every panel. A panel drawn into a picture of its own (a `<Scene>` that
## cannot be a hole, a split's panel) hears the frame's panel too: its pixels
## end on the same glass.

import std/[json, monotimes, options, os, tables, times, unittest]
import pixie
import ../events_gen
import ../interpreter
import ../panel_shape
import ../single_scene_host
import ../types
import ../js_runtime/app_runtime

const
  W = 320
  H = 240
  ProbeSceneId = "tests/app-frame-panel"
  Phases = ["init", "get", "onEvent", "onClick", "awaited"]

let probe = %*{
  "id": ProbeSceneId,
  "name": "Panel probe",
  "settings": {"execution": "interpreted", "refreshInterval": 3600, "backgroundColor": "#ffffff"},
  "fields": [],
  "nodes": [
    {"id": "render", "type": "event", "data": {"keyword": "render"}},
    {"id": "draw", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "cover"}}},
    {"id": "probe", "type": "app", "data": {"keyword": "panelProbe", "config": {}}}
  ],
  "edges": [
    {"id": "e1", "source": "render", "sourceHandle": "next", "target": "draw", "targetHandle": "prev",
      "type": "appNodeEdge"},
    {"id": "e2", "source": "probe", "sourceHandle": "fieldOutput", "target": "draw",
      "targetHandle": "fieldInput/image", "type": "codeNodeEdge"}
  ],
  "apps": {"panelProbe": {"name": "Panel probe", "category": "data", "fields": [],
    "output": [{"name": "image", "type": "image"}],
    "sources": {
      "config.json": $(%*{"name": "Panel probe", "category": "data", "fields": [], "events": ["pointerDown"],
        "output": [{"name": "image", "type": "image"}]}),
      "app.tsx": """
const look = (app: FrameOSApp) => ({ fast: app.frame.fast, paper: app.frame.paper, color: app.frame.color })

export async function init(app: FrameOSApp) {
  frameos.remember('init', look(app))
  await frameos.sleep(0)
  frameos.remember('awaited', look(app))
}

export function onEvent(app: FrameOSApp, context: FrameOSContext) {
  frameos.remember('onEvent', look(app))
  return false
}

export function get(app: FrameOSApp, context: FrameOSContext) {
  frameos.remember('get', look(app))
  return <div className="w-full h-full bg-white" onClick={() => frameos.remember('onClick', look(app))} />
}
"""}}}
}

proc loadProbe() =
  ## A fresh copy of the scene: every app runtime and what it remembered new.
  replaceInterpretedScenesCache(parseInterpretedScenes($(%*[probe])))

proc quietLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc config(device: string): FrameConfig =
  FrameConfig(width: W, height: H, rotate: 0, scalingMode: "cover", debug: false, settings: %*{},
    saveAssets: %*false, assetsPath: getTempDir(), device: device)

proc heard(scene: FrameScene): Table[string, (bool, bool, bool)] =
  ## What each phase remembered: (fast, paper, color).
  for app in InterpretedFrameScene(scene).appsByNodeId.values:
    if app of DynamicJsApp:
      for phase, text in DynamicJsApp(app).runtime.memory:
        let seen = parseJson(text)
        result[phase] = (seen{"fast"}.getBool(), seen{"paper"}.getBool(), seen{"color"}.getBool())

proc settle(scene: FrameScene) =
  ## The await in init() goes on, as the runner's loop and the ESP32's idle
  ## wait pump it (docs/async-js.md).
  let start = getMonoTime()
  while not scene.heard().hasKey("awaited") and (getMonoTime() - start).inMilliseconds < 3000:
    discard pumpJsAsync()
    sleep(2)

template expectEverywhere(scene: FrameScene, fast, paper, color: bool) =
  # A template: a check fails the test it is in.
  let seen = scene.heard()
  for phase in Phases:
    checkpoint phase & ": " & $seen.getOrDefault(phase)
    check seen.hasKey(phase)
    check seen.getOrDefault(phase) == (fast, paper, color)

proc onBoard(panelFormat: int, canvas: Image): FrameScene =
  ## An ESP32 (single_scene_host, the device "embedded") whose firmware said
  ## its panel at init (embedded_main): a render into `canvas`, the canvas the
  ## board keeps for that panel, then a tap through the dispatcher.
  boardPanelFormat = panelFormat
  loadProbe()
  let host = SingleSceneHost(frameConfig: config("embedded"), logger: quietLogger(config("embedded")))
  host.keepJsRuntimes = true # an ESP32 somebody taps stays awake
  host.requestSelect = proc (sceneId: string): bool = true
  host.start()
  host.makeCurrent(ProbeSceneId.SceneId)
  doAssert host.ensureScene()
  discard host.renderScene(ExecutionContext(scene: host.scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
  # The glass's wire position (0..32767), at the middle; a 100 ms press is a tap.
  let at = getMonoTime().ticks div 1_000_000 - 200
  discard host.send(eoDriver, "pointerDown", %*{"x": 16383, "y": 16383, "pointerId": 1,
    "pointerType": "touch", "button": 0, "buttons": 1, "atMs": at})
  discard host.send(eoDriver, "pointerUp", %*{"x": 16383, "y": 16383, "pointerId": 1,
    "pointerType": "touch", "button": 0, "buttons": 0, "atMs": at + 100})
  host.scene.settle()
  result = host.scene

proc onPi(device: string, canvas: Image): FrameScene =
  ## A Pi's runner: the interpreter, a render into the canvas, then the
  ## pointer and the tap the input state makes of it.
  boardPanelFormat = 0
  loadProbe()
  result = init(ProbeSceneId.SceneId, config(device), quietLogger(config(device)), %*{})
  discard render(result, ExecutionContext(scene: result, event: "render", payload: %*{}, image: canvas,
    hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
  for event in ["pointerDown", "pointerUp", "tap"]:
    runEvent(result, ExecutionContext(scene: result, event: event, payload: %*{"x": W div 2, "y": H div 2,
      "pointerId": 1, "pointerType": "touch", "button": 0, "buttons": (if event == "pointerDown": 1 else: 0)},
      loopIndex: 0, loopKey: ".", nextSleep: -1))
  result.settle()

suite "app.frame.fast, paper and color, in every phase":
  teardown:
    boardPanelFormat = 0

  test "an ESP32 LCD (the SenseCAP Indicator): fast, color, in an event too":
    onBoard(PanelFormatRgb565, newImage565(W, H)).expectEverywhere(fast = true, paper = false, color = true)

  test "an ESP32 sixteen-grey e-paper (the reTerminal E1003): slow, paper, no color":
    onBoard(8, newImageGray4(W, H)).expectEverywhere(fast = false, paper = true, color = false)

  test "an ESP32 color e-paper (Spectra 6, the reTerminal E1002): slow, paper and color":
    onBoard(7, newImage(W, H)).expectEverywhere(fast = false, paper = true, color = true)

  test "a 13.3 inch color e-paper on 8 MB draws in RGB565 and is still e-paper":
    onBoard(7, newImage565(W, H)).expectEverywhere(fast = false, paper = true, color = true)

  test "a panel drawn into a picture of its own hears the frame's panel":
    # Whatever the canvas a scene is drawn into (a <Scene>'s picture of its
    # own, a split's panel), its pixels end on the frame's glass.
    onBoard(PanelFormatRgb565, newImage(W, H)).expectEverywhere(fast = true, paper = false, color = true)
    onBoard(8, newImage(W, H)).expectEverywhere(fast = false, paper = true, color = false)

  test "a Pi LCD (a HyperPixel), in its RGB565 canvas":
    onPi("pimoroni.hyperpixel4", newImage565(W, H)).expectEverywhere(fast = true, paper = false, color = true)

  test "a Pi black and white e-paper":
    onPi("waveshare.EPD_7in5_V2", newImage(W, H)).expectEverywhere(fast = false, paper = true, color = false)

  test "a Pi color e-paper (Spectra 6)":
    onPi("waveshare.EPD_13in3e", newImage(W, H)).expectEverywhere(fast = false, paper = true, color = true)
