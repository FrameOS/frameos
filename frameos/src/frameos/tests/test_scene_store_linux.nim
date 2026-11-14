import std/[json, os, strutils, times]
import ../scene_store_linux
import ../server/api
import ../config
import ../channels
import ../scene_store_hooks

# What the worker asks of the runtime (the runner's channel), with who asks:
# the contract lets no panel reload or switch, so a local change goes out as
# the runtime's own.
proc sentEvents(): seq[(string, EventOrigin)] =
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok:
      break
    result.add((message[1], message[3]))

# The scene store's host on a Linux frame (docs/scene-store.md), for a frame
# with no control plane: what came from the store is read off its scenes, the
# store is offered while frame.json leaves the settings on the screen on, and
# a scene is removed from the frame's own scenes on its worker thread. (Asking a plane and the store is the network's; the planes' routes
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

proc read(): JsonNode =
  let text = linuxSceneStoreRead("store")
  if text.len > 0: parseJson(text) else: nil

proc act(action: string, args: JsonNode) =
  linuxSceneStoreAction("store", action, $args)

proc waitIdle(): JsonNode =
  for i in 0 ..< 200:
    result = read()
    if not result.isNil and result{"busy"}.getStr() == "":
      return
    sleep(10)
  doAssert false, "the worker never finished"

writeFile(dir / "frame.json", $(%*{"name": "Test", "frameSettingsOnScreen": true, "width": 800, "height": 480}))
persistScenesPayload(scenes())

block the_page_is_offered_and_lists_what_came_from_the_store:
  installSceneStoreHooks()
  doAssert not sceneStoreRead.isNil and not sceneStoreAction.isNil
  let facts = read()
  doAssert not facts.isNil, "frame.json leaves the settings on the screen on"
  doAssert facts{"removeAny"}.getBool(), "a frame with no plane may remove any scene"
  doAssert facts{"url"}.getStr().startsWith("http"), $facts
  doAssert facts{"listing"}.kind == JNull and facts{"params"}.getStr() == ""
  # The worker reads the origins once something runs.
  act("remove", %*{"id": "nope", "store": ""})
  let after = waitIdle()
  doAssert after{"error"}.getStr() == "scene_not_assigned", $after
  doAssert after{"installed"} == %*[{"id": "radar", "store": Radar, "v": 3}], $after{"installed"}

block a_store_scene_is_removed_from_the_frames_own_scenes:
  act("remove", %*{"id": "radar", "store": Radar})
  let facts = waitIdle()
  doAssert facts{"error"}.getStr() == "", $facts
  doAssert facts{"done"}.getStr() == "remove"
  doAssert facts{"installed"}.len == 0
  let left = loadScenePayload()
  doAssert left.len == 1 and left[0]{"id"}.getStr() == "clock", $left
  let sent = sentEvents()
  doAssert ("reload", eoSystem) in sent, "the runtime reloads what was saved: " & $sent
  # The last one stays.
  act("remove", %*{"id": "clock", "store": ""})
  doAssert waitIdle(){"error"}.getStr() == "last_scene"
  doAssert loadScenePayload().len == 1

block the_lock_hides_the_page:
  writeFile(dir / "frame.json", $(%*{"name": "Test", "frameSettingsOnScreen": false, "width": 800, "height": 480}))
  noteFrameConfigChanged()
  doAssert read().isNil, "the settings on the screen are off: no store"

block a_browse_takes_a_query_string_and_nothing_else:
  doAssert validStoreParams("category=photos&page=2&limit=6&prefer=realtime&q=rain%20radar")
  doAssert not validStoreParams("q=a b")
  doAssert not validStoreParams("q=x#y")
  doAssert not validStoreParams("../../api/frames")

removeDir(dir)
echo "scene store (linux): ok"
