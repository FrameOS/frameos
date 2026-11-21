## The keys on a frame (docs/jsx-ui.md "Keys"): a keyboard's Tab, Enter and
## Escape, and a frame's buttons as them (a reTerminal's arrows Tab and
## Shift+Tab, its green key Enter), walk the UI of the scene showing and of
## the layout it wears as one, with one ring; a scene that hears its buttons
## itself keeps them.

import std/[json, os, strutils, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../types
import ../ui/events as ui_events
import ../ui/layout

proc jsxScene(id, source: string, extra = "", events: seq[string] = @[]): JsonNode =
  let app = %*{"origin": "ui", "name": "ui", "category": "data", "version": "1.0.0", "fields": [],
    "output": [{"name": "image", "type": "image"}], "sources": {"app.tsx": source,
      "config.json": $(%*{"name": "ui", "category": "data", "output": [{"name": "image", "type": "image"}],
        "fields": [], "events": events})}}
  result = %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 3000,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {"ui": app},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "ui", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}
  if extra.len > 0:
    for key, value in parseJson(extra).pairs:
      result[key] = value

# Three rows to press, what was pressed in the scene's state.
const listUi = """
export function get(app) {
  const press = (name) => () => frameos.setState('pressed', name)
  return (
    <div className="flex flex-col gap-2 w-full h-full bg-black text-white">
      <div className="h-[40px]" onClick={press('a')}>A</div>
      <div className="h-[40px] flex gap-2" onClick={press('b')}><span>icon</span><span>B</span></div>
      <div className="h-[40px]" onClick={press('c')}>C</div>
    </div>
  )
}
"""

# A layout with a button of its own over the scene.
const chromeLayout = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[30px] bg-[#ff0000]" onClick={() => frameos.setState('menu', 'open')}>Start</div>
      <yield />
    </div>
  )
}
"""

# A layout that takes Tab itself (as the Commander desktop switches its panels),
# and leaves Enter alone.
const tabbingLayout = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[30px] bg-[#ff0000]" onClick={() => frameos.setState('menu', 'open')}>Start</div>
      <yield />
    </div>
  )
}
export function onEvent(app, context) {
  if (context.event === 'keyDown' && context.payload.key === 'Tab') {
    frameos.setState('tabs', (app.state.tabs || 0) + 1)
    return true
  }
  return false
}
"""

let scenes = %*[
  jsxScene("keys/list", listUi),
  jsxScene("keys/tabbing", tabbingLayout, """{"settings": {"execution": "interpreted", "refreshInterval": 600,
    "backgroundColor": "#000000", "isLayout": true}}""", @["keyDown"]),
  jsxScene("keys/tabbed", listUi, """{"layout": {"sceneId": "keys/tabbing"}}"""),
  jsxScene("keys/chrome", chromeLayout, """{"settings": {"execution": "interpreted", "refreshInterval": 600,
    "backgroundColor": "#000000", "isLayout": true}}"""),
  jsxScene("keys/listed", listUi, """{"layout": {"sceneId": "keys/chrome"}}"""),
  # A scene with its own button listener: its buttons are its own.
  jsxScene("keys/own", listUi, """{"nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "ui", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}},
      {"id": "4", "type": "event", "data": {"keyword": "button"}}]}""")]
setUploadedInterpretedScenes(parseInterpretedScenes($scenes))
resetInterpretedScenes()

const Size = (w: 480, h: 320)

proc configOf(): FrameConfig =
  FrameConfig(name: "keys", mode: "rpios", device: "framebuffer", width: Size.w, height: Size.h, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
    assetsPath: getTempDir() / "frameos-keys-test")

var problems: seq[string]

proc logger(config: FrameConfig): Logger =
  var l = Logger(frameConfig: config, enabled: true)
  l.log = proc(payload: JsonNode) =
    {.cast(gcsafe).}:
      if payload{"event"}.getStr().contains("error"):
        problems.add($payload)
  l.enable = proc() = l.enabled = true
  l.disable = proc() = l.enabled = false
  l

var clock = 1000.0

proc pass(scene: FrameScene): Image =
  clock += 0.01
  rhythmClockOverride = clock
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: newImage(Size.w, Size.h), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  render(scene, context)

let shots = getEnv("FRAMEOS_KEYS_SHOTS")
proc shot(image: Image, name: string) =
  if shots.len > 0:
    createDir(shots)
    image.writeFile(shots / name & ".png")

proc settle(): seq[string] =
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok: break
    result.add message[1]

proc send(scene: FrameScene, event: string, payload: JsonNode): seq[string] =
  runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0, loopKey: ".",
    nextSleep: -1))
  settle()

proc button(scene: FrameScene, role: string, action = "press"): seq[string] =
  scene.send("button", %*{"label": role.toUpperAscii, "role": role, "action": action, "pin": 1})

proc ringedText(sceneId: string): int =
  ## Which row is ringed in the scene's UI (node 2): 1, 2, 3; 0 for none.
  let target = uiTarget(sceneId, 2, create = false)
  if target.isNil or target.input.ring == 0:
    return 0
  var row = 0
  for r in target.regions:
    if r.handlers[ueClick] > 0:
      inc row
      if r.key == target.input.ring - 1:
        return row
  -1

suite "the keys on a frame":
  setup:
    forgetTypedKeys()
    problems.setLen(0)

  test "a frame's buttons walk the rows, the green key presses, every tap counts":
    let config = configOf()
    let scene = init("keys/list".SceneId, config, logger(config), %*{})
    discard pass(scene)
    check sceneListensTo(scene, "button")
    check "render" in scene.button("next")
    check ringedText("keys/list") == 1
    discard scene.button("next", "doublePress")
    check ringedText("keys/list") == 3
    discard scene.button("next")
    check ringedText("keys/list") == 1 # around
    discard scene.button("prev")
    check ringedText("keys/list") == 3
    discard scene.button("prev")
    check ringedText("keys/list") == 2 # a row whose icon and name are inside it: one stop
    discard scene.button("refresh")
    check scene.state{"pressed"}.getStr() == "b"
    # Held, a button is the frame's event map's: no key.
    discard scene.button("next", "longPress")
    check ringedText("keys/list") == 2
    pass(scene).shot("list-ringed")
    check ringedText("keys/list") == 2 # the ring lasts through a render
    discard scene.button("back")
    check ringedText("keys/list") == 0
    check problems.len == 0

  test "a keyboard's Tab, Shift+Tab, Enter and Escape":
    let config = configOf()
    let scene = init("keys/list".SceneId, config, logger(config), %*{})
    discard pass(scene)
    discard scene.send("keyDown", %*{"key": "Tab", "code": "Tab"})
    discard scene.send("keyDown", %*{"key": "Tab", "code": "Tab", "shift": true})
    check ringedText("keys/list") == 3
    discard scene.send("keyDown", %*{"key": "Enter", "code": "Enter"})
    check scene.state{"pressed"}.getStr() == "c"
    discard scene.send("keyDown", %*{"key": "Escape", "code": "Escape"})
    check ringedText("keys/list") == 0

  test "the scene and the layout it wears are one walk, with one ring":
    let config = configOf()
    let scene = init("keys/listed".SceneId, config, logger(config), %*{})
    discard pass(scene)
    let layout = scene.wornLayout
    check not layout.isNil
    for _ in 1 .. 3:
      discard scene.button("next")
    check ringedText("keys/listed") == 3
    discard scene.button("next")
    check ringedText("keys/listed") == 0 # on to the layout's Start
    check uiTarget("keys/chrome", 2).input.ring > 0
    pass(scene).shot("layout-ringed")
    discard scene.button("refresh")
    check layout.state{"menu"}.getStr() == "open"
    check scene.state{"pressed"}.getStr() == ""
    discard scene.button("next")
    check ringedText("keys/listed") == 1 and uiTarget("keys/chrome", 2).input.ring == 0
    check problems.len == 0

  test "a scene that hears its buttons itself keeps them":
    let config = configOf()
    let scene = init("keys/own".SceneId, config, logger(config), %*{})
    discard pass(scene)
    discard scene.button("next")
    check ringedText("keys/own") == 0
    # A keyboard's Tab still walks it: the keys are not its buttons.
    discard scene.send("keyDown", %*{"key": "Tab", "code": "Tab"})
    check ringedText("keys/own") == 1

  test "a layout's own code that takes a key keeps it; one it leaves is the keys'":
    let config = configOf()
    let scene = init("keys/tabbed".SceneId, config, logger(config), %*{})
    discard pass(scene)
    let layout = scene.wornLayout
    discard scene.send("keyDown", %*{"key": "Tab", "code": "Tab"})
    check layout.state{"tabs"}.getInt() == 1
    check ringedText("keys/tabbed") == 0
    # The frame's buttons are not its keys: they walk.
    discard scene.button("next")
    check ringedText("keys/tabbed") == 1
    discard scene.send("keyDown", %*{"key": "Enter", "code": "Enter"})
    check scene.state{"pressed"}.getStr() == "a"
    check problems.len == 0
