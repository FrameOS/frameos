import std/[json, os, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/ui/events
import frameos/ui/layout
import frameos/ui/keyboard
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

proc newUi(source: string, id: string, width = 200, height = 100): Ui =
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
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

  test "a render only the pointer asked for lays the last tree out again":
    # hover: changed and no handler ran: the new picture without get(), as
    # CSS restyles :hover. A handler, any other event, or the scene's own
    # interval coming round runs get() again.
    let ui = newUi("""
      let gets = 0
      export function get(app) {
        gets++
        frameos.setState('gets', gets)
        return (
          <div className="flex p-10 bg-white">
            <div className="w-20 h-10 bg-red-500 hover:bg-green-500" onClick={() => {}} />
          </div>
        )
      }
    """, "tests/jsx-input-only")
    ui.scene.refreshInterval = 3600
    let red = rgbx(0xef, 0x44, 0x44, 255)
    let green = rgbx(0x22, 0xc5, 0x5e, 255)
    check ui.render()[50, 50] == red
    check ui.scene.state{"gets"}.getInt() == 1
    check dispatchUiEvent("tests/jsx-input-only", "pointerMove", at(50, 50))
    check ui.render()[50, 50] == green
    check ui.scene.state{"gets"}.getInt() == 1 # the hover alone: no get()
    check dispatchUiEvent("tests/jsx-input-only", "tap", at(50, 50))
    discard ui.render()
    check ui.scene.state{"gets"}.getInt() == 2 # a handler ran
    check dispatchUiEvent("tests/jsx-input-only", "pointerMove", at(5, 5))
    uiSceneEvent("tests/jsx-input-only") # a state change, a button, ...
    check ui.render()[50, 50] == red
    check ui.scene.state{"gets"}.getInt() == 3
    ui.scene.refreshInterval = 0.001 # the scene's own render is due
    check dispatchUiEvent("tests/jsx-input-only", "pointerMove", at(50, 50))
    sleep(5)
    check ui.render()[50, 50] == green
    check ui.scene.state{"gets"}.getInt() == 4

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

  test "a handler hears its element's size, so a slider needs no width of its own":
    let ui = newUi("""
      const put = (e) => frameos.setState('at', `${e.localX}/${e.width} ${e.localY}/${e.height}`)
      export const get = () => (
        <div className="flex p-10 bg-white">
          <div className="flex-1 h-4 bg-black" onPointerDown={put} onPointerMove={put} />
        </div>
      )
    """, "tests/jsx-size")
    discard ui.render() # a 200x100 frame: the track fills 120 of it, at 40,40
    check dispatchUiEvent("tests/jsx-size", "pointerDown", at(55, 42))
    check ui.scene.state{"at"}.getStr() == "15/120 2/16"
    # Captured, past its end: the size stays the element's.
    check dispatchUiEvent("tests/jsx-size", "pointerMove", at(250, 70))
    check ui.scene.state{"at"}.getStr() == "210/120 30/16"

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

  test "a swipe goes to the element it began on, with its direction":
    let ui = newUi("""
      export const get = () => (
        <div className="flex bg-white">
          <div className="w-[100px] h-[100px]" onSwipe={(e) => frameos.setState('a', e.direction)} />
          <div className="w-[100px] h-[100px]" onSwipe={(e) => frameos.setState('b', e.direction)} />
        </div>
      )
    """, "tests/jsx-swipe")
    discard ui.render()
    check uiListens("tests/jsx-swipe", "swipe")
    # Down on the first, up over the second: the first one's swipe.
    check dispatchUiEvent("tests/jsx-swipe", "swipe", %*{"x": 160, "y": 50, "startX": 20, "startY": 50,
      "direction": "right", "pointerId": 1, "pointerType": "touch"})
    check ui.scene.state{"a"}.getStr() == "right"
    check ui.scene.state{"b"}.isNil
    check dispatchUiEvent("tests/jsx-swipe", "swipe", %*{"x": 120, "y": 10, "startX": 130, "startY": 90,
      "direction": "up", "pointerId": 1, "pointerType": "touch"})
    check ui.scene.state{"b"}.getStr() == "up"
    # Begun below both: nobody's.
    check not dispatchUiEvent("tests/jsx-swipe", "swipe", %*{"x": 120, "y": 10, "startX": 50, "startY": 150,
      "direction": "left", "pointerId": 1, "pointerType": "touch"})

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

const form = """
let name = 'Ann'
let picked = -1
const rows = Array.from({ length: 12 }, (_, i) => i)
export function get(app) {
  return (
    <div className="flex flex-col h-full bg-white">
      <input className="h-10 px-2 shrink-0 bg-slate-100 text-black focus:bg-sky-100" value={name}
        onChange={(e) => { name = e.target.value; frameos.setState('name', name) }}
        onKeyDown={(e) => frameos.setState('key', e.key)} />
      <div className="flex-1 overflow-y-auto">
        {rows.map((i) => <div className={`h-10 ${i % 2 ? 'bg-green-500' : 'bg-red-500'}`}
          onClick={() => frameos.setState('picked', i)} />)}
      </div>
    </div>
  )
}
"""

proc keyAt(id: string, code: int): JsonNode =
  ## A tap on the on-screen key that types `code` (or does what it stands for).
  let target = uiTarget(id, 1, create = false)
  for r in target.regions:
    if r.handlers[ueClick] == KeyBase + code + 1:
      return %*{"x": r.x + r.w / 2 + target.offsetX, "y": r.y + r.h / 2 + target.offsetY,
        "pointerId": 0, "pointerType": "touch"}
  raise newException(ValueError, "no key " & $code)

suite "jsx fields":
  test "a tap on a field brings up the keyboard, and its keys type into it":
    forgetTypedKeys()
    let id = "tests/jsx-field"
    let ui = newUi(form, id, 320, 240)
    discard ui.render()
    check uiListens(id, "tap")
    check dispatchUiEvent(id, "tap", at(160, 20, "touch"))
    let target = uiTarget(id, 1, create = false)
    check target.input.focus > 0 and target.input.keyboard
    var image = ui.render()
    check image[160, 20] == rgbx(0xe0, 0xf2, 0xfe, 255) # focus:bg-sky-100
    check image[2, 236] == rgbx(0x18, 0x18, 0x1b, 255)   # the keyboard, zinc-900
    check dispatchUiEvent(id, "tap", keyAt(id, ord('x')))
    check ui.scene.state{"name"}.getStr() == "Annx"
    check ui.scene.state{"key"}.getStr() == "x"
    discard ui.render()
    check dispatchUiEvent(id, "tap", keyAt(id, ord(kBackspace)))
    check ui.scene.state{"name"}.getStr() == "Ann"
    check ui.scene.state{"key"}.getStr() == "Backspace"
    discard ui.render()
    check dispatchUiEvent(id, "tap", keyAt(id, ord(kShift)))
    discard ui.render()
    check dispatchUiEvent(id, "tap", keyAt(id, ord('b')))
    check dispatchUiEvent(id, "tap", keyAt(id, ord('c'))) # shift was for one letter
    check ui.scene.state{"name"}.getStr() == "AnnBc"
    discard ui.render()
    check dispatchUiEvent(id, "tap", keyAt(id, ord(kSymbols)))
    discard ui.render()
    check dispatchUiEvent(id, "tap", keyAt(id, ord('7')))
    check ui.scene.state{"name"}.getStr() == "AnnBc7"
    discard ui.render()
    # A tap between the keys keeps the keyboard; Enter puts it away.
    let kb = keyboardHeight(240)
    check not dispatchUiEvent(id, "tap", at(1, 240 - kb + 1, "touch")) or target.input.keyboard
    check target.input.keyboard
    check dispatchUiEvent(id, "tap", keyAt(id, ord(kEnter)))
    check ui.scene.state{"key"}.getStr() == "Enter"
    check target.input.focus == 0 and not target.input.keyboard
    image = ui.render()
    check image[2, 236] != rgbx(0x18, 0x18, 0x1b, 255)

  test "the caret goes where the tap landed; a tap elsewhere ends the edit":
    forgetTypedKeys()
    let id = "tests/jsx-caret"
    let ui = newUi(form, id, 320, 240)
    discard ui.render()
    check dispatchUiEvent(id, "tap", at(9, 20, "touch")) # before the A
    discard ui.render()
    check uiTarget(id, 1, create = false).input.caret == 0
    check dispatchUiEvent(id, "tap", keyAt(id, ord('z')))
    check ui.scene.state{"name"}.getStr() == "zAnn"
    discard ui.render()
    check dispatchUiEvent(id, "tap", at(160, 60, "touch")) # a row: the field lets go
    check ui.scene.state{"picked"}.getInt(-1) == 0
    check uiTarget(id, 1, create = false).input.focus == 0

  test "a keyboard types into the field; no keyboard on the screen then":
    forgetTypedKeys()
    let id = "tests/jsx-typed"
    let ui = newUi(form, id, 320, 240)
    discard ui.render()
    check dispatchUiEvent(id, "tap", at(160, 20, "touch"))
    discard ui.render()
    let target = uiTarget(id, 1, create = false)
    check uiListens(id, "textInput") and uiListens(id, "keyDown")
    check dispatchUiEvent(id, "keyDown", %*{"key": "!", "code": "Digit1"})
    check dispatchUiEvent(id, "textInput", %*{"text": "!"})
    check ui.scene.state{"name"}.getStr() == "Ann!"
    check not target.input.keyboard
    discard ui.render()
    check dispatchUiEvent(id, "keyDown", %*{"key": "Home", "code": "Home"})
    check dispatchUiEvent(id, "keyDown", %*{"key": "Delete", "code": "Delete"})
    check ui.scene.state{"name"}.getStr() == "nn!"
    discard ui.render()
    check dispatchUiEvent(id, "keyDown", %*{"key": "Escape", "code": "Escape"})
    check target.input.focus == 0
    check not uiListens(id, "keyDown")
    forgetTypedKeys()

  test "a list scrolls under a finger; a tap after it hits what shows":
    let id = "tests/jsx-scroll"
    let ui = newUi(form, id, 320, 240)
    discard ui.render()
    check uiListens(id, "pointerDown") and uiListens(id, "pointerMove")
    # The rows start at y 40, 40 px each: a press on row 1, dragged up 60 px.
    check not dispatchUiEvent(id, "pointerDown", at(160, 100, "touch"))
    check not dispatchUiEvent(id, "pointerMove", at(160, 92, "touch")) # within the tap slop
    check dispatchUiEvent(id, "pointerMove", at(160, 40, "touch"))
    check dispatchUiEvent(id, "pointerUp", at(160, 40, "touch"))
    let target = uiTarget(id, 1, create = false)
    var scrolledBy = 0'f32
    for (_, _, y) in target.input.scrolls:
      scrolledBy = max(scrolledBy, y)
    check scrolledBy > 40 and scrolledBy < 70
    let image = ui.render()
    # The swipe the drag ends with is the list's, not a handler's.
    check not dispatchUiEvent(id, "swipe", %*{"x": 160, "y": 40, "startX": 160, "startY": 100,
      "direction": "up", "pointerId": 0, "pointerType": "touch"})
    # y 45 is content y 45 - 40 + the scroll: row 1 now, not row 0.
    check dispatchUiEvent(id, "tap", at(160, 45, "touch"))
    check ui.scene.state{"picked"}.getInt(-1) == 1
    check image[160, 45] == rgbx(0x22, 0xc5, 0x5e, 255) # row 1 is green
