import std/[json, options, strformat, tables, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/ui/events
import frameos/utils/font # the typeface resolver the layout's text uses
import frameos/utils/svg_frames
import frameos/utils/canvas_log

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

  test "one canvas drawn into another: an Undo's starting point":
    # A paint page keeps all but its last strokes in a second canvas and
    # draws that back before the few it can take back.
    let ui = newUi("""
      export function get(app) {
        const base = frameos.canvas('base', 20, 10, '#ffffff')
        const paint = frameos.canvas('paint', 20, 10, '#ffffff')
        frameos.draw(base, <rect x={2} y={2} width={4} height={4} fill="#ff0000" />)
        frameos.draw(paint, <rect x={12} y={2} width={4} height={4} fill="#0000ff" />)
        frameos.setState('copied', frameos.draw(paint, <image href={base} x={0} y={0} width={20} height={10} preserveAspectRatio="none" />))
        return <div className="w-full h-full bg-white"><img className="w-[20px] h-[10px]" src={paint} /></div>
      }
    """, "tests/canvas-copy")
    discard ui.render()
    check ui.scene.state{"copied"}.getBool() == true
    var
      paint: Image
      newest = -1
    for id, image in ui.runtime.images:
      if image.width == 20 and id > newest: # 'paint', made second
        paint = image
        newest = id
    check not paint.isNil
    # The base's red where it was drawn, and its white over the paint's blue.
    check paint[3, 3] == rgbx(255, 0, 0, 255)
    check paint[13, 3] == rgbx(255, 255, 255, 255)

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

# `frameos.putPixels(canvas, bytes, options)`: pixels written straight into
# a canvas, RGBA or one palette index each, every source pixel a
# pixelSize square (docs/jsx-ui.md "Canvases").
const pixelBoard = """
export function get(app) {
  const c = frameos.canvas('px', 100, 60, '#ffffff')
  const mode = app.state.mode
  let ok = null
  if (mode === 'rgba') {
    const d = new Uint8Array([255,0,0,255, 0,255,0,255, 0,0,255,255, 9,9,9,0])
    ok = frameos.putPixels(c, d, { x: 10, y: 20, width: 2, height: 2 })
  } else if (mode === 'palette') {
    ok = frameos.putPixels(c, new Uint8Array([0, 1, 2, 7]),
      { x: 4, y: 6, width: 2, height: 2, pixelSize: 5, palette: ['#000000', '#ff0000', 0x00ff00] })
  } else if (mode === 'clip') {
    ok = frameos.putPixels(c, new Uint8Array(9).fill(1),
      { x: 96, y: -2, width: 3, height: 3, pixelSize: 3, palette: ['#fff', '#123456'] })
  } else if (mode === 'short') {
    ok = frameos.putPixels(c, new Uint8Array(3), { width: 2, height: 2, palette: ['#000'] })
  } else if (mode === 'notbytes') {
    ok = frameos.putPixels(c, [1, 2, 3, 4], { width: 1, height: 1 })
  } else if (mode === 'buffer') {
    const ab = new ArrayBuffer(100 * 60)
    new Uint8Array(ab).fill(1)
    ok = frameos.putPixels(c, ab, { palette: ['#000', '#0000ff'] })
  } else if (mode === 'subarray') {
    const big = new Uint8Array(20).fill(1)
    big[10] = 0
    ok = frameos.putPixels(c, big.subarray(10, 14), { x: 0, y: 0, width: 2, height: 2, palette: ['#ff0000', '#00ff00'] })
  } else if (mode === 'changes') {
    const cells = new Uint8Array(20 * 12)
    const palette = ['#000000', '#ff0000']
    const step = app.state.step
    if (step >= 1) cells.fill(1, 4 * 20, 6 * 20) // rows 4 and 5
    if (step === 3) frameos.clear(c, '#00ff00')
    ok = frameos.putPixels(c, cells, { width: 20, height: 12, pixelSize: 5, palette })
    if (step === 4) ok = frameos.putPixels(c, cells, { width: 20, height: 12, pixelSize: 5, palette: ['#000000', '#0000ff'] })
  } else if (mode === 'outside') {
    ok = frameos.putPixels(c, new Uint8Array(4), { x: 200, y: 0, width: 2, height: 2, palette: ['#000'] })
  }
  frameos.setState('ok', ok)
  return (
    <div className="w-full h-full p-[10px] bg-slate-300">
      <img className="w-[100px] h-[60px]" src={c} />
    </div>
  )
}
"""

proc pixelUi(mode: string, id: string): Ui =
  result = newUi(pixelBoard, "tests/putpixels-" & id)
  result.scene.state["mode"] = %*mode

suite "putPixels":
  const
    white = rgbx(255, 255, 255, 255)
    red = rgbx(255, 0, 0, 255)
    green = rgbx(0, 255, 0, 255)
    blue = rgbx(0, 0, 255, 255)
    black = rgbx(0, 0, 0, 255)

  test "RGBA bytes land as pixels; alpha 0 leaves the canvas alone":
    let ui = pixelUi("rgba", "rgba")
    let frame = ui.render()
    check ui.scene.state{"ok"}.getBool() == true
    let c = ui.canvasOf()
    check c[10, 20] == red
    check c[11, 20] == green
    check c[10, 21] == blue
    check c[11, 21] == white
    check c[12, 20] == white and c[9, 20] == white
    # and the UI shows it where the <img> is
    check frame[10 + 10, 10 + 20] == red
    check frame[10 + 11, 10 + 21] == white

  test "a palette's indices as pixelSize squares; an index past it is left as it was":
    let ui = pixelUi("palette", "palette")
    discard ui.render()
    check ui.scene.state{"ok"}.getBool() == true
    let c = ui.canvasOf()
    for dy in 6 .. 10:
      for dx in 4 .. 8:
        check c[dx, dy] == black
      for dx in 9 .. 13:
        check c[dx, dy] == red
    for dy in 11 .. 15:
      for dx in 4 .. 8:
        check c[dx, dy] == green
      for dx in 9 .. 13:
        check c[dx, dy] == white
    check c[3, 6] == white and c[14, 6] == white and c[4, 5] == white and c[4, 16] == white

  test "what falls outside the canvas is clipped":
    let ui = pixelUi("clip", "clip")
    discard ui.render()
    check ui.scene.state{"ok"}.getBool() == true
    let
      c = ui.canvasOf()
      ink = parseHtmlColor("#123456").rgbx
    check c[96, 0] == ink and c[99, 0] == ink and c[99, 6] == ink
    check c[95, 0] == white and c[99, 7] == white

  test "an ArrayBuffer fills the whole canvas by default":
    let ui = pixelUi("buffer", "buffer")
    discard ui.render()
    check ui.scene.state{"ok"}.getBool() == true
    let c = ui.canvasOf()
    check c[0, 0] == blue and c[99, 59] == blue and c[50, 30] == blue

  test "a typed array's own view: its offset and length, not the buffer's":
    let ui = pixelUi("subarray", "subarray")
    discard ui.render()
    check ui.scene.state{"ok"}.getBool() == true
    let c = ui.canvasOf()
    check c[0, 0] == red
    check c[1, 0] == green and c[0, 1] == green and c[1, 1] == green
    check c[2, 0] == white

  test "too few bytes, or no bytes at all, is refused and the canvas untouched":
    for mode in ["short", "notbytes"]:
      let ui = pixelUi(mode, mode)
      discard ui.render()
      check ui.scene.state{"ok"}.getBool() == false
      let c = ui.canvasOf()
      check c[0, 0] == white and c[1, 1] == white
    let outside = pixelUi("outside", "outside")
    discard outside.render()
    check outside.scene.state{"ok"}.getBool() == true # nothing to draw is not an error

  test "the box written is one draw in the canvas's log":
    let ui = pixelUi("palette", "log")
    discard ui.render()
    let log = canvasLogOf(ui.canvasOf())
    check not log.isNil
    let before = log.version
    discard ui.render()
    check log.version == before + 1
    let changed = log.changedSince(before)
    check changed.known
    check changed.boxes == @[rect(4, 6, 10, 10)]

  test "a palette frame that fills the canvas writes and notes only the rows that changed":
    let ui = pixelUi("changes", "changes")
    ui.scene.state["step"] = %*0
    discard ui.render() # the first is written whole
    let c = ui.canvasOf()
    let log = canvasLogOf(c)
    check c[0, 0] == black and c[99, 59] == black
    var before = log.version

    discard ui.render() # the same cells: nothing at all
    check ui.scene.state{"ok"}.getBool() == true
    check log.version == before

    ui.scene.state["step"] = %*1
    discard ui.render()
    check log.version == before + 1
    check log.changedSince(before).boxes == @[rect(0, 20, 100, 10)]
    check c[50, 19] == black and c[50, 20] == red and c[50, 29] == red and c[50, 30] == black
    before = log.version

    ui.scene.state["step"] = %*2 # the same cells as step 1
    discard ui.render()
    check log.version == before

    # Anything else drawn into the canvas means the next frame cannot trust
    # its copy: `clear` is a draw in the log, and every cell is written again.
    ui.scene.state["step"] = %*3
    discard ui.render()
    check c[50, 0] == black and c[50, 25] == red and c[50, 59] == black

    # So does another palette, whose cells look the same.
    ui.scene.state["step"] = %*4
    discard ui.render()
    check c[50, 25] == blue and c[50, 0] == black

  test "boxes that cost no more as one are one, in what a frame repaints":
    let log = registerCanvas(newImage(100, 100))
    log.drew(rect(0, 40, 100, 60))
    log.drew(rect(0, 42, 100, 58))
    log.drew(rect(0, 38, 100, 62))
    check log.changedSince(0).boxes == @[rect(0, 38, 100, 62)] # one copy, not three
    let apart = registerCanvas(newImage(100, 100))
    apart.drew(rect(0, 0, 10, 10))
    apart.drew(rect(9, 9, 10, 10)) # they meet at a corner: the join is 361 for 200
    apart.drew(rect(50, 50, 10, 10))
    check apart.changedSince(0).boxes.len == 3

  test "a 565 canvas (an LCD's) takes the same bytes":
    let ui = pixelUi("palette", "565")
    let target = newImage565(W, H)
    let frame = ui.render(target)
    check ui.scene.state{"ok"}.getBool() == true
    let c = ui.canvasOf()
    check c.format == pfRgb565
    check c[5, 7] == black and c[10, 7] == rgb565ToRgbx(rgbxToRgb565(red))
    check frame[10 + 5, 10 + 12] == rgb565ToRgbx(rgbxToRgb565(green))

  test "a sixteen-grey canvas (an e-paper's) is dithered where each pixel lands":
    # pixie's storeGray4 picks each pixel's level by its place in the 4x4
    # ordered matrix: the palette's fast path, and a clipped square's rows
    # (no row a copy of the one above), store what a pixel-by-pixel write would.
    for (mode, boxes) in [
        ("palette", @[(4, 6, 9, 11, black), (9, 6, 14, 11, red), (4, 11, 9, 16, green)]),
        ("clip", @[(96, 0, 100, 7, parseHtmlColor("#123456").rgbx)])]:
      let ui = pixelUi(mode, "gray4-" & mode)
      discard ui.render(newImageGray4(W, H))
      check ui.scene.state{"ok"}.getBool() == true
      let c = ui.canvasOf()
      check c.format == pfGray4
      let expected = newImageGray4(c.width, c.height)
      for y in 0 ..< c.height:
        for x in 0 ..< c.width:
          var color = white
          for (x0, y0, x1, y1, fill) in boxes:
            if x in x0 ..< x1 and y in y0 ..< y1:
              color = fill
          expected.setPixel(expected.dataIndex(x, y), color)
      var wrong = 0
      for y in 0 ..< c.height:
        for x in 0 ..< c.width:
          if gray4Level(c.data8, c.dataIndex(x, y)) != gray4Level(expected.data8, expected.dataIndex(x, y)):
            inc wrong
      checkpoint mode
      check wrong == 0
