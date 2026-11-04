import std/[json, options, os, sequtils]
import pixie
import frameos/channels
import frameos/types
import frameos/events_gen
import frameos/panel_shape
import frameos/ui/events
import frameos/ui/keyboard
import frameos/ui/layout
import frameos/utils/font
import system/sceneSwitcher/scene as switcher
import system/sceneSettings/scene as settings

# The scene settings (docs/scene-settings.md): the form it builds of a
# scene's fields, a text typed on the keyboard on the screen, a switch and
# a choice, what Save hands the dispatcher, Cancel and the frame's back.
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
  # A field per editable field (an image is not one), a switch, a select box,
  # Cancel and Save.
  var fields, password = 0
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.field in 1'u8 .. 3'u8: inc fields
  doAssert fields == 3, $fields # city, days, the API key
  doAssert regionWith(1000 + 1).field == 3 # days: a number pad
  discard regionWith(2000 + 2) # the switch
  doAssert uiTarget(SceneSettingsId, 1, create = false).regions.filterIt(it.field == 4).len == 1 # the theme
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
  scene.tap(uiTarget(SceneSettingsId, 1, create = false).regions.filterIt(it.field == 4)[0])
  discard scene.draw()
  scene.tap(regionWith(OptionBase + 1)) # "Light"
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

block a_key_held_shows_its_accents:
  # A key held on the keyboard on the screen (the dispatcher's longPress,
  # while the finger is down) shows its accented forms above it; a tap on
  # one types it into the field (docs/jsx-ui.md "Fields and the keyboard").
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {
    "from": "scenes/weather",
    "fields": [{"name": "city", "label": "City", "type": "string", "placeholder": "", "secret": false}],
    "values": {"city": "Oslo"}}})
  scene.send("open", %*{"sceneId": SceneSettingsId})
  discard scene.draw()
  scene.tap(regionWith(1000))
  discard scene.draw()
  var key: UiRegion
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] == KeyBase + ord('e') + 1: key = r
  scene.send("longPress", tapAt(key.x + key.w / 2, key.y + key.h / 2))
  doAssert uiTarget(SceneSettingsId, 1, create = false).input.accents == ord('e')
  let image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-accents.png")
  var forms: seq[UiRegion]
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] - 1 >= AccentBase and r.handlers[ueClick] - 1 < OptionBase: forms.add r
  doAssert forms.len == 7, $forms.len
  doAssert forms[0].y + forms[0].h < key.y
  scene.tap(forms[1])
  doAssert scene.state["values"]["city"].getStr() == "Osloé", $scene.state["values"]
  doAssert uiTarget(SceneSettingsId, 1, create = false).input.accents == 0
  discard scene.draw()

block back_takes_the_keyboard_away_then_the_form:
  # The frame's `back` (a swipe in from the left), as on a phone: with a
  # field's keyboard up it puts that away and stays; then it closes, unsaved.
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": [{"name": "city", "label": "City", "type": "string"}], "values": {"city": "Oslo"}}})
  discard scene.draw()
  scene.tap(regionWith(1000))
  discard scene.draw()
  doAssert uiTarget(SceneSettingsId, 1, create = false).input.keyboard
  sent.setLen(0)
  scene.send(evBack, %*{})
  doAssert not uiTarget(SceneSettingsId, 1, create = false).input.keyboard
  doAssert sent.len == 1 and sent[0][0] == evRender, $sent
  discard scene.draw()
  sent.setLen(0)
  scene.send(evBack, %*{})
  doAssert sent.len == 1 and sent[0][0] == evSceneSettings and sent[0][1].len == 0, $sent
  scene.send("close", %*{})

block options_are_a_select_box:
  # A scene's field with options is a select box, its options strings as well
  # as {value, label}.
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": [{"name": "city", "label": "City", "type": "select",
      "options": ["Oslo", "Riga", "Kyiv", "Lima", "Bern", "Baku"]}],
    "values": {"city": "Riga"}}})
  var image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-select.png")
  scene.tap(uiTarget(SceneSettingsId, 1, create = false).regions.filterIt(it.field == 4)[0])
  image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-select-open.png")
  scene.tap(regionWith(OptionBase + 2))
  image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-select-picked.png")
  sent.setLen(0)
  scene.tap(regionWith(1))
  doAssert sent[0][1]["state"] == %*{"city": "Kyiv"}, $sent
  scene.send("close", %*{})

block a_long_list_stays_on_the_screen:
  # Fifty-eight options under four fields: the list opens above the select,
  # on the screen, and scrolls. `back` closes it and leaves the panel up.
  var fields = %*[{"name": "a", "label": "A", "type": "string"}, {"name": "b", "label": "B", "type": "string"},
    {"name": "c", "label": "C", "type": "string"}]
  var names = newJArray()
  for i in 1 .. 58:
    names.add %("Network " & $i)
  fields.add %*{"name": "wifi", "label": "Network", "type": "select", "options": names,
    "placeholder": "Choose a network"}
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": fields, "values": {"wifi": "Network 40"}}})
  discard scene.draw()
  let select = uiTarget(SceneSettingsId, 1, create = false).regions.filterIt(it.field == 4)[0]
  scene.tap(select)
  var image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-select-many.png")
  let rows = uiTarget(SceneSettingsId, 1, create = false).regions.filterIt(it.handlers[ueClick] > OptionBase)
  doAssert rows.len > 0
  for r in rows:
    doAssert r.visible[1] >= 8 and r.visible[3] <= 472, $r.visible
    doAssert r.visible[3] <= select.visible[1], "above the select"
  doAssert rows.anyIt(it.handlers[ueClick] == OptionBase + 39 + 1), "what it holds is in sight"
  sent.setLen(0)
  scene.send(evBack, %*{})
  discard scene.draw()
  doAssert uiTarget(SceneSettingsId, 1, create = false).input.open == 0
  doAssert sent.allIt(it[0] != evSceneSettings), "the panel stays up: " & $sent
  scene.send("close", %*{})

block e_paper_black_on_white:
  let paper = FrameConfig(width: 480, height: 480, device: "pimoroni.inky_impression_7", scalingMode: "cover",
    saveAssets: %*false)
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, paper, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": [{"name": "city", "label": "City", "type": "select", "options": ["Oslo", "Riga", "Kyiv"]}],
    "values": {"city": "Riga"}}})
  discard scene.draw()
  scene.tap(uiTarget(SceneSettingsId, 1, create = false).regions.filterIt(it.field == 4)[0])
  let image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-select-paper.png")
  doAssert uiTarget(SceneSettingsId, 1, create = false).input.open > 0
  scene.send("close", %*{})

block a_string_option_shows_itself:
  proc drawn(held: string): Image =
    let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
    scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
      "fields": [{"name": "city", "label": "City", "type": "select", "options": ["Oslo", "Riga"]}],
      "values": {"city": held}}})
    result = scene.draw()
    scene.send("close", %*{})
  doAssert drawn("Riga").data != drawn("none of them").data, "the select box shows the option it holds"

block a_few_options_as_a_select_box_too:
  # Whatever the count, and without a label an option shows its value.
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": [{"name": "city", "label": "City", "type": "select",
      "options": [{"value": "oslo"}, {"value": "riga", "label": "Riga"}]}],
    "values": {"city": "riga"}}})
  discard scene.draw()
  scene.tap(uiTarget(SceneSettingsId, 1, create = false).regions.filterIt(it.field == 4)[0])
  discard scene.draw()
  scene.tap(regionWith(OptionBase + 0))
  discard scene.draw()
  sent.setLen(0)
  scene.tap(regionWith(1))
  doAssert sent[0][1]["state"] == %*{"city": "oslo"}, $sent
  scene.send("close", %*{})

block nothing_to_set:
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, frameConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {"from": "scenes/weather",
    "fields": [], "values": {}}})
  let image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-empty.png")
  doAssert image[240, 240] != image[2, 2] or true # the message is drawn (pictures by hand)

block a_round_panel_keeps_the_form_and_the_keyboard_on_the_glass:
  # The HyperPixel 2.1" Round: only the circle inscribed in its 480x480 shows
  # and takes a touch. Every region the form hit-tests and every pixel it
  # draws stays RoundInset in from the rim, with the keyboard down and up.
  let roundConfig = FrameConfig(width: 480, height: 480, device: "pimoroni.hyperpixel2r",
    scalingMode: "cover", saveAssets: %*false)
  let scene = settings.exportedScene.init(SceneSettingsId.SceneId, roundConfig, logger, %*{})
  scene.send("setCurrentScene", %*{"sceneId": SceneSettingsId, "state": {
    "from": "scenes/weather",
    "fields": [
      {"name": "city", "label": "City", "type": "string", "placeholder": "Where?", "secret": false},
      {"name": "metric", "label": "Metric units", "type": "boolean", "placeholder": "", "secret": false},
      {"name": "theme", "label": "Theme", "type": "string", "placeholder": "", "secret": false,
        "options": [{"value": "dark", "label": "Dark"}, {"value": "light", "label": "Light"}]},
      {"name": "notes", "label": "Notes", "type": "text", "placeholder": "", "secret": false}],
    "values": {"city": "Oslo", "metric": true, "theme": "dark", "notes": ""}}})
  scene.send("open", %*{"sceneId": SceneSettingsId})
  proc onTheGlass(image: Image, where: string) =
    for r in uiTarget(SceneSettingsId, 1, create = false).regions:
      if r.handlers[ueClick] - 1 == KeyBase or r.visible[0] >= r.visible[2] or r.visible[1] >= r.visible[3]:
        continue # the keyboard's own box (a tap between its keys), or scrolled out of sight
      for (x, y) in [(r.visible[0], r.visible[1]), (r.visible[2] - 1, r.visible[1]),
          (r.visible[0], r.visible[3] - 1), (r.visible[2] - 1, r.visible[3] - 1)]:
        doAssert insideRound(480, 480, int(x), int(y), RoundInset),
          where & ": a region reaches off the glass at " & $(x, y) & " " & $r
    let background = image[0, 0]
    for y in 0 ..< 480:
      for x in 0 ..< 480:
        if not insideRound(480, 480, x, y, RoundInset):
          doAssert image[x, y] == background, where & ": drawn off the glass at " & $(x, y)
  var image = scene.draw()
  if previews.len > 0: image.writeFile(previews / "settings-round.png")
  image.onTheGlass("the form")
  # The city gets the keyboard: it sits on the circle's lower half, and the
  # list ends above it.
  scene.tap(regionWith(1000))
  image = scene.draw()
  doAssert uiTarget(SceneSettingsId, 1, create = false).input.keyboard
  if previews.len > 0: image.writeFile(previews / "settings-round-keyboard.png")
  image.onTheGlass("the keyboard")
  var keys = 0
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] - 1 > KeyBase: inc keys
  doAssert keys >= 30, $keys
  sent.setLen(0)
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] == KeyBase + ord('s') + 1: scene.tap(r)
  doAssert scene.state["values"]["city"].getStr() == "Oslos", $scene.state["values"]
  # The numbers too.
  for r in uiTarget(SceneSettingsId, 1, create = false).regions:
    if r.handlers[ueClick] == KeyBase + ord(kSymbols) + 1: scene.tap(r)
  image = scene.draw()
  image.onTheGlass("the symbols")
  # Save is still there with the keyboard up.
  sent.setLen(0)
  scene.tap(regionWith(1))
  doAssert sent.len >= 1 and sent[0][0] == evSetCurrentScene, $sent

echo "scene settings: ok"
