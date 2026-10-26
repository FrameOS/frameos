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

  test "memo(Component) runs a card again only when its props changed":
    # Three cards, memo()'d: a render with nothing changed calls none of them,
    # a tap that switches one calls that one, and the taps still reach the
    # handlers of the cards taken back (their functions in this render's list).
    let ui = newUi("""
      const on = [false, false, false]
      let calls = 0
      const Card = memo(({ i, lit }) => {
        calls++
        return <div className={`w-10 h-10 ${lit ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => { on[i] = !on[i] }} />
      })
      export function get(app) {
        const tree = (
          <div className="flex gap-5 p-5 bg-white">
            {on.map((lit, i) => <Card i={i} lit={lit} />)}
          </div>
        )
        frameos.setState('calls', calls)
        return tree
      }
    """, "tests/jsx-memo")
    let red = rgbx(0xef, 0x44, 0x44, 255)
    let green = rgbx(0x22, 0xc5, 0x5e, 255)
    var image = ui.render()
    check ui.scene.state{"calls"}.getInt() == 3
    check image[25, 25] == red and image[85, 25] == red and image[145, 25] == red
    discard ui.render()
    check ui.scene.state{"calls"}.getInt() == 3 # nothing changed: no card ran
    check dispatchUiEvent("tests/jsx-memo", "tap", at(85, 25)) # the second card
    image = ui.render()
    check ui.scene.state{"calls"}.getInt() == 4 # that card alone
    check image[25, 25] == red and image[85, 25] == green and image[145, 25] == red
    # The first card was taken back twice: its tap still runs its handler.
    check dispatchUiEvent("tests/jsx-memo", "tap", at(25, 25))
    image = ui.render()
    check ui.scene.state{"calls"}.getInt() == 5
    check image[25, 25] == green and image[85, 25] == green and image[145, 25] == red

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
