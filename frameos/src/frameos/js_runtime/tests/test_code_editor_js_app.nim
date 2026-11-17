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
import frameos/scene_rhythm
import frameos/types
import frameos/js_runtime/app_runtime
import frameos/js_runtime/app_tests
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

proc read(asker: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if offered:
      result = $(%*{"busy": "", "error": "", "done": "", "draft": nil, "ask": true, "save": true})

proc source(what: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if what == DraftSource: draft
    elif what == "clock": $held
    else: ""

proc act(asker, action, args: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try: asked.add (action, parseJson(args))
    except CatchableError: asked.add (action, newJNull())

proc reset() =
  offered = true
  draft = ""
  asked = @[]
  sceneCodeRead = read
  sceneCodeSource = source
  sceneCodeAction = act

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
      check report["counts"]["total"].getInt() >= 9

  test "it asks for the code and for nothing else":
    let config = parseJson(sample["apps"]["codeEditor"]["sources"]["config.json"].getStr())
    check config["permissions"] == %*["code"]
    check codeGrantFromConfig(config)
    check not frameGrantFromConfig(config)
    check assetGrantFromConfig(config) == agOwnFolder

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
    check asked.len == 3
    check asked[0] == ("ask", %*{"prompt": "A clock", "scene": {"id": "clock"}})
    check asked[1] == ("save", %*{"scene": {"id": "clock"}, "show": false})
    check asked[2][0] == "clear"
    check call(%*["code"], "frameos.code('format')")["error"].getStr() == "frameos.code: no such operation: format"

  test "reads and changes nothing while the frame's settings are off its screen":
    offered = false
    check call(%*["code"], "frameos.code('read')")["value"].kind == JNull
    for expression in ["frameos.code('source', 'clock')", "frameos.code('save', { scene: { id: 'x' } })"]:
      check call(%*["code"], expression)["error"].getStr() == "frameos.code: settings on the frame's screen are off"
    check asked.len == 0

  test "is null where no host reads code":
    sceneCodeRead = nil
    check call(%*["code"], "frameos.code('read')")["value"].kind == JNull
    check not call(%*["code"], "frameos.code('ask', { prompt: 'x' })")["ok"].getBool()

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

  test "draws a narrow portrait screen and e-paper":
    for (width, height) in [(480, 800), (296, 128)]:
      let config = testConfig(width, height)
      let scene = load(config)
      scene.state["open"] = %"clock"
      discard draw(scene, config, "small")
    check problems.len == 0
    if problems.len > 0: echo problems
