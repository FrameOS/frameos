import std/[json, options, os]
import pixie
import frameos/channels
import frameos/types
import frameos/events_gen
import frameos/ui/events
import frameos/ui/layout
import system/sceneSwitcher/scene as switcher

# The scene store on the frame's own screen (docs/scene-store-on-frame.md):
# the switcher's last tile, the store's page and a scene's page (a long press
# on its tile), driven through a host that answers with fixed facts and
# records what it was asked. FRAMEOS_SWITCHER_PREVIEWS=<dir> writes the
# pictures.

var listed: seq[SwitcherEntry]
proc testListing(): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    listed
sceneSwitcherListing = testListing

var
  facts: JsonNode ## nil: no store on this frame
  asked: seq[(string, JsonNode)]
proc testRead(): JsonNode {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    result = if facts.isNil: nil else: copy(facts)
proc testAct(action: string, args: JsonNode) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    asked.add((action, args))
sceneStoreRead = testRead
sceneStoreAction = testAct

var sent: seq[(string, JsonNode)]
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    sent.add((event, payload))

const
  Radar = "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a01"
  Tides = "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a02"
  Comic = "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a03"

proc baseFacts(): JsonNode =
  %*{
    "busy": "", "error": "", "done": "", "query": "", "category": "", "page": 1,
    "categories": [{"slug": "weather", "title": "Weather"}, {"slug": "fun", "title": "Fun & comics"}],
    "listing": {"page": 1, "more": true, "scenes": [
      {"id": Radar, "name": "Rain radar", "category": "weather", "version": 2, "by": "Ana"},
      {"id": Tides, "name": "Tide tables", "category": "weather", "version": 1, "by": "Bo"},
      {"id": Comic, "name": "Daily comic", "category": "fun", "version": 4, "by": "Cy"},
    ]},
    "installed": [{"id": "scene-1", "store": Radar, "v": 1}, {"id": "scene-2", "store": Tides, "v": 1}],
    "preview": nil, "info": nil, "removeAny": false,
  }

proc config(device = "pimoroni.hyperpixel4sq_touch"): FrameConfig =
  FrameConfig(width: 720, height: 720, device: device, rotate: 0, scalingMode: "cover", saveAssets: %*false)

var logger = Logger(enabled: true)
logger.log = proc(payload: JsonNode) = discard

proc newSwitcher(frameConfig: FrameConfig, opener = "scene-3"): SceneSwitcherScene =
  result = SceneSwitcherScene(switcher.exportedScene.init(SceneSwitcherId.SceneId, frameConfig, logger, %*{}))
  switcher.exportedScene.runEvent(result, ExecutionContext(scene: result, event: "setCurrentScene",
    payload: %*{"sceneId": SceneSwitcherId, "state": {"from": opener}}))
  switcher.exportedScene.runEvent(result, ExecutionContext(scene: result, event: "open", payload: %*{"sceneId": SceneSwitcherId}))

proc send(scene: SceneSwitcherScene, event: string, payload: JsonNode) =
  switcher.exportedScene.runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload))

proc draw(scene: SceneSwitcherScene, image = newImage(720, 720)): Image =
  switcher.exportedScene.render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: image, hasImage: true))

proc regionOf(handler: int, kind = ueClick): UiRegion =
  let target = uiTarget(SceneSwitcherId, 1, create = false)
  doAssert not target.isNil, "nothing drawn"
  for region in target.regions:
    if region.handlers[kind] == handler + 1:
      return region
  doAssert false, "no element with handler " & $handler

proc has(handler: int): bool =
  let target = uiTarget(SceneSwitcherId, 1, create = false)
  for region in target.regions:
    if region.handlers[ueClick] == handler + 1:
      return true

proc press(scene: SceneSwitcherScene, handler: int, event = "tap") =
  let
    target = uiTarget(SceneSwitcherId, 1, create = false)
    region = regionOf(handler, if event == "longPress": ueLongPress else: ueClick)
    scale = if target.scale > 0: target.scale else: 1'f32
    x = (region.x + region.w / 2) * scale + target.offsetX
    y = (region.y + region.h / 2) * scale + target.offsetY
  scene.send(event, %*{"x": x.int, "y": y.int, "pointerId": 1, "pointerType": "touch", "durationMs": 600})

proc lastAsked(): (string, JsonNode) =
  doAssert asked.len > 0, "the host was asked nothing"
  asked[^1]

let previews = getEnv("FRAMEOS_SWITCHER_PREVIEWS")
proc preview(name: string, image: Image) =
  if previews.len > 0:
    createDir(previews)
    image.writeFile(previews / name & ".png")

listed = @[SwitcherEntry(id: "scene-1", name: "Rain radar"), SwitcherEntry(id: "scene-2", name: "Tide tables"),
  SwitcherEntry(id: "scene-3", name: "Kitchen clock")]

block no_store_no_tile:
  facts = nil
  let scene = newSwitcher(config())
  discard scene.draw()
  doAssert not has(HStoreTile), "a frame with no store shows no store tile"

block the_store_tile_comes_last_and_opens_the_store:
  facts = baseFacts()
  asked.setLen(0)
  let scene = newSwitcher(config())
  preview("store-tiles", scene.draw())
  doAssert has(HStoreTile)
  scene.press(HStoreTile)
  doAssert scene.state{"view"}.getStr() == "store"
  doAssert lastAsked()[0] == "open"
  preview("store-page", scene.draw())
  # A row the frame lacks: Preview and Install. One it holds at the newest
  # version: Show. One with a newer version: Update and Show.
  doAssert has(HPreview + 2) and has(HInstall + 2)
  doAssert has(HShow + 1) and not has(HInstall + 1) and not has(HUpdate + 1)
  doAssert has(HUpdate + 0) and has(HShow + 0)
  doAssert has(HNextPage) and not has(HPrevPage), "a first page with more after it"

  scene.press(HInstall + 2)
  doAssert lastAsked() == ("install", %*{"store": Comic, "name": "Daily comic"})
  scene.press(HPreview + 2)
  doAssert lastAsked() == ("preview", %*{"store": Comic, "name": "Daily comic", "from": "scene-3"})
  scene.press(HUpdate + 0)
  doAssert lastAsked() == ("update", %*{"id": "scene-1", "store": Radar})
  scene.press(HNextPage)
  doAssert lastAsked() == ("browse", %*{"page": "2"})
  sent.setLen(0)
  scene.press(HShow + 1)
  doAssert sent.len > 0 and sent[^1][0] == "setCurrentScene" and sent[^1][1]{"sceneId"}.getStr() == "scene-2"
  scene.press(HBack)
  doAssert scene.state{"view"}.getStr() == ""

block the_search_is_sent_on_enter_or_the_button:
  facts = baseFacts()
  let state = %*{}
  var shown = ""
  doAssert storeHandle(state, facts, HQuery, "rain", "", "scene-3", shown) == smNone
  doAssert state{"draft"}.getStr() == "rain"
  asked.setLen(0)
  discard storeHandle(state, facts, HSearch, "", "a", "scene-3", shown)
  doAssert asked.len == 0, "a key that is not Enter searches nothing"
  discard storeHandle(state, facts, HSearch, "", "Enter", "scene-3", shown)
  doAssert lastAsked() == ("browse", %*{"q": "rain", "page": "1"})
  discard storeHandle(state, facts, HCategory, "fun", "", "scene-3", shown)
  doAssert lastAsked() == ("browse", %*{"category": "fun", "page": "1"})

block a_long_press_opens_the_scene_and_remove_asks_twice:
  facts = baseFacts()
  asked.setLen(0)
  let scene = newSwitcher(config())
  discard scene.draw()
  scene.press(HInfo + 0, "longPress")
  doAssert scene.state{"view"}.getStr() == "info"
  doAssert lastAsked() == ("info", %*{"id": "scene-1", "store": Radar})
  facts["info"] = %*{"id": "scene-1", "store": Radar, "scene": {"id": Radar, "name": "Rain radar",
    "category": "weather", "version": 2, "by": "Ana", "description": "Rain in the next two hours."}}
  preview("store-info", scene.draw())
  doAssert has(HInfoShow) and has(HInfoUpdate) and has(HInfoRemove)
  scene.press(HInfoUpdate)
  doAssert lastAsked() == ("update", %*{"id": "scene-1", "store": Radar})
  let before = asked.len
  scene.press(HInfoRemove)
  doAssert asked.len == before, "the first tap only asks"
  preview("store-info-remove", scene.draw())
  scene.press(HInfoRemove)
  doAssert lastAsked() == ("remove", %*{"id": "scene-1", "store": Radar})
  doAssert scene.state{"view"}.getStr() == "info", "the page stays until the scene is gone"
  # Gone from the frame: the tiles again.
  listed.delete(0)
  discard scene.draw()
  doAssert scene.state{"view"}.getStr() == ""
  listed.insert(SwitcherEntry(id: "scene-1", name: "Rain radar"), 0)

  # A scene not from the store: nothing to update, and on a frame with a
  # control plane nothing to remove either.
  discard scene.draw()
  scene.press(HInfo + 2, "longPress")
  discard scene.draw()
  doAssert not has(HInfoUpdate) and not has(HInfoRemove)
  doAssert not has(HInfoShow), "the scene showing is not offered again"

block a_preview_opens_on_the_store_with_install_and_discard:
  facts = baseFacts()
  facts["preview"] = %*{"store": Comic, "id": "comic-rt", "name": "Daily comic"}
  listed.add SwitcherEntry(id: "comic-rt", name: "Daily comic")
  asked.setLen(0)
  let scene = newSwitcher(config(), opener = "comic-rt")
  doAssert scene.state{"view"}.getStr() == "store", "opened over a preview: the store's page"
  discard scene.draw()
  doAssert has(HInstall + 2) and not has(HPreview + 2)
  scene.press(HBack)
  discard scene.draw()
  scene.press(HInfo + 3, "longPress")
  discard scene.draw()
  doAssert has(HInfoInstall) and has(HInfoDiscard) and not has(HInfoRemove)
  scene.press(HInfoInstall)
  doAssert lastAsked() == ("install", %*{"store": Comic, "name": "Daily comic"})
  discard scene.draw()
  scene.press(HInfoDiscard)
  discard scene.draw()
  scene.press(HInfoDiscard)
  doAssert lastAsked()[0] == "discard"
  listed.setLen(3)

block the_keys_walk_the_buttons_of_a_page:
  facts = baseFacts()
  let scene = newSwitcher(config("waveshare.EPD_7in5_V2"))
  discard scene.draw()
  # The store tile by the keys: the one after the scene it was opened from
  # (the third and last).
  scene.send("button", %*{"action": "press", "role": "next"})
  doAssert scene.state{"highlight"}.getStr() == "+store"
  scene.send("button", %*{"action": "press", "role": "primary"})
  doAssert scene.state{"view"}.getStr() == "store"
  preview("store-page-paper", scene.draw())
  scene.send("button", %*{"action": "press", "role": "next"})
  doAssert scene.state{"focus"}.getInt() == 0
  discard scene.draw()
  # The first button is Back.
  scene.send("button", %*{"action": "press", "role": "primary"})
  doAssert scene.state{"view"}.getStr() == ""
  # Pressed twice on a scene's tile: its page.
  scene.send("button", %*{"action": "press", "role": "prev"})
  scene.send("button", %*{"action": "doublePress", "role": "primary"})
  doAssert scene.state{"view"}.getStr() == "info"

block the_words_for_what_went_wrong_are_the_pages:
  facts = baseFacts()
  facts["error"] = %"too_many_scenes"
  let scene = newSwitcher(config())
  scene.state["view"] = %"store"
  preview("store-error", scene.draw())
  facts["error"] = %""
  facts["busy"] = %"install"
  discard scene.draw()

echo "scene store: ok"
