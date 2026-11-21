## Host probe: what a loaded scene keeps on the Nim heap, its apps' files in
## it (sfResident, as before) or read from where its JSON lives when an
## interpreter starts (sfHost, as an ESP32 reads its slot). QuickJS's own heap
## is the same either way and is not counted (getOccupiedMem is Nim's).
##
##   nim c -d:release -d:testing --nimcache:build/scene-memory/nimcache-memory \
##     -o:build/scene-memory/scene_memory_probe tools/scene_memory_probe.nim
##   build/scene-memory/scene_memory_probe "Brick breaker" "Code editor" ...
##
## Each sample is read the way a board reads its slot (one scene object),
## parsed, initialised and rendered once at 800x480; "held" is what stays after
## a full collection, the scene still loaded (the 1.5 MB canvas included,
## the same in both), after one render of each to warm what renders keep.

import std/[json, os, strutils, tables]
import pixie
import frameos/interpreter
import frameos/types
import frameos/js_runtime/app_runtime

const Samples = currentSourcePath().parentDir() / ".." / ".." / "repo" / "scenes" / "samples"

proc kb(n: int): string = $(n div 1024) & " KB"

var slot = ""
sceneFileReader = proc (sceneId: SceneId): string =
  {.cast(gcsafe).}: slot

let config = FrameConfig(name: "probe", width: 800, height: 480, rotate: 0, scalingMode: "cover",
  debug: false, settings: %*{}, saveAssets: %*false, assetsPath: getTempDir() / "frameos-memory-probe")
var logger = Logger(frameConfig: config, enabled: false)
logger.log = proc(payload: JsonNode) = discard
logger.enable = proc() = discard
logger.disable = proc() = discard

proc measure(name: string, files: SceneFiles): tuple[parsed, held: int] =
  let scene = parseJson(readFile(Samples / name / "scenes.json"))[0]
  slot = $scene
  GC_fullCollect()
  let before = getOccupiedMem()
  block:
    let scenes = buildInterpretedScenes(parseInterpretedSceneInput(slot, files))
    GC_fullCollect()
    result.parsed = getOccupiedMem() - before
    setUploadedInterpretedScenes(scenes)
    resetInterpretedScenes()
    let frameScene = init(scene["id"].getStr().SceneId, config, logger, %*{})
    let canvas = newImage(800, 480)
    let context = ExecutionContext(scene: frameScene, event: "render", payload: %*{}, image: canvas,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    try:
      discard render(frameScene, context)
    except CatchableError as error:
      echo "  render: ", error.msg
    GC_fullCollect()
    result.held = getOccupiedMem() - before
    discard settleIdleJsAppRuntimes(keep = false)
    setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
    resetInterpretedScenes()

for name in commandLineParams():
  discard measure(name, SceneFiles(kind: sfResident)) # warms the caches a render keeps (fonts, the preludes)
  let resident = measure(name, SceneFiles(kind: sfResident))
  let lazy = measure(name, SceneFiles(kind: sfHost))
  echo name, " (", kb(readFile(Samples / name / "scenes.json").len), " of JSON): parsed ", kb(resident.parsed),
    " -> ", kb(lazy.parsed), ", held after a render ", kb(resident.held), " -> ", kb(lazy.held),
    " (", kb(resident.held - lazy.held), " less)"
