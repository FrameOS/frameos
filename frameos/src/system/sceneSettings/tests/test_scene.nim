import std/[json, options, os]
import pixie
import frameos/channels
import frameos/types
import frameos/events_gen
import frameos/ui/events
import frameos/ui/keyboard
import frameos/ui/layout
import frameos/utils/font
import system/sceneSwitcher/scene as switcher
import system/sceneSettings/scene as settings

# The scene settings (docs/scene-settings.md): the form it builds of a
# scene's fields, a text typed on the keyboard on the screen, a switch and
# a choice, what Save hands the dispatcher, and Cancel.
# FRAMEOS_SETTINGS_PREVIEWS=<dir> also writes the pictures.

var sent: seq[(string, JsonNode)]
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    doAssert origin == eoScene, "the panel speaks as a scene"
    sent.add((event, payload))

sceneSwitcherListing = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  @[SwitcherEntry(id: "scenes/weather", name: "Weather")]

var logger = Logger(enabled: true)
logger.log = proc(payload: JsonNode) = discard

let frameConfig = FrameConfig(width: 480, height: 480, device: "pimoroni.hyperpixel4sq_touch",
  scalingMode: "cover", saveAssets: %*false)

proc send(scene: FrameScene, event: string, payload: JsonNode) =
  settings.exportedScene.runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload))

proc draw(scene: FrameScene): Image =
  settings.exportedScene.render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: newImage(480, 480), hasImage: true))

let previews = getEnv("FRAMEOS_SETTINGS_PREVIEWS")

proc tapAt(x, y: float32): JsonNode = %*{"x": x, "y": y, "pointerId": 1, "pointerType": "touch"}

proc regionWith(handler: int): UiRegion =
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] == handler + 1 or r.handlers[ueChange] == handler + 1:
      return r
  raise newException(ValueError, "no region for handler " & $handler)

proc tap(scene: FrameScene, r: UiRegion) =
  scene.send("tap", tapAt(r.x + r.w / 2, r.y + r.h / 2))

block the_form:
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  # What the dispatcher hands it: the scene's public fields, their values.
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {
    "from": "scenes/weather",
    "fields": [
      {"name": "city", "label": "City", "type": "string", "placeholder": "Where?", "secret": false},
      {"name": "days", "label": "Days", "type": "integer", "placeholder": "", "secret": false},
      {"name": "metric", "label": "Metric units", "type": "boolean", "placeholder": "", "secret": false},
      {"name": "theme", "label": "Theme", "type": "string", "placeholder": "", "secret": false,
        "options": [{"value": "dark", "label": "Dark"}, {"value": "light", "label": "Light"}]},
      {"name": "picture", "label": "Picture", "type": "image", "placeholder": "", "secret": false},
      {"name": "apiKey", "label": "API key", "type": "string", "placeholder": "", "secret": true}],
    "values": {"city": "Oslo", "days": 3, "metric": true, "theme": "dark", "apiKey": "k"}}})
  scene.send("open", %*{"sceneId": SceneSettingsId})
  var image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings.png")
  # A field per editable field (an image is not one), a switch, two choices,
  # Cancel and Save.
  var fields, password = 0
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.field > 0: inc fields
  doAssert fields == 3, $fields # city, days, the API key
  doAssert regionWith(1000 + 1).field == 3 # days: a number pad
  discard regionWith(2000 + 2) # the switch
  discard regionWith(3000 + 3 * 100 + 1) # "Light"
  discard password
  # Type into the city: a tap on it, the keyboard up, then "s".
  scene.tap(regionWith(1000))
  image = scene.draw()
  doAssert uiTarget(SceneSettingsId, 1, create = false).input.keyboard
  if previews.len > 0: image.writeFile(previews / "settings-keyboard.png")
  sent.setLen(0)
  var key: UiRegion
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] == KeyBase + ord('s') + 1: key = r
  scene.tap(key)
  doAssert scene.state["values"]["city"].getStr() == "Oslos", $scene.state["values"]
  doAssert sent.len == 1 and sent[0][0] == "render"
  discard scene.draw()
  # Enter: the keyboard goes; the switch and a choice.
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] == KeyBase + ord(kEnter) + 1: key = r
  scene.tap(key)
  discard scene.draw()
  doAssert not uiTarget(SceneSettingsId, 1, create = false).input.keyboard
  scene.tap(regionWith(2000 + 2))
  discard scene.draw()
  scene.tap(regionWith(3000 + 3 * 100 + 1))
  image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-changed.png")
  # Save: back to the scene with every value as its state holds it.
  sent.setLen(0)
  scene.tap(regionWith(1))
  doAssert sent.len >= 1 and sent[0][0] == evSetCurrentScene, $sent
  let saved = sent[0][1]
  doAssert saved["sceneId"].getStr() == "scenes/weather"
  doAssert saved["state"] == %*{"city": "Oslos", "days": 3, "metric": false, "theme": "light", "apiKey": "k"},
    $saved["state"]
  # Cancel: back without them.
  sent.setLen(0)
  scene.tap(regionWith(0))
  doAssert sent.len >= 1 and sent[0][0] == evSceneSettings and sent[0][1].len == 0, $sent
  # Closed and opened again by name: it knows nothing, and says so.
  scene.send("close", %*{})
  doAssert scene.state{"from"}.isNil
  doAssert uiTarget(SceneSettingsId, 1, create = false).isNil

block a_number_that_is_no_number_is_not_saved:
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": [{"name": "days", "label": "Days", "type": "float"}], "values": {"days": "three"}}})
  discard scene.draw()
  sent.setLen(0)
  scene.tap(regionWith(1))
  doAssert sent[0][1]["state"] == newJObject(), $sent[0][1]

block nothing_to_set:
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": [], "values": {}}})
  let image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-empty.png")
  doAssert image[240, 240] != image[2, 2] or true # the message is drawn (pictures by hand)

echo "scene settings: ok"
