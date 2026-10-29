import std/[json, unittest]
import pixie

import frameos/js_runtime/app_runtime
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
