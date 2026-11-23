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
  doAssert not facts.hasKey("listing") # the app fetches its pages itself
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

block a_plane_that_does_not_answer_is_not_the_store:
  # A backend that is not there (the laptop running it asleep, 2026-11-23):
  # the page says the control plane did not answer, never that the store did
  # not, and nothing is installed here instead.
  writeFile(dir / "frame.json", $(%*{"name": "Test", "frameSettingsOnScreen": true, "width": 800, "height": 480,
    "serverHost": "0.0.0.0", "serverPort": 9, "serverScheme": "http", "serverApiKey": "key"}))
  noteFrameConfigChanged()
  doAssert not read(){"removeAny"}.getBool(true), "a frame with a backend asks it"
  act("install", %*{"store": Radar})
  var facts: JsonNode
  for i in 0 ..< 3000:
    facts = read()
    if facts{"busy"}.getStr() == "":
      break
    sleep(10)
  doAssert facts{"busy"}.getStr() == "", "the worker never finished"
  doAssert facts{"error"}.getStr() == "plane_unavailable", $facts
  doAssert loadScenePayload().len == 1, "nothing installed on the frame's own"

block the_lock_hides_the_page:
  writeFile(dir / "frame.json", $(%*{"name": "Test", "frameSettingsOnScreen": false, "width": 800, "height": 480}))
  noteFrameConfigChanged()
  doAssert read().isNil, "the settings on the screen are off: no store"

removeDir(dir)
echo "scene store (linux): ok"
