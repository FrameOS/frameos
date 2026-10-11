import std/[json, options, os]
import ../channels
import ../interpreter
import ../single_scene_host
import ../types

# The ESP32 and the wasm preview hold one scene, built on first use. A battery
# ESP32 reads the button that woke it before its first render, so the press is
# the first use: it must build the scene and reach it, not be dropped because
# nothing is resident yet.

const fixturesPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "event-fixtures.json"
const switchCase = "a scene's own setCurrentScene switches scenes, on every host"

var scenes = newJArray()
for c in parseFile(fixturesPath)["dispatcher"]["cases"]:
  if c["name"].getStr() == switchCase:
    scenes = c["scenes"]
doAssert scenes.len == 2, "fixture case missing: " & switchCase
replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenes)))

let config = FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover", debug: false, saveAssets: %*false)
var logger = Logger(frameConfig: config, enabled: true)
logger.log = proc(payload: JsonNode) = discard
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

var selected: seq[string]
let host = SingleSceneHost(frameConfig: config, logger: logger)
host.requestSelect = proc (sceneId: string): bool =
  selected.add(sceneId)
  true
host.start()
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    host.queue(origin, event, payload, scene)

host.makeCurrent("fixtures/dispatcher/switchFrom".SceneId)
doAssert host.scene.isNil, "the scene is built by its first use, not by being made current"

doAssert host.send(eoDriver, "button", %*{"pin": 5, "label": "RIGHT", "level": 0}),
  "a button sent before the first render is dispatched"
doAssert not host.scene.isNil
doAssert selected == @["fixtures/dispatcher/switchTo"], "selected " & $selected

# A switch sent before the first render (the backend's set_current_scene,
# queued for the wake) must not build the scene it is leaving: the dispatcher
# serves a switch without one, and building it is seconds of work for a scene
# nobody sees.
let fresh = SingleSceneHost(frameConfig: config, logger: logger)
var freshSelected: seq[string]
fresh.requestSelect = proc (sceneId: string): bool =
  freshSelected.add(sceneId)
  true
fresh.start()
fresh.makeCurrent("fixtures/dispatcher/switchFrom".SceneId)
doAssert fresh.send(eoCloud, "setCurrentScene", %*{"sceneId": "fixtures/dispatcher/switchTo"})
doAssert fresh.scene.isNil, "the scene being left was not built for the switch"
doAssert freshSelected == @["fixtures/dispatcher/switchTo"], "selected " & $freshSelected
echo "ok"
