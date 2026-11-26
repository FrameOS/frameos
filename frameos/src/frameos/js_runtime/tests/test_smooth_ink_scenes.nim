## The two drawing samples, Sketchbook and Handwriting notes
## (repo/scenes/samples), run for real through the JS app runtime and the JSX
## events: a finger's stroke keeps every point it passes (the ones a busy
## frame coalesced into a move, `points`, included), is drawn as one smooth
## curve a piece at a time, a render asked at every move on every panel (the
## frame paces them by its glass: one partial update after another on
## e-paper, each with the moves that came meanwhile), and what the pieces drew
## is the stroke drawn whole. Also the ink helpers' path and
## its points read back (the SVG files the apps save).

import std/[json, math, os, tables, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/js_runtime/burrito
import frameos/types
import frameos/values
import frameos/ui/events
import frameos/utils/font # the typeface resolver the layout's text uses

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  Samples = Repo / "repo" / "scenes" / "samples"
  Lcd = "framebuffer"
  Paper = "waveshare.EPD_7in5_V2"
  W = 800
  H = 480

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Board = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene
  id: string

proc sampleApp(folder: string): JsonNode =
  parseJson(readFile(Samples / folder / "scenes.json"))[0]["apps"]["jsxUi"]

proc newBoard(folder, id, device: string, source = ""): Board =
  let app = sampleApp(folder)
  let config = FrameConfig(width: W, height: H, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: getTempDir() / "frameos-smooth-ink", device: device)
  result.id = id
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.scene.refreshInterval = 3600
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "ink", appKeyword: "jsxUi", scene: result.scene,
    frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image",
    source = (if source.len > 0: source else: app["sources"]["app.tsx"].getStr()), sourceName = "app.tsx",
    sources = app["sources"])

proc render(b: Board): Image =
  let context = ExecutionContext(scene: b.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: nil, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: false)
  b.runtime.get(b.owner, %*{}, context).asImage()

proc clock(b: Board, ms: int) =
  ## The apps pace a stroke by Date.now(): a clock of the test's, moved by hand.
  discard b.runtime.js.eval("globalThis.__inkNow = (globalThis.__inkNow || 1e6) + " & $ms &
    "; Date.now = () => globalThis.__inkNow;")

proc touch(x, y: float, buttons = 1, points: seq[float] = @[]): JsonNode =
  result = %*{"x": x, "y": y, "pointerId": 1, "pointerType": "touch", "buttons": buttons}
  if points.len > 0:
    result["points"] = %points

proc curveAt(x0, y0: float, t: float): (float, float) =
  ## The stroke the tests draw: a wave 360 px long, 60 px high.
  (x0 + t * 360, y0 + 60 * sin(t * 2 * PI))

type Stroked = object
  asked: int   ## moves that asked for a render
  moves: int
  passed: int  ## positions carried in `points`

proc stroke(b: var Board, x0, y0: float, moves = 240, msPerMove = 10, coalesceEvery = 6,
    renderWhenAsked = true): Stroked =
  ## A finger down at the wave's start, a move every `msPerMove` ms along it,
  ## every `coalesceEvery`th carrying the two positions before it in `points`
  ## (what a frame busy rendering hands over), and up at its end.
  b.clock(0)
  discard dispatchUiEvent(b.id, "pointerDown", touch(x0, y0))
  var i = 1
  let steps = moves * 3 div 2 # every position of the finger, some only in points
  while i <= steps:
    b.clock(msPerMove)
    var passed: seq[float]
    if coalesceEvery > 0 and result.moves mod coalesceEvery == coalesceEvery - 1 and i + 2 <= steps:
      for j in 0 .. 1:
        let (px, py) = curveAt(x0, y0, (i + j) / steps)
        passed.add [px, py]
      i += 2
      result.passed += 2
    let (x, y) = curveAt(x0, y0, i / steps)
    inc result.moves
    if dispatchUiEvent(b.id, "pointerMove", touch(x, y, points = passed)):
      inc result.asked
      if renderWhenAsked:
        discard b.render()
    inc i
  let (x, y) = curveAt(x0, y0, 1.0)
  b.clock(msPerMove)
  check dispatchUiEvent(b.id, "pointerUp", touch(x, y, buttons = 0))
  discard b.render()

proc canvasOf(b: Board, width, height: int): Image =
  for id, image in b.runtime.images:
    if image.width == width and image.height == height:
      return image

proc dark(c: ColorRGBX): bool = c.r.int + c.g.int + c.b.int < 3 * 140

proc inkNear(img: Image, x, y: float, reach = 2): bool =
  for dy in -reach .. reach:
    for dx in -reach .. reach:
      let (px, py) = (int(round(x)) + dx, int(round(y)) + dy)
      if px >= 0 and py >= 0 and px < img.width and py < img.height and img[px, py].dark:
        return true

proc differing(a, b: Image): int =
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let (p, q) = (a[x, y], b[x, y])
      if abs(p.r.int - q.r.int) > 40 or abs(p.g.int - q.g.int) > 40 or abs(p.b.int - q.b.int) > 40:
        inc result

proc copyOf(img: Image): Image =
  result = newImage(img.width, img.height)
  result.draw(img)

suite "smooth ink":
  test "the ink helpers: pieces make the whole curve, and its points read back":
    var b = newBoard("Sketchbook", "tests/ink-helpers", Lcd, source = """
      import { inkPiece, inkPath, inkPoints, addPoint } from './ink'
      export function get(app) {
        const stroke = ['#000', 2, 0, 0]
        for (const [x, y] of [[10, 0], [10.5, 0.2], [20, 10], [30, 0], [40, 10]]) addPoint(stroke, x, y, 1)
        const whole = inkPath(stroke)
        // Drawn as the points come: a piece each time, the tail at the lift.
        let drawn = 0
        let pieces = []
        for (let n = 1; n <= 5; n++) {
          const part = stroke.slice(0, 2 + 2 * n)
          const piece = inkPiece(part, drawn, n === 5)
          if (piece.d) pieces.push(piece.d)
          drawn = piece.drawn
        }
        frameos.setState('stroke', stroke)
        frameos.setState('whole', whole)
        frameos.setState('pieces', pieces)
        frameos.setState('back', inkPoints(whole))
        frameos.setState('two', inkPoints(inkPath(['#000', 2, 1, 2, 3, 4])))
        return <div />
      }
    """)
    discard b.render()
    let st = b.scene.state
    check st["stroke"] == %*["#000", 2, 0, 0, 10, 0, 20, 10, 30, 0, 40, 10] # 10.5, 0.2 is under a pixel away
    check st["whole"].getStr() == "M0 0L5 0Q10 0 15 5Q20 10 25 5Q30 0 35 5L40 10"
    check st["pieces"] == %*["M0 0L5 0", "M5 0Q10 0 15 5", "M15 5Q20 10 25 5", "M25 5Q30 0 35 5L40 10"]
    check st["back"] == %*[0, 0, 10, 0, 20, 10, 30, 0, 40, 10]
    check st["two"] == %*[1, 2, 3, 4]

  for (folder, x0, y0, width) in [("Sketchbook", 250.0, 240.0, 800), ("Handwriting notes", 200.0, 260.0, 800)]:
    test folder & ": on e-paper a stroke keeps every point and is shown as it is drawn":
      var b = newBoard(folder, "tests/ink-paper-" & folder, Paper)
      discard b.render()
      let s = b.stroke(x0, y0)
      checkpoint $s
      # Every move asks: the frame renders when its glass can take the next
      # picture, and the moves that came meanwhile arrive as one, with
      # `points` (as every sixth here does).
      check s.asked == s.moves
      let key = if folder == "Sketchbook": "drawing" else: "notebook"
      let strokes = b.scene.state[key]["strokes"]
      check strokes.len == 1
      let points = (strokes[0].len - 2) div 2
      checkpoint $points & " points kept"
      # Every position of the finger, the coalesced ones too (a few fall under
      # the step that a finger cannot see).
      check points >= (s.moves + s.passed) * 9 div 10

    test folder & ": on an LCD every move asks, and the pieces drawn are the stroke drawn whole":
      var b = newBoard(folder, "tests/ink-lcd-" & folder, Lcd)
      discard b.render()
      let s = b.stroke(x0, y0, moves = 120)
      check s.asked == s.moves
      let height = block:
        var h = 0
        for id, image in b.runtime.images:
          if image.width == width and image.height > h: h = image.height
        h
      let drawn = b.canvasOf(width, height).copyOf()
      # The curve is inked along the wave (the canvas is the page area: the
      # notes' sits under its bar).
      let top = H - height
      var on = 0
      for k in 1 .. 19:
        let (x, y) = curveAt(x0, y0, k / 20)
        if drawn.inkNear(x, y - top.float): inc on
      check on == 19
      # A new interpreter draws the drawing again from its record, whole:
      # what the pieces drew is that, but for edge pixels at a seam, which the
      # round ends of two pieces both soften (a piece a move here, 120 seams
      # along a stroke about 450 px long).
      check releaseIdleJsAppRuntimes()
      discard b.render()
      let again = b.canvasOf(width, height)
      check not again.isNil
      let off = differing(drawn, again)
      checkpoint $off & " pixels apart"
      check off < 150

  test "on e-paper a press shows its dot at once, and a mouse passing over asks nothing":
    var b = newBoard("Handwriting notes", "tests/ink-paper-tap", Paper)
    discard b.render()
    b.clock(0)
    check not dispatchUiEvent(b.id, "pointerMove", %*{"x": 300, "y": 300, "pointerId": 0, "pointerType": "mouse",
      "buttons": 0})
    check dispatchUiEvent(b.id, "pointerDown", touch(300, 300))
    b.clock(80)
    check dispatchUiEvent(b.id, "pointerUp", touch(300, 300, buttons = 0))
    discard b.render()
    let strokes = b.scene.state["notebook"]["strokes"]
    check strokes.len == 1 and strokes[0].len == 4 # a dot
