import std/[json, os, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime
import ../utils/memory

# An awake ESP32 whose headroom never reaches the floors between renders (a
# reTerminal E1004: a 3.84 MB canvas on 8 MB) keeps the interpreters of the
# scene it shows: that scene's next render needs them again before anything
# it decodes, and a switch drops them with the scene. Before, they went after
# every render, a `js:interpreterDiscarded` each time (2026-11-23).

let root = currentSourcePath().parentDir / ".." / ".." / ".." / ".."
let clock = parseJson(readFile(root / "repo" / "scenes" / "samples" / "Big typographic clock" /
  "scenes.json"))[0]

let config = FrameConfig(name: "e1004", mode: "embedded", width: 400, height: 240, rotate: 0,
  scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
  assetsPath: getTempDir() / "frameos-resident-interpreters-test")

var logger = Logger(frameConfig: config, enabled: true)
logger.log = proc(payload: JsonNode) = discard
logger.enable = proc() = discard
logger.disable = proc() = discard

proc start(): FrameScene =
  setUploadedInterpretedScenes(parseInterpretedScenes($(%*[clock])))
  resetInterpretedScenes()
  init(clock["id"].getStr().SceneId, config, logger, %*{})

proc render(scene: FrameScene, canvas: Image) =
  rhythmClockOverride += 60.0
  discard render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))

suite "the scene showing keeps its interpreters":
  setup:
    rhythmClockOverride = 1000.0
    setSimulatedEmbedded(true)
    discard takeInterpreterDiscards()

  teardown:
    setSimulatedEmbedded(false)
    availableRenderBytesOverride = 0

  test "under the floors, above the reserve: kept, and nothing said":
    let scene = start()
    let canvas = newImage(400, 240)
    scene.render(canvas)
    availableRenderBytesOverride = 600 * 1024 # under KeepInterpretersBytes
    check settleIdleJsAppRuntimes(keep = true, resident = [scene])
    check takeInterpreterDiscards().count == 0
    check liveJsAppRuntimeBytes() > 0

  test "not the scene showing: they go, as before":
    let scene = start()
    let canvas = newImage(400, 240)
    scene.render(canvas)
    availableRenderBytesOverride = 600 * 1024
    check not settleIdleJsAppRuntimes(keep = true)
    let discarded = takeInterpreterDiscards()
    check discarded.count >= 1 and discarded.reason == "low memory"

  test "a decode short of memory still takes them":
    let scene = start()
    let canvas = newImage(400, 240)
    scene.render(canvas)
    availableRenderBytesOverride = 600 * 1024
    check settleIdleJsAppRuntimes(keep = true, resident = [scene])
    check renderMemoryReleaseHook(false)
    check takeInterpreterDiscards().reason == "picture"
