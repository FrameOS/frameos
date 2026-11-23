## The Code editor sample (repo/scenes/samples/Code editor, docs/code-editor.md):
## its own tests (app.test.tsx) in its interpreter, the bridge it stands on
## (`frameos.code`: refused without the "code" permission and without a host,
## the hooks reached with both), and the scene itself drawn and tapped through
## its UI. FRAMEOS_CODE_EDITOR_SHOTS=<dir> writes what it drew.

import std/[json, os, strutils, unittest]
import pixie
import frameos/channels
import frameos/interpreter
import frameos/scene_code_hooks
import frameos/scene_code_preview
import frameos/scene_rhythm
import frameos/types
import frameos/js_runtime/app_runtime
import frameos/js_runtime/app_tests
import frameos/ui/events
import frameos/ui/layout
import frameos/values

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let sample = parseFile(Samples / "Code editor" / "scenes.json")[0]

# The host as a frame would hand it over, and what reached it.
var
  offered = true
  draft = ""
  asked: seq[(string, JsonNode)]

let held = %*{"id": "clock", "name": "Clock", "settings": {"execution": "interpreted"}, "fields": [],
  "nodes": [{"id": "c1", "type": "code", "data": {"codeJS": "return 42"}}], "edges": []}

proc longCode(): string =
  ## 2,000 lines of an app: what the editor holds a window of.
  for i in 1 .. 2000:
    if i > 1: result.add '\n'
    result.add "  const line" & $i & " = fetch('/api/" & $i & "') // line " & $i

let long = %*{"id": "long", "name": "Long", "settings": {"execution": "interpreted"}, "fields": [],
  "nodes": [], "edges": [], "apps": {"face": {"name": "Face", "sources": {"app.tsx": longCode()}}}}

proc wordyCode(): string =
  ## 400 lines, every other one about 60 characters: on a 480 px screen one
  ## the field sets on one row, and a guess from its length puts on two.
  for i in 1 .. 400:
    if i > 1: result.add '\n'
    result.add(if i mod 2 == 0: "  const total" & $i & " = compute(" & $i & ", 'some words here') // line " & $i
      else: "  return line" & $i)

let wordy = %*{"id": "wordy", "name": "Wordy", "settings": {"execution": "interpreted"}, "fields": [],
  "nodes": [], "edges": [], "apps": {"face": {"name": "Face", "sources": {"app.tsx": wordyCode()}}}}

proc host(asker, op, arg: string): string {.nimcall, gcsafe, raises: [].} =
  ## A host as scene_code_hooks.nim says one answers.
  {.cast(gcsafe).}:
    if not offered:
      return if op == "read": "" else: SettingsOffCode
    case op
    of "read": $(%*{"busy": "", "error": "", "done": "", "draft": nil, "ask": true, "save": true})
    of "source": (if arg == "clock": $held elif arg == "long": $long elif arg == "wordy": $wordy else: "")
    of "draft": draft
    else:
      try: asked.add (op, parseJson(arg))
      except CatchableError: asked.add (op, newJNull())
      "true"

proc reset() =
  offered = true
  draft = ""
  asked = @[]
  sceneCode = host

proc testConfig(width = 800, height = 480): FrameConfig =
  FrameConfig(name: "code", mode: "rpios", device: "framebuffer", width: width, height: height, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
    timeZone: "UTC", assetsPath: getTempDir())

var logger = Logger(frameConfig: nil, enabled: true)
var problems: seq[string]
logger.log = proc(payload: JsonNode) =
  if payload{"level"}.getStr() == "error" or payload{"event"}.getStr().contains("error"):
    problems.add($payload)
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

suite "the Code editor sample":
  setup:
    reset()

  test "its own tests pass in its interpreter":
    let sources = sample["apps"]["codeEditor"]["sources"]
    check appTestFiles(sources) == @["app.test.tsx"]
    for testFile in appTestFiles(sources):
      let report = runJsAppTests(sources, testFile, testConfig())
      if not report["ok"].getBool():
        checkpoint($report)
      check report["ok"].getBool()
      check report["counts"]["total"].getInt() >= 16

  test "it asks for the code and the frame's folders, and for nothing else":
    let config = parseJson(sample["apps"]["codeEditor"]["sources"]["config.json"].getStr())
    check config["permissions"] == %*["code", "assets", "assets-write"]
    check codeGrantFromConfig(config)
    check not frameGrantFromConfig(config)
    check assetGrantFromConfig(config) == agReadWrite

suite "frameos.code":
  setup:
    reset()

  let config = testConfig(6, 4)
  logger.frameConfig = config
  let scene = FrameScene(id: "tests/code".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 3.NodeId, nodeName: "bridge", scene: scene, frameConfig: config)
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)

  proc call(permissions: JsonNode, expression: string): JsonNode =
    let runtime = newJsAppRuntime(category = "data", outputType = "json",
      source = "export function get() { try { const value = " & expression & "; " &
        "return { ok: true, value: value === undefined ? null : value } } " &
        "catch (e) { return { ok: false, error: String(e.message) } } }")
    runtime.codeGrant = codeGrantFromConfig(%*{"permissions": permissions})
    runtime.get(owner, %*{}, context).asJson()

  test "is refused to an app whose permissions do not ask for code":
    for permissions in [%*[], %*["frame", "assets-write"], %*"code", newJNull()]:
      let answer = call(permissions, "frameos.code('source', 'clock')")
      check not answer["ok"].getBool()
      check answer["error"].getStr() == "frameos.code: this app's permissions do not include code"
    check asked.len == 0

  test "reads the facts and the scenes, and hands the host its actions":
    let facts = call(%*["code"], "frameos.code('read')")
    check facts["value"]["ask"].getBool()
    check call(%*["code"], "frameos.code('source', 'clock')")["value"]["nodes"][0]["data"]["codeJS"].getStr() == "return 42"
    check call(%*["code"], "frameos.code('source', 'gone')")["value"].kind == JNull
    check call(%*["code"], "frameos.code('draft')")["value"].kind == JNull
    draft = """{"id": "new", "name": "New"}"""
    check call(%*["code"], "frameos.code('draft')")["value"]["name"].getStr() == "New"
    check call(%*["code"], "frameos.code('ask', { prompt: 'A clock', scene: { id: 'clock' } })")["value"].getBool()
    check call(%*["code"], "frameos.code('save', { scene: { id: 'clock' }, show: false })")["value"].getBool()
    check call(%*["code"], "frameos.code('clear')")["value"].getBool()
    check asked.len == 3 # the bridge hands the host what the app asked, the host decides
    # The action rides in the arguments: the request body as the plane takes it.
    check asked[0] == ("ask", %*{"prompt": "A clock", "scene": {"id": "clock"}, "action": "ask"})
    check asked[1] == ("save", %*{"scene": {"id": "clock"}, "show": false, "action": "save"})
    check asked[2][0] == "clear"
    check call(%*["code"], "frameos.code('format')")["value"].getBool()
    check asked[3][0] == "format"

  test "reads and changes nothing while the frame's settings are off its screen":
    offered = false
    check call(%*["code"], "frameos.code('read')")["value"].kind == JNull
    for expression in ["frameos.code('source', 'clock')", "frameos.code('save', { scene: { id: 'x' } })"]:
      check call(%*["code"], expression)["error"].getStr() == "frameos.code: settings on the frame's screen are off"
    check asked.len == 0

  test "frameos.measureText sets texts as a field of that width would":
    let heights = call(%*[], "frameos.measureText(['a', 'word '.repeat(60), ''], " &
      "{ className: 'text-[13px] leading-[19px]', width: 200 })")["value"]
    check heights.len == 3
    check heights[0].getInt() == 19 and heights[2].getInt() == 19
    check heights[1].getInt() > 3 * 19 and heights[1].getInt() mod 19 == 0
    check call(%*[], "frameos.measureText([], { width: 200 })")["value"].len == 0

  test "is null where no host reads code":
    sceneCode = nil
    check call(%*["code"], "frameos.code('read')")["value"].kind == JNull
    check call(%*["code"], "frameos.code('ask', { prompt: 'x' })")["value"].kind == JNull

  test "the browser preview's host reads the page's scenes, and saves and asks nothing":
    codePreviewLoaded($(%*[held]))
    enableCodePreview()
    check call(%*["code"], "frameos.code('read')")["value"]["previewOnly"].getBool()
    check call(%*["code"], "frameos.code('source', 'clock')")["value"]["name"].getStr() == "Clock"
    check call(%*["code"], "frameos.code('source', 'gone')")["value"].kind == JNull
    check call(%*["code"], "frameos.code('draft')")["value"].kind == JNull
    check call(%*["code"], "frameos.code('save', { scene: { id: 'x' } })")["value"].getBool()

suite "the Code editor scene":
  setup:
    reset()
    problems = @[]
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_CODE_EDITOR_SHOTS")
    if dir.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig, state = %*{}): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[sample])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("code-editor".SceneId, config, logger, state)

  test "draws the scene it was opened on as files":
    let config = testConfig()
    let scene = load(config)
    discard draw(scene, config, "list")
    # The scene settings' Code button: the editor's public field `open`.
    scene.state["open"] = %"clock"
    let image = draw(scene, config, "clock")
    check image.width == 800 and image.height == 480
    check scene.state["open"].getStr() == ""
    check problems.len == 0
    if problems.len > 0: echo problems

  test "opens a folder of the assets, and a file typed into is saved to it":
    # The asset calls for real: a folder on disk, a file in it opened from
    # the explorer's spot, typed into and saved (the tab bar's Save).
    let root = getTempDir() / "code-editor-folder"
    removeDir(root)
    createDir(root / "notes")
    writeFile(root / "notes" / "todo.txt", "milk\neggs")
    let config = testConfig()
    let scene = load(config, %*{"spot": {"view": "code", "folder": {"storage": "assets", "path": "code-editor-folder"},
      "file": "notes/todo.txt", "expanded": ["notes"]}})
    discard draw(scene, config, "folder-open")
    discard draw(scene, config, "folder")
    scene.send("tap", %*{"x": 600, "y": 70, "pointerId": 0, "pointerType": "touch"})
    discard draw(scene, config, "folder-focused")
    scene.send("textInput", %*{"text": " and bread"})
    discard draw(scene, config, "folder-typed")
    scene.send("tap", %*{"x": 768, "y": 18, "pointerId": 0, "pointerType": "touch"})
    discard draw(scene, config, "folder-saved")
    let saved = readFile(root / "notes" / "todo.txt")
    check "and bread" in saved and "eggs" in saved and saved != "milk\neggs"
    check problems.len == 0
    if problems.len > 0: echo problems
    removeDir(root)

  test "draws a narrow portrait screen and e-paper":
    for (width, height) in [(480, 800), (296, 128)]:
      let config = testConfig(width, height)
      let scene = load(config)
      scene.state["open"] = %"clock"
      discard draw(scene, config, "small")
    check problems.len == 0
    if problems.len > 0: echo problems

  test "scrolls a long file, colored, and types where it is tapped":
    let config = testConfig()
    let scene = load(config, %*{"spot": {"view": "code", "id": "long", "file": "face/app.tsx"}})
    proc drawn(name: string): Image = draw(scene, config, name)
    proc blue(image: Image): int =
      ## Pixels in the keywords' blue (#569cd6), anti-aliased edges aside.
      for y in 0 ..< image.height:
        for x in 0 ..< image.width:
          let c = image[x, y]
          if abs(c.r.int - 0x56) < 12 and abs(c.g.int - 0x9c) < 12 and abs(c.b.int - 0xd6) < 12: inc result
    discard drawn("long-open")
    let top = drawn("long-top")
    check top.blue > 200
    # A finger drags the code up a screen and more.
    scene.send("pointerDown", %*{"x": 600, "y": 400, "pointerId": 1, "pointerType": "touch", "buttons": 1})
    for y in countdown(380, 60, 40):
      scene.send("pointerMove", %*{"x": 600, "y": y, "pointerId": 1, "pointerType": "touch", "buttons": 1})
      discard drawn("long-drag")
    scene.send("pointerUp", %*{"x": 600, "y": 60, "pointerId": 1, "pointerType": "touch"})
    let scrolled = drawn("long-scrolled")
    check scrolled.blue > 200
    # A tap on a line, then typing: into that line.
    scene.send("tap", %*{"x": 420, "y": 200, "pointerId": 0, "pointerType": "touch"})
    discard drawn("long-focused")
    scene.send("textInput", %*{"text": "typed()"})
    discard drawn("long-typed")
    # Save (the tab bar's last button): the whole file, with what was typed.
    scene.send("tap", %*{"x": 768, "y": 18, "pointerId": 0, "pointerType": "touch"})
    check asked.len == 1 and asked[0][0] == "save"
    let text = asked[0][1]{"scene", "apps", "face", "sources", "app.tsx"}.getStr()
    check text.count('\n') == 1999 and text.contains("typed()") and text != longCode()
    check problems.len == 0
    if problems.len > 0: echo problems

  test "stays where it is typed into on a small screen, wrapped lines and all":
    # A 400-line file on a 480x320 screen, scrolled to about line 200 and
    # typed into: the box stays where it was and the caret on its line. The
    # lines above the screen were guessed, then measured, and the box scrolled
    # by the difference once; an edit is no reason to do that again.
    forgetTypedKeys() # the test before typed on a keyboard: this one starts on the screen's
    let config = testConfig(480, 320)
    let scene = load(config, %*{"spot": {"view": "code", "id": "wordy", "file": "face/app.tsx"}})
    discard draw(scene, config, "wordy-open")
    discard draw(scene, config, "wordy-top")
    var ui: UiTarget
    for node in 0 .. 64:
      ui = uiTarget("code-editor", node, create = false)
      if not ui.isNil: break
    require not ui.isNil
    proc box(): UiRegion =
      ## The file's box that scrolls: of those with an onScroll, the one that goes furthest.
      for r in ui.regions:
        if r.handlers[ueScroll] > 0 and r.scrollY > result.scrollY: result = r
    proc top(): float32 = ui.input.scrolled(box().key)[1]
    proc caretLine(): string =
      ## The line the caret is on, as the field holds it.
      let
        text = ui.input.text
        at = clamp(ui.input.caret, 0, text.len)
        a = (if at > 0: text.rfind('\n', last = at - 1) + 1 else: 0)
        z = text.find('\n', at)
      text[a ..< (if z < 0: text.len else: z)]
    check box().scrollY > 380 * 19.0
    for _ in 0 ..< 26:
      scene.send("wheel", %*{"x": 300, "y": 160, "deltaX": 0, "deltaY": 2})
      discard draw(scene, config, "wordy-wheel")
    let scrolled = top()
    check scrolled > 150 * 19.0 and scrolled < 260 * 19.0
    # A tap on a line in the middle of the screen, then typing into it: on
    # the screen's keyboard (its Q key, bottom left of the line), then on a
    # keyboard of its own.
    scene.send("tap", %*{"x": 300, "y": 150, "pointerId": 0, "pointerType": "touch"})
    discard draw(scene, config, "wordy-focused")
    let line = caretLine().strip()
    let at = top()
    check "line" in line
    check ui.input.keyboard
    for i in 1 .. 3:
      scene.send("tap", %*{"x": 22, "y": 200, "pointerId": 0, "pointerType": "touch"})
      discard draw(scene, config, "wordy-keyed")
      checkpoint("key " & $i & ": the box at " & $top() & ", was " & $at & "; the caret on: " & caretLine())
      check top() == at
      check line in caretLine()
    check caretLine().endsWith("qqq")
    for i in 1 .. 6:
      scene.send("textInput", %*{"text": "x"})
      discard draw(scene, config, "wordy-typed")
      checkpoint("edit " & $i & ": the box at " & $top() & ", was " & $at & "; the caret on: " & caretLine())
      check top() == at
      check line in caretLine()
    # And a line added (Enter) at the caret: still put.
    scene.send("keyDown", %*{"key": "Enter"})
    discard draw(scene, config, "wordy-enter")
    check top() == at
    check problems.len == 0
    if problems.len > 0: echo problems
