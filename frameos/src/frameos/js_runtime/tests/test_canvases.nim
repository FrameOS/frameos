import std/[json, options, strformat, tables, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/ui/events
import frameos/utils/font # the typeface resolver the layout's text uses
import frameos/utils/svg_frames

# Canvases a JS app draws into (`frameos.canvas` / `draw` / `clear`,
# docs/jsx-ui.md "Canvases"): kept between renders, shown with <img>, and a
# frame repaints only what was drawn since the frame its buffer holds.

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Ui = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

const
  W = 120
  H = 80

proc newUi(source: string, id: string): Ui =
  let config = FrameConfig(width: W, height: H, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "ui", scene: result.scene, frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = source,
    sourceName = "app.tsx")

proc render(ui: Ui, target: Image = nil): Image =
  let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: target, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: not target.isNil)
  ui.runtime.get(ui.owner, %*{}, context).asImage()

# A board: the canvas at (10, 10), 100x60, white on grey; each render draws
# the segment `seg` names (scene state), from the last point to the next.
const board = """
let canvas = null
let last = null
export function get(app) {
  canvas = frameos.canvas('paint', 100, 60, '#ffffff')
  frameos.setState('fresh', canvas.fresh)
  const seg = app.state.seg
  if (seg !== undefined && seg !== null) {
    const to = [6 + seg * 3, 12 + (seg % 2) * 16 + Math.floor(seg / 8) * 8]
    if (last) frameos.draw(canvas, <line x1={last[0]} y1={last[1]} x2={to[0]} y2={to[1]} stroke="#e11d48" strokeWidth={4} strokeLinecap="round" />)
    last = to
  }
  if (app.state.clear) { frameos.clear(canvas, '#0f172a'); frameos.setState('clear', false) }
  return (
    <div className="w-full h-full p-[10px] bg-slate-300">
      <img className="w-[100px] h-[60px]" src={canvas} />
    </div>
  )
}
"""

proc expectedFrame(canvas: Image): Image =
  ## The board drawn whole: grey, and the canvas 1:1 at (10, 10).
  result = newImage(W, H)
  result.fill(parseHtmlColor("#cbd5e1").rgbx)
  result.draw(canvas, translate(vec2(10, 10)))

proc closeTo(a, b: Image): bool =
  for y in 0 ..< H:
    for x in 0 ..< W:
      let (p, q) = (a[x, y], b[x, y])
      if abs(p.r.int - q.r.int) > 2 or abs(p.g.int - q.g.int) > 2 or abs(p.b.int - q.b.int) > 2:
        return false
  true

proc canvasOf(ui: Ui): Image =
  # The one canvas the board keeps (its ref is the first image it made).
  for id, image in ui.runtime.images:
    if image.width == 100 and image.height == 60:
      return image

suite "canvases":
  test "the same canvas every render, fresh only the first time":
    let ui = newUi(board, "tests/canvas-fresh")
    discard ui.render()
    check ui.scene.state{"fresh"}.getBool() == true
    discard ui.render()
    check ui.scene.state{"fresh"}.getBool() == false
    releaseIdleJsAppRuntimes()
    discard ui.render()
    check ui.scene.state{"fresh"}.getBool() == true # a new interpreter: made again

  test "a line drawn into it shows, and stays":
    let ui = newUi(board, "tests/canvas-line")
    ui.scene.state["seg"] = %*0
    discard ui.render()
    ui.scene.state["seg"] = %*1
    let first = ui.render()
    # From (6, 12) to (9, 28): on the line, and off it.
    check first[10 + 7, 10 + 18] != rgbx(255, 255, 255, 255)
    check first[10 + 90, 10 + 55] == rgbx(255, 255, 255, 255)
    ui.scene.state.delete("seg")
    let again = ui.render()
    check again[10 + 7, 10 + 18] == first[10 + 7, 10 + 18]

  test "three buffers: each repaints what was drawn since its frame, and matches a whole render":
    forgetPanelFrames()
    var
      store: array[3, seq[ColorRGBX]]
      bufs: array[3, Image]
    for b in 0 .. 2:
      bufs[b] = newImage(W, H)
    let ui = newUi(board, "tests/canvas-buffers")
    var most = 0
    for i in 0 ..< 24:
      ui.scene.state["seg"] = %*i
      let target = bufs[i mod 3]
      beginPanelFrame(target.bufferPointer, 0)
      svgFramePixelsForTest = -1
      discard ui.render(target)
      endPanelFrame()
      if i >= 4:
        most = max(most, svgFramePixelsForTest)
      check closeTo(target, expectedFrame(ui.canvasOf()))
    # The three segments drawn since a buffer's frame, each its own box, a
    # round line's half width around it: never the canvas between them.
    checkpoint $most
    check most > 0 and most < 100 * 60 div 5
    # A clear repaints the canvas whole, in every buffer in turn.
    ui.scene.state["clear"] = %*true
    if ui.scene.state.hasKey("seg"):
      ui.scene.state.delete("seg")
    for i in 24 ..< 27:
      let target = bufs[i mod 3]
      beginPanelFrame(target.bufferPointer, 0)
      discard ui.render(target)
      endPanelFrame()
      check closeTo(target, expectedFrame(ui.canvasOf()))
      check target[60, 40] == parseHtmlColor("#0f172a").rgbx

  test "a draw keeps the UI's handlers":
    let ui = newUi("""
      let canvas = null
      export function get(app) {
        canvas = frameos.canvas('c', 20, 20)
        frameos.draw(canvas, '<circle cx="10" cy="10" r="4" fill="#000"/>')
        return <div className="w-full h-full bg-white">
          <div className="w-10 h-10" onClick={() => frameos.setState('tapped', true)}><img className="w-full h-full" src={canvas} /></div>
        </div>
      }
    """, "tests/canvas-handlers")
    discard ui.render()
    check dispatchUiEvent("tests/canvas-handlers", "tap", %*{"x": 5, "y": 5, "pointerId": 0, "pointerType": "touch"})
    check ui.scene.state{"tapped"}.getBool() == true

  test "draw and clear refuse what is not a canvas":
    let ui = newUi("""
      export function get(app) {
        frameos.setState('draw', frameos.draw({ id: 42 }, '<rect width="5" height="5"/>'))
        frameos.setState('clear', frameos.clear(null))
        frameos.setState('canvas', frameos.canvas('x', 0, 0))
        return <div className="bg-white" />
      }
    """, "tests/canvas-refuse")
    discard ui.render()
    check ui.scene.state{"draw"}.getBool() == false
    check ui.scene.state{"clear"}.getBool() == false
    check ui.scene.state{"canvas"}.kind == JNull
