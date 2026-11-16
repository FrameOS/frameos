## The Touch test sample scene (repo/scenes/samples/Touch test): one JS app
## that hears the pointer (config.json `events`, onEvent) and draws where it
## is, the gesture the frame made of it, and the trail of a drag. Run for
## real through the JS app runtime, this pins that a held drag draws every
## move from the press to the finger and keeps it after the lift until the
## next press, that an LCD asks for a render a move and e-paper waits for the
## lift, that a long drag keeps a bounded trail, that a move repaints its
## piece of the trail and not the whole of it, and the scene's wiring; and,
## through the interpreter, that the scene hears the moves at all (it had no
## `pointerMove` listener, so a held drag did not update it).

import std/[json, os, sequtils, tables, unittest]
import pixie

import frameos/interpreter
import frameos/js_runtime/app_runtime
import frameos/utils/svg_frames
import frameos/types
import frameos/values

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  SamplePath = Repo / "repo" / "scenes" / "samples" / "Touch test" / "scenes.json"
  Lcd = "framebuffer"
  Paper = "waveshare.EPD_7in5_V2"
  # The app's colors: the dot and the trail's dots, its line, held and lifted.
  Red = rgbx(0xd1, 0x3c, 0x3c, 255)
  Blue = rgbx(0x2f, 0x6f, 0xe0, 255)
  PaleRed = rgbx(0xf0, 0xa8, 0xa8, 255)
  PaleBlue = rgbx(0xa8, 0xc2, 0xf2, 255)
  White = rgbx(255, 255, 255, 255)

let
  sample = parseJson(readFile(SamplePath))[0]
  app = sample["apps"]["touchCursor"]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Touch = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

proc newTouch(id, device: string, width = 400, height = 300): Touch =
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp", device: device)
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "touch", appKeyword: "touchCursor", scene: result.scene,
    frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image",
    source = app["sources"]["app.tsx"].getStr(), sourceName = "app.tsx", sources = app["sources"])

proc render(t: Touch): Image =
  let context = ExecutionContext(scene: t.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: nil, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: false)
  t.runtime.get(t.owner, %*{}, context).asImage()

proc intoPanel(t: Touch, target: Image) =
  ## One render of an LCD's buffer, the way the ESP32's render does it.
  let context = ExecutionContext(scene: t.scene, event: "render", payload: %*{},
    hasImage: true, image: target, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: target, decodeTargetNodeId: 1.NodeId, decodeTargetScalingMode: "stretch",
    wholeFrame: true, backgroundPending: true, backgroundColor: rgba(255, 255, 255, 255).color)
  beginPanelFrame(target.bufferPointer, 1)
  discard t.runtime.get(t.owner, %*{}, context).asImage()
  endPanelFrame()

proc event(t: Touch, name: string, payload: JsonNode): bool =
  ## Whether the app asks for a render.
  let context = ExecutionContext(scene: t.scene, event: name, payload: payload,
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
  t.runtime.run(t.owner, %*{}, context, isEvent = true)

proc down(t: Touch, x, y: int, id = 1): bool =
  t.event("pointerDown", %*{"x": x, "y": y, "button": 0, "buttons": 1, "pointerId": id, "pointerType": "touch"})

proc move(t: Touch, x, y: int, id = 1, buttons = 1, kind = "touch"): bool =
  t.event("pointerMove", %*{"x": x, "y": y, "buttons": buttons, "pointerId": id, "pointerType": kind})

proc up(t: Touch, x, y: int, id = 1): bool =
  t.event("pointerUp", %*{"x": x, "y": y, "button": 0, "buttons": 0, "pointerId": id, "pointerType": "touch"})

proc seen(t: Touch): JsonNode =
  ## What the app keeps with frameos.remember (at a render, or an event that
  ## is not a move).
  parseJson(t.runtime.memory["seen"])

proc near(c, want: ColorRGBX): bool =
  abs(c.r.int - want.r.int) <= 24 and abs(c.g.int - want.g.int) <= 24 and abs(c.b.int - want.b.int) <= 24

proc same(a, b: Image): bool =
  if a.width != b.width or a.height != b.height:
    return false
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        return false
  true

proc strays(a, b: Image): int =
  ## Pixels more than one step of RGB565 apart (test_svg_frames.nim's rule).
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let (p, q) = (a[x, y], b[x, y])
      if abs(p.r.int - q.r.int) > 9 or abs(p.g.int - q.g.int) > 9 or abs(p.b.int - q.b.int) > 9:
        inc result

proc drag(t: Touch): int =
  ## A finger down at (60, 150) moved right to (340, 150), ten pixels a move:
  ## how many of the 28 moves asked for a render.
  for x in countup(70, 340, 10):
    if t.move(x, 150):
      inc result

suite "Touch test":
  test "one render node, its picture from the app, which hears the pointer":
    check sample["id"].getStr() == "touch-test"
    check sample["fields"].len == 0
    check sample["settings"]["refreshInterval"].getFloat() == 3600 # it renders when touched
    let byId = sample["nodes"].mapIt((it["id"].getStr(), it["data"]["keyword"].getStr()))
    check byId.len == 3
    proc keyword(id: string): string =
      for (nodeId, keyword) in byId:
        if nodeId == id: return keyword
    var flows, fields: seq[string]
    for edge in sample["edges"]:
      let link = keyword(edge["source"].getStr()) & " -> " & keyword(edge["target"].getStr())
      if edge["sourceHandle"].getStr() == "next":
        flows.add link
      else:
        fields.add link & " " & edge["targetHandle"].getStr()
    # The render flow is one node, so on an LCD the app's SVG is the whole
    # frame and a move repaints only what it changed (utils/svg_frames.nim).
    check flows == @["render -> render/image"]
    check fields == @["touchCursor -> render/image fieldInput/image"]
    let config = parseJson(app["sources"]["config.json"].getStr())
    check config["events"] == %*["pointerDown", "pointerMove", "pointerUp", "pointerCancel", "tap", "doubleTap",
      "longPress", "swipe"]

  test "a held drag on an LCD draws every move, from the ring at the press to the dot":
    let t = newTouch("tests/touch-lcd", Lcd)
    discard t.render() # a render finds out what the panel is
    check t.down(60, 150)
    check t.drag() == 28 # a render a move
    let held = t.render()
    check held[60, 132].near(Red) # the ring around the press
    check held[200, 150].near(Red) # the dot of the move at x 200
    check held[205, 150].near(PaleRed) # the line between two moves
    check held[205, 149].near(PaleRed)
    check held[340, 158].near(Red) # the finger
    check held[205, 160] == White
    check t.up(340, 150)
    check t.event("swipe", %*{"direction": "right", "x": 340, "y": 150, "startX": 60, "startY": 150,
      "pointerId": 1, "pointerType": "touch"})
    let lifted = t.render()
    # The trail stays after the lift, in blue.
    check lifted[60, 132].near(Blue)
    check lifted[200, 150].near(Blue)
    check lifted[205, 150].near(PaleBlue)
    check lifted[340, 158].near(Blue)
    let kept = t.seen()
    check kept["last"].getStr() == "swipe right"
    check kept["count"].getInt() == 3 # the down, the up, the swipe: moves are not counted
    check kept["moves"].getInt() == 28
    check kept["down"].getBool() == false
    check kept["trail"].len == 2 * 29 # the press and every move; the lift where the last move was
    check kept["trail"][0].getInt() == 60 and kept["trail"][1].getInt() == 150

  test "e-paper waits for the finger to lift, then draws the whole drag":
    let t = newTouch("tests/touch-paper", Paper)
    discard t.render()
    check not t.down(60, 150)
    check t.drag() == 0
    check t.up(340, 150)
    let lifted = t.render()
    check lifted[60, 132].near(Blue)
    check lifted[200, 150].near(Blue)
    check lifted[205, 150].near(PaleBlue)
    check lifted[340, 158].near(Blue)
    check t.seen()["moves"].getInt() == 28
    # A tap draws once, at the lift.
    check not t.down(200, 60)
    check t.up(200, 60)
    check t.event("tap", %*{"x": 200, "y": 60, "pointerId": 1, "pointerType": "touch"})

  test "a mouse moving with nothing pressed, or another finger, draws nothing":
    let t = newTouch("tests/touch-hover", Lcd)
    let before = t.render()
    check not t.move(100, 100, id = 0, buttons = 0, kind = "mouse")
    check same(before, t.render())
    check t.down(60, 150)
    check not t.move(100, 100, id = 2) # not the finger that pressed
    check t.move(70, 150)
    check not t.move(71, 150, id = 2)
    discard t.render()
    check t.seen()["trail"] == %*[60, 150, 70, 150]

  test "the trail stays until the next press, which starts a new one":
    let t = newTouch("tests/touch-next", Lcd)
    discard t.render()
    check t.down(60, 150)
    check t.drag() == 28
    check t.up(340, 150)
    check t.render()[255, 150].near(PaleBlue)
    check t.down(200, 60)
    check t.up(200, 60)
    check t.event("tap", %*{"x": 200, "y": 60, "pointerId": 1, "pointerType": "touch"})
    let tapped = t.render()
    check tapped[255, 150] == White # the old trail is gone
    check tapped[200, 42].near(Blue) # the new ring
    let kept = t.seen()
    check kept["last"].getStr() == "tap"
    check kept["moves"].getInt() == 0
    check kept["trail"] == %*[200, 60]

  test "a long drag keeps at most 256 points, from the press to the finger":
    let t = newTouch("tests/touch-long", Lcd)
    discard t.render()
    check t.down(10, 10)
    var x, y: int
    for i in 1 .. 2000:
      x = 10 + (i * 3) mod 380
      y = 10 + (i * 7) mod 280
      discard t.move(x, y)
    discard t.render()
    let trail = t.seen()["trail"]
    checkpoint $(trail.len div 2) & " points"
    check trail.len div 2 <= 256
    check trail.len div 2 > 128
    check trail[0].getInt() == 10 and trail[1].getInt() == 10
    check trail[trail.len - 2].getInt() == x and trail[trail.len - 1].getInt() == y
    check t.seen()["moves"].getInt() == 2000

  test "an interpreter dropped after a render loses no move":
    # An ESP32 short of memory drops idle interpreters after a render, and
    # the app's module with them: the trail is in frameos.remember.
    let t = newTouch("tests/touch-dropped", Lcd)
    discard t.render()
    check t.down(60, 150)
    for x in countup(70, 200, 10):
      check t.move(x, 150)
    discard t.render()
    check releaseIdleJsAppRuntimes()
    for x in countup(210, 340, 10):
      check t.move(x, 150)
    check t.up(340, 150)
    let lifted = t.render()
    check lifted[205, 150].near(PaleBlue)
    check lifted[305, 150].near(PaleBlue)
    check t.seen()["moves"].getInt() == 28
    check t.seen()["trail"].len == 2 * 29

  test "on an LCD a move repaints its piece of the trail, not the whole of it":
    forgetPanelFrames()
    let t = newTouch("tests/touch-panel", Lcd)
    let target = newImage565(400, 300)
    t.intoPanel(target)
    check t.down(20, 280)
    # Back and forth across the whole panel: one path for the trail would
    # be damage over all of it at every move.
    for i in 1 .. 100:
      check t.move(20 + i * 3, if (i div 10) mod 2 == 0: 30 + (i mod 10) * 25 else: 255 - (i mod 10) * 25)
      t.intoPanel(target)
    check t.move(323, 32) # a few pixels on from the last
    t.intoPanel(target)
    let whole = 400 * 300
    checkpoint $svgFramePixelsForTest & " of " & $whole & " pixels repainted"
    check svgFramePixelsForTest < whole div 3
    # And what it repainted is the picture a whole render draws, but for an
    # anti-aliased edge pixel that a box drawn on its own may round otherwise.
    forgetPanelFrames()
    let fresh = newImage565(400, 300)
    t.intoPanel(fresh)
    check strays(target, fresh) <= 2

  test "through the interpreter: the scene hears a held drag and draws it":
    let config = FrameConfig(width: 400, height: 300, rotate: 0, scalingMode: "cover", debug: false,
      settings: %*{}, saveAssets: %*false, assetsPath: "/tmp", device: Lcd)
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[sample])))
    resetInterpretedScenes()
    let scene = init("touch-test".SceneId, config, testLogger(config), %*{})
    for event in ["pointerDown", "pointerMove", "pointerUp", "pointerCancel", "tap", "doubleTap", "longPress",
        "swipe"]:
      checkpoint event
      check sceneListensTo(scene, event)
    check not sceneListensTo(scene, "keyDown")
    let canvas = newImage(400, 300)
    proc frame() =
      discard render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{}, image: canvas,
        hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
    proc pointer(event: string, x, y: int) =
      runEvent(scene, ExecutionContext(scene: scene, event: event, payload: %*{"x": x, "y": y, "button": 0,
        "buttons": (if event == "pointerUp": 0 else: 1), "pointerId": 1, "pointerType": "touch"},
        loopIndex: 0, loopKey: ".", nextSleep: -1))
    frame()
    pointer("pointerDown", 60, 150)
    for x in countup(70, 340, 10):
      pointer("pointerMove", x, 150)
    frame()
    check canvas[60, 132].near(Red)
    check canvas[205, 150].near(PaleRed)
    check canvas[340, 158].near(Red)
    pointer("pointerUp", 340, 150)
    frame()
    check canvas[205, 150].near(PaleBlue)
    check canvas[340, 158].near(Blue)
