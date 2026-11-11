import std/[json, os, times]
import ../scene_store_linux
import ../server/api
import ../config
import system/sceneSwitcher/scene as sceneSwitcher

# The scene store on a Linux frame's own screen (docs/scene-store-on-frame.md),
# for a frame with no control plane: what came from the store is read off its
# scenes, the page is offered while frame.json leaves the settings on the
# screen on, and a scene is removed from the frame's own scenes on its worker
# thread. (Asking a plane and the store is the network's; the planes' routes
# have their own tests.)

let dir = getTempDir() / "frameos-scene-store-" & $epochTime().int
createDir(dir)
putEnv("FRAMEOS_SCENES_JSON", dir / "scenes.json")
putEnv("FRAMEOS_CONFIG", dir / "frame.json")

const Radar = "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a01"

proc scenes(): JsonNode =
  %*[
    {"id": "clock", "name": "Clock", "nodes": [], "edges": [], "settings": {"execution": "interpreted"}},
    {"id": "radar", "name": "Rain radar", "nodes": [], "edges": [], "settings": {"execution": "interpreted"},
     "origin": {"href": "https://scenes.frameos.net/s/radar", "storeSceneId": Radar, "version": "3"}},
  ]

proc waitIdle(): JsonNode =
  for i in 0 ..< 200:
    result = linuxSceneStoreRead()
    if not result.isNil and result{"busy"}.getStr() == "":
      return
    sleep(10)
  doAssert false, "the worker never finished"

writeFile(dir / "frame.json", $(%*{"name": "Test", "frameSettingsOnScreen": true, "width": 800, "height": 480}))
persistScenesPayload(scenes())

block the_page_is_offered_and_lists_what_came_from_the_store:
  installSceneStoreHooks()
  doAssert not sceneStoreRead.isNil and not sceneStoreAction.isNil
  let facts = linuxSceneStoreRead()
  doAssert not facts.isNil, "frame.json leaves the settings on the screen on"
  doAssert facts{"removeAny"}.getBool(), "a frame with no plane may remove any scene"
  # The worker reads the origins once something runs.
  linuxSceneStoreAction("remove", %*{"id": "nope", "store": ""})
  let after = waitIdle()
  doAssert after{"error"}.getStr() == "scene_not_assigned", $after
  doAssert after{"installed"} == %*[{"id": "radar", "store": Radar, "v": 3}], $after{"installed"}

block a_store_scene_is_removed_from_the_frames_own_scenes:
  linuxSceneStoreAction("remove", %*{"id": "radar", "store": Radar})
  let facts = waitIdle()
  doAssert facts{"error"}.getStr() == "", $facts
  doAssert facts{"done"}.getStr() == "remove"
  doAssert facts{"installed"}.len == 0
  let left = loadScenePayload()
  doAssert left.len == 1 and left[0]{"id"}.getStr() == "clock", $left
  # The last one stays.
  linuxSceneStoreAction("remove", %*{"id": "clock", "store": ""})
  doAssert waitIdle(){"error"}.getStr() == "last_scene"
  doAssert loadScenePayload().len == 1

block the_lock_hides_the_page:
  writeFile(dir / "frame.json", $(%*{"name": "Test", "frameSettingsOnScreen": false, "width": 800, "height": 480}))
  noteFrameConfigChanged()
  doAssert linuxSceneStoreRead().isNil, "the settings on the screen are off: no store"

removeDir(dir)
echo "scene store (linux): ok"
