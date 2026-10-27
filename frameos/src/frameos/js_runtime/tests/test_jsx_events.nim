import std/[json, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/ui/events
import frameos/utils/font

# A JSX UI's handlers and pointer classes (docs/jsx-ui.md "Events"): what the
# last render left where, a tap or a move over it, and the next render.

var logged: seq[string]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logged.add $payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

type Ui = object
  runtime: JsAppRuntime
  owner: AppRoot
  scene: FrameScene

proc newUi(source: string, id: string): Ui =
  let config = FrameConfig(width: 200, height: 100, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: "ui", scene: result.scene, frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = source,
    sourceName = "app.tsx")

proc render(ui: Ui, canvas: Image = nil, cell: Image = nil): Image =
  let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
    hasImage: not canvas.isNil, image: canvas, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: cell, decodeTargetNodeId: 1.NodeId)
  ui.runtime.get(ui.owner, %*{}, context).asImage()

proc at(x, y: int, pointerType = "mouse"): JsonNode =
  %*{"x": x, "y": y, "pointerId": 0, "pointerType": pointerType}

const counter = """
let count = 0
export function get(app) {
  return (
    <div className="flex items-center justify-center bg-white">
      <div className={`w-20 h-10 ${count % 2 ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => { count++ }}>
        <span className="text-xs">{`${count}`}</span>
      </div>
    </div>
  )
}
"""

suite "jsx events":
  test "a tap on an element runs its onClick, and the next render shows it":
    let ui = newUi(counter, "tests/jsx-click")
    check ui.render()[100, 50] == rgbx(0xef, 0x44, 0x44, 255) # red: 0 taps
    check uiListens("tests/jsx-click", "tap")
    check not uiListens("tests/jsx-click", "pointerMove") # nothing hovers
    check not dispatchUiEvent("tests/jsx-click", "tap", at(10, 10)) # beside it
    check dispatchUiEvent("tests/jsx-click", "tap", at(100, 50))
    check ui.render()[100, 50] == rgbx(0x22, 0xc5, 0x5e, 255) # green: 1 tap
    # The span inside takes the tap to the element with the handler.
    check dispatchUiEvent("tests/jsx-click", "tap", at(72, 37))
    check ui.render()[100, 50] == rgbx(0xef, 0x44, 0x44, 255)

  test "a scene loaded again takes its taps to its new app":
    # Switched away and back: the scene and its app are new, the UI's target
    # is not. The tap must run the new app's handler, not the old one's.
    let before = newUi(counter, "tests/jsx-again")
    discard before.render()
    let again = newUi(counter, "tests/jsx-again")
    check again.render()[100, 50] == rgbx(0xef, 0x44, 0x44, 255)
    check dispatchUiEvent("tests/jsx-again", "tap", at(100, 50))
    check again.render()[100, 50] == rgbx(0x22, 0xc5, 0x5e, 255)
    # A scene torn down leaves no target behind.
    forgetUiTarget("tests/jsx-again", 1)
    check not uiListens("tests/jsx-again", "tap")
    check uiTarget("tests/jsx-again", 1, create = false).isNil

  test "the handler hears where, and can change the scene's state":
    let ui = newUi("""
      export const get = (app) => (
        <div className="p-10 bg-white">
          <div className="w-20 h-10 bg-black"
            onClick={(e) => frameos.setState('seen', `${e.type} ${e.x},${e.y} ${e.localX},${e.localY}`)} />
        </div>
      )
    """, "tests/jsx-detail")
    discard ui.render()
    check dispatchUiEvent("tests/jsx-detail", "tap", at(45, 47)) # the box is at 40,40
    check ui.scene.state{"seen"}.getStr() == "tap 45,47 5,7"

  test "hover: and active: follow the pointer; a finger leaves no hover":
    let ui = newUi("""
      export const get = () => (
        <div className="flex bg-white">
          <div className="w-20 h-20 bg-red-500 hover:bg-blue-500 active:bg-black" />
        </div>
      )
    """, "tests/jsx-hover")
    check ui.render()[10, 10] == rgbx(0xef, 0x44, 0x44, 255)
    check uiListens("tests/jsx-hover", "pointerMove")
    check dispatchUiEvent("tests/jsx-hover", "pointerMove", at(10, 10))
    check ui.render()[10, 10] == rgbx(0x3b, 0x82, 0xf6, 255) # hovered
    check not dispatchUiEvent("tests/jsx-hover", "pointerMove", at(12, 12)) # still over it
    check dispatchUiEvent("tests/jsx-hover", "pointerDown", at(12, 12))
    check ui.render()[10, 10] == rgbx(0, 0, 0, 255) # pressed
    check dispatchUiEvent("tests/jsx-hover", "pointerUp", at(12, 12))
    check ui.render()[10, 10] == rgbx(0x3b, 0x82, 0xf6, 255) # a mouse still over it
    check dispatchUiEvent("tests/jsx-hover", "pointerMove", at(150, 10))
    check ui.render()[10, 10] == rgbx(0xef, 0x44, 0x44, 255)
    check dispatchUiEvent("tests/jsx-hover", "pointerDown", at(10, 10, "touch"))
    check dispatchUiEvent("tests/jsx-hover", "pointerUp", at(10, 10, "touch"))
    check ui.render()[10, 10] == rgbx(0xef, 0x44, 0x44, 255)

  test "a hovered group lights its children's group-hover: classes":
    let ui = newUi("""
      export const get = () => (
        <div className="flex bg-white">
          <div className="group w-20 h-20 p-5 bg-white">
            <div className="w-10 h-10 bg-red-500 group-hover:bg-green-500" />
          </div>
        </div>
      )
    """, "tests/jsx-group")
    check ui.render()[30, 30] == rgbx(0xef, 0x44, 0x44, 255)
    check dispatchUiEvent("tests/jsx-group", "pointerMove", at(2, 2)) # the group's corner
    check ui.render()[30, 30] == rgbx(0x22, 0xc5, 0x5e, 255)

  test "a UI in a cell of the canvas is hit where it is drawn":
    let ui = newUi(counter, "tests/jsx-cell")
    let canvas = newImage(400, 300)
    # A split hands its cell over as the image to draw into, and offers it.
    discard ui.render(canvas.view(100, 50, 200, 100), canvas.view(100, 50, 200, 100))
    check not dispatchUiEvent("tests/jsx-cell", "tap", at(100, 50)) # the cell's corner, in canvas pixels
    check dispatchUiEvent("tests/jsx-cell", "tap", at(200, 100)) # the cell's middle
    discard ui.render(canvas.view(100, 50, 200, 100), canvas.view(100, 50, 200, 100))
    check canvas[200, 100] == rgbx(0x22, 0xc5, 0x5e, 255)

  test "a press is captured: a drag off a slider's end still moves it, until the release":
    let ui = newUi("""
      export const get = () => (
        <div className="p-10 bg-white">
          <div className="w-20 h-4 bg-black"
            onPointerDown={(e) => frameos.setState('level', e.localX)}
            onPointerMove={(e) => frameos.setState('level', e.localX)}
            onPointerUp={(e) => frameos.setState('up', `${e.localX},${e.localY}`)} />
          <div className="w-10 h-10 bg-red-500"
            onPointerMove={(e) => frameos.setState('over', `${e.localX},${e.localY}`)} />
        </div>
      )
    """, "tests/jsx-drag")
    discard ui.render() # the track at 40,40 (80x16), the box under it at 40,56 (40x40)
    check uiListens("tests/jsx-drag", "pointerMove")
    # No press: a move goes to the element under it, and only there.
    check not dispatchUiEvent("tests/jsx-drag", "pointerMove", at(150, 70))
    check dispatchUiEvent("tests/jsx-drag", "pointerMove", at(60, 70))
    check ui.scene.state{"over"}.getStr() == "20,14"
    check ui.scene.state{"level"}.isNil
    # A press on the track: it holds the pointer, through a render too.
    check dispatchUiEvent("tests/jsx-drag", "pointerDown", at(50, 48))
    check ui.scene.state{"level"}.getInt() == 10
    check dispatchUiEvent("tests/jsx-drag", "pointerMove", at(90, 48))
    check ui.scene.state{"level"}.getInt() == 50
    discard ui.render()
    # Past its end and over the box: still the track's, from its corner.
    check dispatchUiEvent("tests/jsx-drag", "pointerMove", at(150, 70))
    check ui.scene.state{"level"}.getInt() == 110
    check dispatchUiEvent("tests/jsx-drag", "pointerMove", at(60, 76))
    check ui.scene.state{"level"}.getInt() == 20
    check ui.scene.state{"over"}.getStr() == "20,14" # the box heard none of it
    # The release goes to the track too, wherever it lands, and ends it.
    check dispatchUiEvent("tests/jsx-drag", "pointerUp", at(10, 90))
    check ui.scene.state{"up"}.getStr() == "-30,50"
    check dispatchUiEvent("tests/jsx-drag", "pointerMove", at(60, 76))
    check ui.scene.state{"over"}.getStr() == "20,20"
    check ui.scene.state{"level"}.getInt() == 20

  test "two fingers hold two presses":
    let ui = newUi("""
      export const get = () => (
        <div className="flex gap-4 p-4 bg-white">
          <div className="w-10 h-10 bg-black" onPointerMove={(e) => frameos.setState('a', e.localX)} />
          <div className="w-10 h-10 bg-black" onPointerMove={(e) => frameos.setState('b', e.localX)} />
        </div>
      )
    """, "tests/jsx-two")
    discard ui.render() # a at 16,16, b at 72,16 (40x40 each)
    proc finger(x, y, id: int): JsonNode =
      %*{"x": x, "y": y, "pointerId": id, "pointerType": "touch", "buttons": 1}
    # A press on an element with no onPointerDown changes nothing to draw.
    check not dispatchUiEvent("tests/jsx-two", "pointerDown", finger(20, 20, 1))
    check not dispatchUiEvent("tests/jsx-two", "pointerDown", finger(80, 20, 2))
    check dispatchUiEvent("tests/jsx-two", "pointerMove", finger(100, 20, 1)) # over b: a's
    check dispatchUiEvent("tests/jsx-two", "pointerMove", finger(0, 20, 2))   # over a: b's
    check ui.scene.state{"a"}.getInt() == 84
    check ui.scene.state{"b"}.getInt() == -72
    discard dispatchUiEvent("tests/jsx-two", "pointerUp", finger(100, 20, 1))
    discard dispatchUiEvent("tests/jsx-two", "pointerUp", finger(0, 20, 2))
    check dispatchUiEvent("tests/jsx-two", "pointerMove", finger(20, 20, 1)) # no press: under it
    check ui.scene.state{"a"}.getInt() == 4

  test "a handler that throws is logged, and the frame goes on":
    let ui = newUi("""
      export const get = () => <div className="bg-white"><div className="w-10 h-10 bg-black" onClick={() => { throw new Error('nope') }} /></div>
    """, "tests/jsx-throw")
    discard ui.render()
    logged.setLen(0)
    check dispatchUiEvent("tests/jsx-throw", "tap", at(5, 5))
    var reported = false
    for line in logged:
      if "nope" in line: reported = true
    check reported
    discard ui.render()
