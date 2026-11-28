import std/[json, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/panel_shape
import frameos/types
import frameos/values
import frameos/ui/events

# The render scale (frameos/render_scale.nim, docs/jsx-ui.md "Scale"): a .tsx
# app on a frame at scale 2 is told its canvas is half the size, its UI is
# laid out at that size and drawn at the full size, and the pointer lands
# where the UI was drawn. A plain .js app keeps the panel's pixels.

type Ui = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

proc newUi(source: string, id: string, renderScale = 2.0, sourceName = "app.tsx",
    outputType = "image"): Ui =
  let config = FrameConfig(width: 400, height: 200, rotate: 0, scalingMode: "cover",
    saveAssets: %*false, assetsPath: "/tmp", renderScale: renderScale)
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{},
    logger: Logger(frameConfig: config, enabled: false, log: proc(payload: JsonNode) = discard))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "ui", scene: result.scene, frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = outputType, source = source,
    sourceName = sourceName)

proc render(ui: Ui, canvas: Image = nil): Value =
  let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
    hasImage: not canvas.isNil, image: canvas, loopIndex: 0, loopKey: ".", nextSleep: -1)
  ui.runtime.get(ui.owner, %*{}, context)

proc at(x, y: int): JsonNode =
  %*{"x": x, "y": y, "pointerId": 0, "pointerType": "mouse"}

const red = rgbx(0xef, 0x44, 0x44, 255)
const white = rgbx(255, 255, 255, 255)

# A 50x25 box in the top left corner of a white UI, which counts its taps,
# and what the app was told about its canvas.
const box = """
let taps = 0
export function get(app, context) {
  frameos.setState('seen', {
    imageWidth: context.imageWidth, imageHeight: context.imageHeight,
    frameWidth: app.frame.width, frameHeight: app.frame.height, scale: app.frame.scale, taps,
  })
  return (
    <div className="bg-white">
      <div className="w-[50px] h-[25px] bg-red-500" onClick={() => { taps++ }} />
    </div>
  )
}
"""

suite "jsx render scale":
  test "a .tsx app at scale 2 sees half the canvas, and its UI is drawn twice as large":
    let ui = newUi(box, "tests/jsx-scale")
    let image = ui.render(newImage(400, 200)).asImage()
    check image.width == 400 and image.height == 200
    let seen = ui.scene.state["seen"]
    check seen["imageWidth"].getInt() == 200
    check seen["imageHeight"].getInt() == 100
    check seen["frameWidth"].getInt() == 200
    check seen["frameHeight"].getInt() == 100
    check seen["scale"].getFloat() == 2.0
    # The 50x25 box covers 100x50 canvas pixels.
    check image[95, 45] == red
    check image[105, 45] == white
    check image[95, 55] == white

  test "the pointer is divided by the scale before it meets the UI":
    let ui = newUi(box, "tests/jsx-scale-tap")
    discard ui.render(newImage(400, 200))
    check dispatchUiEvent("tests/jsx-scale-tap", "tap", at(95, 45)) # in the drawn box, past the laid-out one
    check not dispatchUiEvent("tests/jsx-scale-tap", "tap", at(105, 45))
    discard ui.render(newImage(400, 200))
    check ui.scene.state["seen"]["taps"].getInt() == 1

  test "below 1 the UI gets more room, is drawn smaller, and the pointer reaches all of it":
    # At 0.5 a 400x200 canvas is an 800x400 UI: a full-width slider pressed
    # near the canvas's right edge is pressed near its own right end.
    let ui = newUi("""
let pressed = null
export function get(app, context) {
  frameos.setState('seen', { frameWidth: app.frame.width, pressed })
  return (
    <div className="bg-white w-full h-full">
      <div className="w-[100px] h-[50px] bg-red-500" />
      <div className="w-full h-[40px] bg-black" onPointerDown={(e) => { pressed = [e.localX, e.width] }} />
    </div>
  )
}
""", "tests/jsx-scale-half", renderScale = 0.5)
    let image = ui.render(newImage(400, 200)).asImage()
    check ui.scene.state["seen"]["frameWidth"].getInt() == 800
    # The 100x50 box covers 50x25 canvas pixels.
    check image[45, 20] == red
    check image[55, 20] == white
    check dispatchUiEvent("tests/jsx-scale-half", "pointerDown", %*{"x": 390, "y": 35, "pointerId": 0,
      "pointerType": "touch", "buttons": 1})
    discard ui.render(newImage(400, 200))
    let pressed = ui.scene.state["seen"]["pressed"]
    check pressed.kind == JArray
    if pressed.kind == JArray:
      check pressed[1].getFloat() == 800
      check abs(pressed[0].getFloat() - 780) < 2

  test "below 1 a list that scrolls shows all of its width":
    # A box that scrolls is a nested <svg> viewport (ui/layout.nim): at 0.5 it
    # is 800 layout pixels wide in a 400 pixel canvas, and what it holds past
    # the canvas's own width in layout pixels shows.
    let ui = newUi("""
export function get(app, context) {
  return (
    <div className="bg-white w-full h-full overflow-y-auto">
      <div className="w-full h-[1000px] flex">
        <div className="w-[600px] h-[50px]" />
        <div className="w-[100px] h-[50px] bg-red-500" />
      </div>
    </div>
  )
}
""", "tests/jsx-scale-scroll", renderScale = 0.5)
    let image = ui.render(newImage(400, 200)).asImage()
    # Layout x 600..700 is canvas x 300..350.
    check image[325, 10] == red
    check image[280, 10] == white

  test "a plain .js app keeps the panel's pixels and reads the scale":
    let ui = newUi("""
      export function get(app, context) {
        frameos.setState('seen', { imageWidth: context.imageWidth, frameWidth: app.frame.width, scale: app.frame.scale })
        return { ok: true }
      }
    """, "tests/js-scale", sourceName = "app.js", outputType = "json")
    discard ui.render(newImage(400, 200))
    let seen = ui.scene.state["seen"]
    check seen["imageWidth"].getInt() == 400
    check seen["frameWidth"].getInt() == 400
    check seen["scale"].getFloat() == 2.0

  test "app.frame.fast says a change shows at once, paper that the panel draws in inks":
    const source = """
      export function get(app) {
        frameos.setState('fast', app.frame.fast)
        frameos.setState('paper', app.frame.paper)
        return { ok: true }
      }
    """
    proc panel(device: string, canvas: Image, producer = false): (bool, bool) =
      ## (fast, paper), as get() read them.
      let ui = newUi(source, "tests/paper", sourceName = "app.js", outputType = "json")
      ui.owner.frameConfig.device = device
      let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
        hasImage: not producer, image: (if producer: nil else: canvas), loopIndex: 0, loopKey: ".", nextSleep: -1)
      if producer:
        context.decodeTargetImage = canvas
      discard ui.runtime.get(ui.owner, %*{}, context)
      (ui.scene.state["fast"].getBool(), ui.scene.state["paper"].getBool())
    check panel("waveshare.EPD_7in5_V2", newImage(400, 200)) == (false, true)
    check panel("pimoroni.inky_impression", newImage(400, 200)) == (false, true)
    check panel("framebuffer", newImage(400, 200)) == (true, false)
    # A board says by its panel (embedded_main at init), never by the canvas,
    # drawn on or fed to the node that draws on it: an LCD's is RGB565, and
    # so is a 13.3" color e-paper's on 8 MB.
    boardPanelFormat = PanelFormatRgb565
    check panel("embedded", newImage565(400, 200)) == (true, false)
    check panel("embedded", newImage(400, 200), producer = true) == (true, false)
    boardPanelFormat = 7 # Spectra 6
    check panel("embedded", newImage565(400, 200)) == (false, true)
    check panel("embedded", newImage565(400, 200), producer = true) == (false, true)
    boardPanelFormat = 0

  test "app.frame.color says whether the panel shows colors":
    const source = """
      export function get(app) {
        frameos.setState('color', app.frame.color)
        return { ok: true }
      }
    """
    proc color(device: string, canvas: Image): bool =
      let ui = newUi(source, "tests/color", sourceName = "app.js", outputType = "json")
      ui.owner.frameConfig.device = device
      let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
        hasImage: true, image: canvas, loopIndex: 0, loopKey: ".", nextSleep: -1)
      discard ui.runtime.get(ui.owner, %*{}, context)
      ui.scene.state["color"].getBool()
    # Black and white, greys: no color, so the real-time scenes' "auto"
    # draws in high contrast.
    check not color("waveshare.EPD_7in5_V2", newImage(400, 200))
    check not color("waveshare.EPD_10in3", newImage(400, 200))
    # Color e-paper (Spectra 6, seven inks, four), an HDMI screen, an LCD.
    check color("waveshare.EPD_13in3e", newImage(400, 200))
    check color("pimoroni.inky_impression_7_3", newImage(400, 200))
    check color("waveshare.EPD_2in13g", newImage(400, 200))
    check color("framebuffer", newImage(400, 200))
    # A board says by its panel, whatever its canvas.
    boardPanelFormat = PanelFormatRgb565
    check color("embedded", newImage565(400, 200))
    boardPanelFormat = 8 # sixteen greys, the reTerminal E1003
    check not color("embedded", newImage(400, 200))
    boardPanelFormat = 0

  test "app.frame.round says only the circle inside the panel shows":
    const source = """
      export function get(app) {
        frameos.setState('round', app.frame.round)
        return { ok: true }
      }
    """
    proc round(device: string): bool =
      let ui = newUi(source, "tests/round", sourceName = "app.js", outputType = "json")
      ui.owner.frameConfig.device = device
      let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
        hasImage: true, image: newImage(400, 400), loopIndex: 0, loopKey: ".", nextSleep: -1)
      discard ui.runtime.get(ui.owner, %*{}, context)
      ui.scene.state["round"].getBool()
    check round("pimoroni.hyperpixel2r")
    check round("amoled.co5300_466x466")
    check not round("framebuffer")
    check not round("embedded")
    # A board says by its panel (embedded_main at init).
    boardPanelRound = true
    check round("embedded")
    boardPanelRound = false

  test "context.round says the app draws a round panel's whole canvas":
    const source = """
      export function get(app, context) {
        frameos.setState('round', context.round)
        return { ok: true }
      }
    """
    proc round(device: string, width, height: int): bool =
      let ui = newUi(source, "tests/context-round", sourceName = "app.js", outputType = "json")
      ui.owner.frameConfig.device = device
      ui.owner.frameConfig.width = 400
      ui.owner.frameConfig.height = 400
      let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
        hasImage: true, image: newImage(width, height), loopIndex: 0, loopKey: ".", nextSleep: -1)
      discard ui.runtime.get(ui.owner, %*{}, context)
      ui.scene.state["round"].getBool()
    check round("pimoroni.hyperpixel2r", 400, 400)
    # A window, a split's panel, a layout's hole: a room of its own.
    check not round("pimoroni.hyperpixel2r", 200, 400)
    check not round("framebuffer", 400, 400)
    boardPanelRound = true
    check round("embedded", 400, 400)
    boardPanelRound = false

  test "app.frame says nothing of a battery or Wi-Fi where the host cannot tell":
    const source = """
      export function get(app) {
        frameos.setState('quiet', app.frame.batteryPercent === undefined && app.frame.wifiRssi === undefined)
        return { ok: true }
      }
    """
    let ui = newUi(source, "tests/device-facts", sourceName = "app.js", outputType = "json")
    let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
      hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    discard ui.runtime.get(ui.owner, %*{}, context)
    check ui.scene.state["quiet"].getBool()

  test "frameos.accelerometer() reads the frame's, and is null without one":
    const source = """
      export function get(app) {
        const g = frameos.accelerometer()
        frameos.setState('has', app.frame.accelerometer === true)
        frameos.setState('g', g)
        return { ok: true }
      }
    """
    let ui = newUi(source, "tests/accelerometer", sourceName = "app.js", outputType = "json")
    proc run() =
      let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
        hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
      discard ui.runtime.get(ui.owner, %*{}, context)
    accelerometerReader = nil
    run()
    check not ui.scene.state["has"].getBool()
    check ui.scene.state["g"].kind == JNull
    accelerometerReader = proc (x, y, z: var float): bool {.nimcall, gcsafe.} =
      x = -0.25
      y = 0.5
      z = -0.812
      true
    run()
    check ui.scene.state["has"].getBool()
    check ui.scene.state["g"]["x"].getFloat() == -0.25
    check ui.scene.state["g"]["y"].getFloat() == 0.5
    check ui.scene.state["g"]["z"].getFloat() == -0.812
    accelerometerReader = nil

  test "the scene's own scale wins over the frame's, and its role field over its setting":
    let ui = newUi(box, "tests/jsx-scale-scene")
    ui.scene.renderScaleSetting = 1.0
    var image = ui.render(newImage(400, 200)).asImage()
    check ui.scene.state["seen"]["imageWidth"].getInt() == 400
    check image[45, 20] == red
    check image[55, 20] == white
    ui.scene.renderScaleKey = "zoom"
    ui.scene.state["zoom"] = %"4" # a control form's string
    image = ui.render(newImage(400, 200)).asImage()
    check ui.scene.state["seen"]["imageWidth"].getInt() == 100
    check image[195, 95] == red
    check image[205, 95] == white
