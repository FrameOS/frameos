## The Terminal sample (repo/scenes/samples/Terminal app, docs/terminal.md):
## its own tests (app.test.tsx) in its interpreter, the bridge it stands on
## (`frameos.frame`: refused without the "frame" permission and without the
## frame page, the page's hooks reached with both), and the scene itself typed
## into through its UI. FRAMEOS_TERMINAL_SHOTS=<dir> writes what it drew.

import std/[json, os, strutils, unittest]
import pixie
import frameos/channels
import frameos/events_gen
import frameos/frame_settings_hooks
import frameos/interpreter
import frameos/scene_rhythm
import frameos/types
import frameos/js_runtime/app_runtime
import frameos/js_runtime/app_tests
import frameos/values

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let sample = parseFile(Samples / "Terminal app" / "scenes.json")[0]

# The frame page as a host would hand it over, and what reached it.
var
  offered = true
  applied: seq[JsonNode]
  actions: seq[string]

proc facts(): JsonNode {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if offered:
      result = %*{"wifi": {"state": "connected", "ssid": "Home", "ip": "10.0.0.5", "rssi": -52,
        "networks": ["Home"], "scanning": false, "password": true}, "rotate": 0, "renderScale": 0.0,
        "actions": ["restart"], "version": "2026.11.8"}

proc apply(changes: JsonNode) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    applied.add copy(changes)

proc act(action: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    actions.add action

proc sent(): seq[(string, EventOrigin)] =
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok:
      break
    result.add (message[1], message[3])

proc reset() =
  offered = true
  applied = @[]
  actions = @[]
  frameSettingsRead = facts
  frameSettingsApply = apply
  frameSettingsAction = act
  discard sent()

proc testConfig(width = 800, height = 480): FrameConfig =
  FrameConfig(name: "terminal", mode: "rpios", device: "framebuffer", width: width, height: height, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
    timeZone: "UTC", assetsPath: getTempDir())

var logger = Logger(frameConfig: nil, enabled: true)
var problems: seq[string]
logger.log = proc(payload: JsonNode) =
  if payload{"level"}.getStr() == "error" or payload{"event"}.getStr().contains("error"):
    problems.add($payload)
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

suite "the Terminal sample":
  setup:
    reset()

  test "its own tests pass in its interpreter":
    let sources = sample["apps"]["terminal"]["sources"]
    check appTestFiles(sources) == @["app.test.tsx"]
    for testFile in appTestFiles(sources):
      let report = runJsAppTests(sources, testFile, testConfig())
      if not report["ok"].getBool():
        checkpoint($report)
      check report["ok"].getBool()
      check report["counts"]["total"].getInt() >= 9

  test "it asks for the frame and for nothing else":
    let config = parseJson(sample["apps"]["terminal"]["sources"]["config.json"].getStr())
    check config["permissions"] == %*["frame"]
    check frameGrantFromConfig(config)
    check assetGrantFromConfig(config) == agOwnFolder

suite "frameos.frame":
  setup:
    reset()

  let config = testConfig(6, 4)
  logger.frameConfig = config
  let scene = FrameScene(id: "tests/frame".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 3.NodeId, nodeName: "bridge", scene: scene, frameConfig: config)
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)

  proc call(permissions: JsonNode, expression: string): JsonNode =
    ## {ok, value} or {ok: false, error} of one call in an app whose
    ## config.json asks for `permissions`.
    let runtime = newJsAppRuntime(category = "data", outputType = "json",
      source = "export function get() { try { const value = " & expression & "; " &
        "return { ok: true, value: value === undefined ? null : value } } " &
        "catch (e) { return { ok: false, error: String(e.message) } } }")
    runtime.frameGrant = frameGrantFromConfig(%*{"permissions": permissions})
    runtime.get(owner, %*{}, context).asJson()

  test "is refused to an app whose permissions do not ask for frame":
    for permissions in [%*[], %*["assets", "assets-write", "files", "shell"], %*"frame", newJNull()]:
      let answer = call(permissions, "frameos.frame('apply', { rotate: 90 })")
      check not answer["ok"].getBool()
      check answer["error"].getStr() == "frameos.frame: this app's permissions do not include frame"
    check applied.len == 0
    check frameGrantFromConfig(%*{}) == false

  test "reads the frame page's facts and reaches its hooks":
    let read = call(%*["frame"], "frameos.frame('read')")
    check read["ok"].getBool()
    check read["value"]["wifi"]["ssid"].getStr() == "Home"
    check call(%*["frame"], "frameos.frame('apply', { rotate: 90 })")["value"].getBool()
    check applied == @[%*{"rotate": 90}]
    check call(%*["frame"], "frameos.frame('action', 'scan')")["value"].getBool()
    check actions == @["scan"]
    for (name, event) in [("render", evRender), ("restart", evRestart), ("reboot", evReboot)]:
      check call(%*["frame"], "frameos.frame('action', '" & name & "')")["ok"].getBool()
      check sent() == @[(event, eoPanel)]
    let unknown = call(%*["frame"], "frameos.frame('format', '/')")
    check unknown["error"].getStr() == "frameos.frame: no such operation: format"

  test "changes nothing while the frame's settings are off its screen":
    offered = false
    check call(%*["frame"], "frameos.frame('read')")["value"].kind == JNull
    for expression in ["frameos.frame('apply', { rotate: 90 })", "frameos.frame('action', 'reboot')"]:
      let answer = call(%*["frame"], expression)
      check answer["error"].getStr() == "frameos.frame: settings on the frame's screen are off"
    check applied.len == 0 and sent().len == 0

  test "is null where no host offers a page":
    frameSettingsRead = nil
    check call(%*["frame"], "frameos.frame('read')")["value"].kind == JNull
    check not call(%*["frame"], "frameos.frame('action', 'render')")["ok"].getBool()

suite "the Terminal scene":
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
    let dir = getEnv("FRAMEOS_TERMINAL_SHOTS")
    if dir.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig, permissions = %*["frame"]): FrameScene =
    let terminal = copy(sample)
    var app = parseJson(terminal["apps"]["terminal"]["sources"]["config.json"].getStr())
    app["permissions"] = permissions
    terminal["apps"]["terminal"]["sources"]["config.json"] = %($app)
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[terminal])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("terminal-app".SceneId, config, logger, %*{})

  proc typeLine(scene: FrameScene, config: FrameConfig, line: string) =
    # A tap on the line gives it the keyboard; a real keyboard types into it.
    scene.send("tap", %*{"x": config.width div 2, "y": config.height - 18, "pointerId": 0, "pointerType": "touch"})
    discard draw(scene, config, "focused")
    scene.send("textInput", %*{"text": line})
    scene.send("keyDown", %*{"key": "Enter"})
    discard draw(scene, config, "typed")

  test "draws its line and runs what is typed through the frame page":
    let config = testConfig()
    let scene = load(config)
    let image = draw(scene, config, "empty")
    check image.width == 800 and image.height == 480
    scene.typeLine(config, "set rotate 90")
    check applied == @[%*{"rotate": 90}]
    scene.typeLine(config, "render")
    check (evRender, eoPanel) in sent()
    scene.typeLine(config, "wifi-scan")
    check actions == @["scan"]
    check problems.len == 0
    if problems.len > 0: echo problems

  test "changes nothing when its app does not ask for the frame":
    let config = testConfig()
    let scene = load(config, %*[])
    discard draw(scene, config, "unasked")
    scene.typeLine(config, "set rotate 90")
    scene.typeLine(config, "reboot")
    check applied.len == 0
    check (evReboot, eoPanel) notin sent()
