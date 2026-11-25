## The voice key's half on the frame (docs/voice-chat.md "Voice actions"):
## the screen digest a JSX UI gives its control plane (frameos/voice_screen.nim,
## ui/events.uiScreen over ui/layout.uiSpots) and the `uiAction` that comes
## back, run through the To-do sample's real app: what it lists (the fields,
## the buttons by their text, the icons by their `title`, each with the row
## it sits on), typing a to-do in and sending it, ticking one off by its
## circle.
##
## FRAMEOS_VOICE_SCREEN_DUMP=<dir> writes each digest there: the snapshots the
## planes' eval set (cloud/apps/auth-web/evals/voice-actions) is built on.

import std/[json, os, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/voice_screen
import frameos/ui/events
import frameos/ui/layout

const
  Repo = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".."
  TodoPath = Repo / "repo" / "scenes" / "samples" / "To-do" / "scenes.json"

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

proc newUi(source, id: string, width = 480, height = 640): Ui =
  let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp", device: "framebuffer")
  result.scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  result.owner = AppRoot(nodeId: 2.NodeId, nodeName: "ui", scene: result.scene, frameConfig: config)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = source,
    sourceName = "app.tsx")

proc render(ui: Ui): Image =
  let context = ExecutionContext(scene: ui.scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1, decodeTargetNodeId: 2.NodeId)
  ui.runtime.get(ui.owner, ui.scene.state, context).asImage()

proc screen(ui: Ui, name = ""): JsonNode =
  let text = voiceScreen(ui.scene, state = $ui.scene.state)
  let dump = getEnv("FRAMEOS_VOICE_SCREEN_DUMP")
  if dump.len > 0 and name.len > 0:
    createDir(dump)
    writeFile(dump / name & ".json", text)
  parseJson(text)

proc find(digest: JsonNode, key, value: string): JsonNode =
  for t in digest["t"]:
    if t{key}.getStr() == value:
      return t

proc findNear(digest: JsonNode, label, near: string): JsonNode =
  for t in digest["t"]:
    if t{"label"}.getStr() == label and t{"near"}.getStr() == near:
      return t

proc todoSource(): string =
  parseJson(readFile(TodoPath))[0]["apps"]["jsxUi"]["sources"]["app.tsx"].getStr()

suite "voice actions":
  test "the To-do's screen digest lists its fields, buttons and icons with their rows":
    let ui = newUi(todoSource(), "tests/voice-todo")
    discard ui.render()
    let digest = ui.screen("to-do")
    check digest["v"].getInt() == 1
    check digest["scene"].getStr() == "tests/voice-todo"
    check not digest.hasKey("kb")
    let add = digest.find("text", "Add")
    check not add.isNil and add["do"].getStr() == "tap"
    let draft = digest.find("label", "Add a to-do")
    check not draft.isNil and draft["do"].getStr() == "type"
    # A row's circle says what it does by its title, and which row by `near`.
    let tick = digest.findNear("Mark done", "Book the dentist")
    check not tick.isNil
    check not digest.findNear("Mark not done", "Water the plants").isNil
    check not digest.findNear("Delete", "Book the dentist").isNil
    # A row's own text field: its value is its text.
    check digest.find("text", "Fix the bike light")["do"].getStr() == "type"
    # Ids are node:key, what uiAction takes.
    check tick["id"].getStr().startsWith("2:")

  test "uiAction types into a field and sends it, ticks a row off, scrolls":
    let ui = newUi(todoSource(), "tests/voice-todo-act")
    discard ui.render()
    var digest = ui.screen()
    let draft = digest.find("label", "Add a to-do")
    check dispatchUiEvent("tests/voice-todo-act", "uiAction",
      %*{"target": draft["id"], "do": "type", "text": "Buy oat milk", "submit": true})
    discard ui.render()
    let todos = ui.scene.state["todos"]
    check todos[^1]["text"].getStr() == "Buy oat milk"
    check not todos[^1]["done"].getBool()
    # The keyboard went with the Enter: the field is done.
    digest = ui.screen("to-do-added")
    check not digest.hasKey("kb")
    let tick = digest.findNear("Mark done", "Book the dentist")
    check dispatchUiEvent("tests/voice-todo-act", "uiAction", %*{"target": tick["id"]})
    discard ui.render()
    var dentist: JsonNode
    for item in ui.scene.state["todos"]:
      if item["text"].getStr() == "Book the dentist": dentist = item
    check dentist["done"].getBool()
    # "set" replaces a field's text: a row renamed.
    digest = ui.screen()
    let bike = digest.find("text", "Fix the bike light")
    check dispatchUiEvent("tests/voice-todo-act", "uiAction",
      %*{"target": bike["id"], "do": "set", "text": "Fix the bike brakes"})
    discard ui.render()
    check ui.screen("to-do-keyboard").find("text", "Fix the bike brakes")["focus"].getBool()
    check ui.screen()["kb"].getBool() # typed into: the keyboard is up, as for a tap
    # A target that is gone does nothing.
    check not dispatchUiEvent("tests/voice-todo-act", "uiAction", %*{"target": "2:999999"})
    check not dispatchUiEvent("tests/voice-todo-act", "uiAction", %*{"target": "nonsense"})

  test "Voice memos: its memos, pages and Save are on the screen digest, and voiceMemo saves one":
    let dir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "build" / "voice-memos-assets"
    removeDir(dir)
    createDir(dir / "Voice memos")
    writeFile(dir / "Voice memos" / "2026-11-19 08.15.00.txt", "Call the plumber about the kitchen tap")
    writeFile(dir / "Voice memos" / "2026-11-20 18.40.12.txt", "Buy oat milk and coffee beans")
    let sample = parseJson(readFile(Repo / "repo" / "scenes" / "samples" / "Voice memos" / "scenes.json"))[0]
    let app = sample["apps"]["voiceMemos"]
    let config = FrameConfig(width: 800, height: 480, rotate: 0, scalingMode: "cover", debug: true,
      saveAssets: %*false, assetsPath: dir, device: "framebuffer", timeZone: "UTC")
    let scene = FrameScene(id: "tests/voice-memos".SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
    let ui = Ui(scene: scene,
      owner: AppRoot(nodeId: 2.NodeId, nodeName: "memos", appKeyword: "voiceMemos", scene: scene, frameConfig: config),
      runtime: newJsAppRuntime(category = "data", outputType = "image", source = app["sources"]["app.tsx"].getStr(),
        sourceName = "app.tsx", sources = app["sources"], assetGrant = agReadWrite))
    discard ui.render()
    let digest = ui.screen("voice-memos")
    var texts: seq[string]
    for t in digest["t"]:
      texts.add t{"text"}.getStr() & "|" & t{"label"}.getStr() & "|" & t{"near"}.getStr()
    checkpoint texts.join("\n")
    for r in uiTarget("tests/voice-memos", 2, create = false).regions:
      checkpoint $r.key & " field " & $r.field & " click " & $r.handlers[ueClick] & " at " & $r.y & " vis " & $r.visible
    check not digest.find("text", "Save").isNil
    var plumber = false
    for t in digest["t"]:
      if t{"do"}.getStr() == "tap" and "plumber" in t{"text"}.getStr(): plumber = true
    check plumber
    # What matched nothing comes as the scene's voiceMemo: a file in the folder.
    let context = ExecutionContext(scene: scene, event: "voiceMemo",
      payload: %*{"text": "Pick up the dry cleaning", "at": "2026-11-20T19:00:00Z"},
      hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    discard ui.runtime.run(ui.owner, %*{}, context, isEvent = true)
    var saved = ""
    for kind, path in walkDir(dir / "Voice memos"):
      if readFile(path).strip() == "Pick up the dry cleaning": saved = path
    check saved.len > 0
    discard ui.render()
    discard ui.screen("voice-memos-saved")
