## The scene's settings, `system/sceneSettings` (docs/scene-settings.md): the
## public fields of the scene it was opened from, as a form to change and
## save. A swipe down from the top of a touch screen opens it (the frame's
## event map: `edgeSwipe {edge: top}` emits `sceneSettings`).
##
## Built into every runtime, as the scene switcher is, and shown like any
## scene. `sceneSettings` (docs/events-contract.json) opens it, and the
## dispatcher (event_loop.nim) hands it `state.from`, the scene's fields and
## their values, read before the switch: an ESP32 holds one scene, and the
## one the panel covers is gone while it shows. Save is a `setCurrentScene`
## back to `from` with the values as its state, which every host applies to
## the scene's public fields when it is back. Cancel, the swipe again and
## the idle timeout dispatch `sceneSettings`, which goes back without them,
## as `sceneSwitcher` (a swipe up from the bottom) does.
##
## Drawn with the JSX layout (ui/layout.nim) from a tree built here in Nim,
## with the layout's fields, the keyboard on the screen and a list that
## scrolls: no QuickJS. On a round panel (frameos/panel_shape.nim) the name,
## Cancel and Save sit in the top arc and the list is as wide as the circle
## lets it be, as the switcher's tiles are (a HyperPixel Round, the Waveshare
## 1.75" AMOLED), a gear between them, and the frame page is the square
## panel's page in the square inside the circle. Flash is the budget on an ESP32 (AGENTS.md): one
## handler for everything (numbered), classes appended in place, and no Nim
## checks in this module (every index is guarded by its loop): JSON arrays
## are read through `elems` once their kind is known, since json's `[]` and
## `items` bring their own asserts in with them.

import std/[json, math, options, parseutils, strutils, tables, times]
import pixie
import pixie/fileformats/svg
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/panel_shape
import frameos/render_scale
import frameos/ui/layout
from frameos/scene_rhythm import builtInRunner, rhythmMarkDue
from frameos/event_loop import settingsOf
import frameos/layout_choice
import frameos/ui/events
import frameos/ui/keyboard
import frameos/frame_settings_hooks
export frame_settings_hooks
import frameos/frame_service_keys
import frameos/scene_store_hooks
from frameos/service_keys import setLocalKey
import frameos/ui/theme
import frameos/ui/tree
import frameos/utils/image
import frameos/utils/qr
import frameos/utils/svg_frames
from frameos/utils/asset_colors import panelShowsColor
import system/sceneSwitcher/scene as switcher

{.push overflowChecks: off, rangeChecks: off, boundChecks: off, fieldChecks: off, stackTrace: off,
  lineTrace: off.}

type
  SceneSettingsScene* = SceneSwitcherScene
    ## The switcher's own type, its `entries` unused, `paper` and `slow` the panel's:
    ## one set of destroy and trace hooks in flash for the two built-in scenes.

const
  SettingsNode = 1 ## the ui/events target its form lives in
  IdleSeconds* = 300.0
    ## How long it waits for a touch or a key before it goes back unsaved:
    ## five minutes, as long as an ESP32 that deep-sleeps stays up for it
    ## (fos_scenes.c BUILT_IN_SCENE_AWAKE_MS).
  # What a handler number means: Cancel (Back on the frame page), Save, the
  # gear, then per field (by its index in the page's fields) a field's text,
  # a switch or a select box's pick, and the frame page's buttons.
  HCancel = 0
  HSave = 1
  HGear = 2
  HCode = 3
  HText = 1000
  HToggle = 2000
  HShow = 3000 ## + field: a secret field's eye, what is typed shown or hidden
  HSelect = 13000 ## + field: a select box's pick
  HAction = 20000 ## + one of the buttons below
  AScan = 0
  ARender = 1
  ARestart = 2
  AReboot = 3
  ALayout = 4
  ACheckUpdate = 5
  AInstallUpdate = 6
  AUpdateScenes = 7
  ALinkCloud = 8 ## a FrameOS Cloud link code (the host's `linkCloud`)
  AAdopt = 9 ## an adoption code for a backend (the host's `adopt`)
  ACancelLink = 10 ## either one, while it is pending
  AAddress = 11 ## the cloud's address, to change while its code shows
  AUnlink = 12 ## asks whether to leave the plane that manages the frame
  AUnlinkNow = 13 ## leaves it (the host's `unlink`), on a second tap
  ACancelUnlink = 14 ## back from asking, nothing done
  AKeys = 15 ## the service keys typed on the frame (frame_service_keys.nim), on a page of their own
  # The host's `updateState` (fos_ota_check_t): the words are the page's.
  UpdateChecking = 1
  UpdateAvailable = 3
  UpdateInstalling = 5
  UpdateWords = ["", "Checking\xe2\x80\xa6", "Up to date", "", "Could not check", "Installing\xe2\x80\xa6"]
  OtherValue = "\1" ## a select box's `other` option; no value of its own is this
  HeadingValue = "\2" ## a group's name in a select box's list: picks nothing
  # The types the panel cannot edit: what they hold is not text.
  Unedited = ["node", "scene", "image"]
  # The scales offered (frontend/src/utils/renderScale.ts RENDER_SCALE_STEPS).
  Scales = ["0.25", "0.5", "0.75", "1", "1.25", "1.5", "2", "2.5", "3", "4"]
  # Two angle brackets, the code editor's button, 48 units square as the gear is.
  CodePath = "M29.2 33.2 38.4 24 29.2 14.8 32 12l12 12-12 12zM18.8 33.2 9.6 24l9.2-9.2L16 12 4 24l12 12z"
  CodeEditorId = "code-editor"
  CodeEditorName = "Code editor"
  # A circle with an arrow, 48 units square as the gear is (switcher.gearPath).
  RefreshPath = "M24 8a16 16 0 1 0 16 16h-5a11 11 0 1 1-11-11v6l10-8.5L24 2Z"
  # An eye, 48 units square: its white winds against its outline, the pupil in it.
  EyePath = "M2 24Q24 0 46 24Q24 48 2 24ZM7 24Q24 40 41 24Q24 8 7 24ZM24 17a7 7 0 1 1 0 14a7 7 0 1 1 0-14Z"
  # wifiLine's words, by the host's `state`.
  WifiStates = ["connected", "hotspot", "notFound", "auth", "connecting", "unset"]
  WifiBefore = ["Connected to ", "Setup hotspot ", "Can't find ", "Wrong password for ", "Connecting to "]
  WifiAfter = ["", "", "", "?", "\xe2\x80\xa6"]
  # The service keys the page offers: every field a control plane sends
  # (apps.nim CloudServiceSettingsFields, which test_scene.nim holds this to).
  # A field named `url` is the one that is no secret.
  ServiceKeys* = [("openAI", "apiKey", "OpenAI API key"), ("unsplash", "accessKey", "Unsplash access key"),
    ("homeAssistant", "url", "Home Assistant URL"), ("homeAssistant", "accessToken", "Home Assistant access token"),
    ("immich", "url", "Immich server URL"), ("immich", "apiKey", "Immich API key"),
    ("github", "api_key", "GitHub API key"), ("frameOS", "apiKey", "FrameOS Gallery API key")]
  KeysNote = "A key typed here stays on this frame and is used instead of the one its control plane " &
    "sends. An address typed here is sent only keys typed here. Empty a field to remove its key."

var
  # What the last handler did: its number and the text it carried. Read by
  # runEvent once the hit test is done, so the handler holds nothing.
  acted {.threadvar.}: int
  actedText {.threadvar.}: string

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  ## `node[key] = value` for an object node, without json's assert.
  node.fields[key] = value

proc str(node: JsonNode, key: string): string {.noinline.} =
  ## `node{key}.getStr()`, "" for a node or key that is not there: one call
  ## where the page reads a text, not two and a reference let go (flash).
  node{key}.getStr()

# ------------------------------------------------------------------ values

proc onSubPage(self: SceneSettingsScene): bool =
  ## A page of the frame page's that is a form of its own: the layout's
  ## settings, the service keys.
  self.state.str("page") in ["layout", "keys"]

proc form(self: SceneSettingsScene): JsonNode =
  ## What the page's fields live in: a sub-page's own, else the scene's.
  result = if self.onSubPage(): self.state{"pageForm"} else: self.state

proc fieldList(self: SceneSettingsScene): JsonNode =
  result = self.form(){"fields"}
  if result.isNil or result.kind != JArray:
    result = newJArray()

proc objectAt(self: SceneSettingsScene, key: string): JsonNode =
  result = self.state{key}
  if result.isNil or result.kind != JObject:
    result = newJObject()
    self.state.put(key, result)

proc formObject(self: SceneSettingsScene, key: string): JsonNode =
  let form = self.form()
  result = form{key}
  if result.isNil or result.kind != JObject:
    result = newJObject()
    form.put(key, result)

proc valueMap(self: SceneSettingsScene): JsonNode =
  self.formObject("values")

proc arrayOf(node: JsonNode): JsonNode =
  if node.isNil or node.kind != JArray: newJArray() else: node

proc frameInfo(): JsonNode =
  ## What the host says about the frame now; nil when it offers no page.
  if not frameSettingsRead.isNil:
    result = frameSettingsRead()
    if not result.isNil and result.kind != JObject:
      result = nil

proc onFrame(self: SceneSettingsScene): bool =
  self.state.str("page") == "frame"

proc onLayoutPage(self: SceneSettingsScene): bool =
  self.state.str("page") == "layout"

proc onKeysPage(self: SceneSettingsScene): bool =
  self.state.str("page") == "keys"

proc showName(self: SceneSettingsScene, name: string) =
  ## What a layout around it calls this page.
  self.shownName = name
  if not self.wornLayout.isNil:
    self.wornLayout.shownName = name
    rhythmMarkDue(self.wornLayout)

proc openedOnFrame(self: SceneSettingsScene): bool =
  ## Opened straight on the frame page (`sceneSettings {page: "frame"}`): Back
  ## goes to the scene, not by way of its form.
  self.state.str("opened") == "frame"

proc frameAction(action: string) =
  if not frameSettingsAction.isNil:
    frameSettingsAction(action)

proc sceneUpdates(asker: string): tuple[listed, movable: int, busy: bool] =
  ## The store scenes on the frame with a newer version, as the scene store's
  ## host has them from the control plane (docs/scene-store.md "What has
  ## updates"): how many, how many the frame may take itself, and whether it
  ## takes them now. `listed` is -1 where nothing is known (no plane, no host).
  result.listed = -1
  let read = sceneStoreRead
  if read.isNil:
    return
  try:
    let
      facts = parseJson(read(asker))
      updates = facts{"updates"}
    result.busy = facts.str("busy") == "updateAll"
    if not updates.isNil and updates.kind == JArray:
      result.listed = updates.len
      for row in updates.elems:
        if not row{"owner"}.getBool():
          inc result.movable
  except CatchableError:
    discard

template uiId(self: SceneSettingsScene): string =
  ## Its UI's target (ui/events.nim): one a scene where built-in scenes stay
  ## open as windows, each instance its own.
  self.id.string

proc ownWindow(self: SceneSettingsScene): bool =
  ## A scene's own settings on a desktop (event_loop.settingsWindows): its
  ## gear brings the frame page's window forward instead of turning its page.
  builtInScenesStay and self.id.string != SceneSettingsId

proc panelWindow(self: SceneSettingsScene): bool =
  ## The frame page's window on a desktop (Control Panel): no gear back to a
  ## scene's form, whose settings have windows of their own.
  builtInScenesStay and self.id.string == SceneSettingsId

proc showPage(self: SceneSettingsScene, frame: bool) =
  ## The scene's form or the frame page, its list at the top and no field
  ## with the keyboard. The host hears the frame page come up (a scan, on a
  ## frame that is not on Wi-Fi) and go away (no more redraws for its news).
  forgetUiTarget(self.uiId, SettingsNode)
  if self.onFrame() and not frame:
    frameAction("close")
  self.state.put("page", newJString(if frame: "frame" else: "scene"))
  self.state.put("confirm", newJInt(-1))
  self.showName(if frame: "Frame settings" else: "Scene settings")
  if frame:
    frameAction("open")

proc current(edits, info: JsonNode, name: string): JsonNode =
  ## A frame field's value: as changed on the page, else as the host has it.
  result = edits{name}
  if result.isNil:
    result = if name == "wifiSsid": info{"wifi", "ssid"}
      elif name == "cloudUrl": info{"link", "server"}
      else: info{name}

proc text(value: JsonNode): string =
  ## A value as the text a field shows: a string as it is, a whole number
  ## without its ".0", anything else as JSON writes it.
  if value.isNil or value.kind == JNull: ""
  elif value.kind == JString: value.getStr()
  elif value.kind == JFloat and value.getFloat() == float(int(value.getFloat())): $int(value.getFloat())
  else: $value

proc isOn(value: JsonNode): bool =
  if value.isNil: false
  elif value.kind == JBool: value.getBool()
  else: value.text in ["true", "1", "yes", "on"]

proc saved(field, value: JsonNode): JsonNode =
  ## A value as the scene's state holds its field: a number for a number, a
  ## boolean for a switch, else the text (a json field's text the scene
  ## parses). nil when there is no value, or a number field holds no number:
  ## that one is not saved.
  if value.isNil:
    return nil
  let kind = field.str("type")
  let text = value.text.strip()
  var
    whole: int
    number: float
  if kind == "boolean": newJBool(value.isOn)
  elif kind == "integer":
    if text.len > 0 and parseInt(text, whole) == text.len: newJInt(whole) else: nil
  elif kind == "float":
    if text.len > 0 and parseFloat(text, number) == text.len: newJFloat(number) else: nil
  else: newJString(value.text)

# -------------------------------------------------------- the frame page

proc quoted(name: string): string =
  "\xe2\x80\x9c" & name & "\xe2\x80\x9d"

proc wifiLine(wifi: JsonNode): string =
  ## How the frame is doing on Wi-Fi, in words.
  let i = WifiStates.find(wifi.str("state"))
  if i < 0: "Not connected"
  elif i == WifiBefore.len: "Not set up"
  else: WifiBefore[i] & quoted(wifi.str(if i == 1: "hotspot" else: "ssid")) & WifiAfter[i]

proc field(name, label, kind: string): JsonNode =
  result = newJObject()
  result.put("name", newJString(name))
  result.put("label", newJString(label))
  result.put("type", newJString(kind))

proc option(value, label: string): JsonNode =
  result = newJObject()
  result.put("value", newJString(value))
  result.put("label", newJString(label))

const ClickSounds = [("silent", "Silent"), ("normal", "Normal")]
  ## Tap and click sounds, by the names every wire uses (an ESP32's
  ## fos_config.h keeps them as FOS_CLICK_SOUNDS_*): a new mode is one more
  ## entry here and its name on the host.

const AwakeAfterInput = [("0", "Sleep as soon as it can"), ("60", "1 minute"), ("300", "5 minutes"),
                         ("600", "10 minutes"), ("1800", "30 minutes")]
  ## How long a tap keeps a deep-sleeping frame up, in seconds: the web app's
  ## Power choices (PowerSettingsFields.tsx), with the frame's own value
  ## added when it is none of them.

proc scaleLabel(scale: string): string =
  scale & "\xc3\x97"

proc scaleText(scale: float): string =
  ## A scale in quarters as the options spell it: 1, 1.25, 1.5, 2.
  let quarters = int(scale * 4.0 + 0.5)
  result = $(quarters div 4)
  case quarters mod 4
  of 1: result.add ".25"
  of 2: result.add ".5"
  of 3: result.add ".75"
  else: discard

proc frameLayout(self: SceneSettingsScene): FrameScene =
  ## The layout instance the frame wears: the one around this page, or, drawn
  ## in a window beside the scene with the focus, the one around that scene
  ## (on a desktop the one instance goes along with the focus).
  result = self.wornLayout
  if result.isNil and not frameLayoutShown.isNil:
    result = frameLayoutShown()

proc heldLayout*(self: SceneSettingsScene, layouts: seq[LayoutEntry]): string =
  ## What the Layout select holds: the frame's layout whatever has the focus,
  ## the one this page wears while it has it (from the frame's choice and the
  ## scene it was opened from), or `NoLayout` for one not among `layouts`.
  ## Read off the instance it wore, the page in a window beside the focus said
  ## "No layout" (the Windows 98 Control Panel, 2026-11-17).
  let shown = layoutFor(self.state{"layout", "sceneId"}.getStr())
  result = NoLayout
  for i in 0 ..< layouts.len:
    if layouts[i].id == shown:
      result = shown

proc layoutField(self: SceneSettingsScene, info: JsonNode): JsonNode =
  ## The layout the frame shows its scenes in, its gear beside it for one with
  ## settings. nil for a frame with no layouts on it. Grouped as the store
  ## shelves them (`layoutGroup`: the category, else Multi app layouts or
  ## Single app layouts by kind), the groups by name and each by name, under a
  ## heading each when there is more than one group.
  let layouts = layoutsInOrder(if layoutListing.isNil: @[] else: layoutListing())
  if layouts.len == 0:
    return nil
  result = field("layout", "Layout", "string")
  let options = newJArray()
  if chosenLayout().len > 0:
    options.elems.add option("", "As each scene says")
  options.elems.add option(NoLayout, "No layout")
  let grouped = cmpIgnoreCase(layouts[0].layoutGroup, layouts[^1].layoutGroup) != 0
  for i in 0 ..< layouts.len:
    let group = layouts[i].layoutGroup
    if grouped and (i == 0 or cmpIgnoreCase(group, layouts[i - 1].layoutGroup) != 0):
      let heading = option(HeadingValue, group)
      heading.put("heading", newJBool(true))
      options.elems.add heading
    options.elems.add option(layouts[i].id, layouts[i].name)
  result.put("options", options)
  let held = self.heldLayout(layouts)
  info.put("layout", newJString(held))
  let worn = self.frameLayout()
  if not worn.isNil and worn.id.string == held and InterpretedFrameScene(worn).publicStateFields.len > 0:
    result.put("button", newJInt(ALayout))

proc frameFields(self: SceneSettingsScene, info: JsonNode, autoScale: string, unit = 0): JsonNode =
  ## The page's fields, in the shape of a scene's, from the host's facts:
  ## the network (those in range, the saved one first when it is not among
  ## them, and a name to type), its password, the rotation and the scale.
  ## The scales offered leave a layout of 320 px or more on the panel's
  ## shorter edge `unit` (uiScale's floor: past it the page itself stops
  ## following), and the scale set elsewhere stays as it is. While a plane is
  ## being connected, that page's own: the cloud's address, or none.
  result = newJArray()
  let link = info{"link"}
  if not link.isNil and link.kind == JObject:
    if link.str("to") == "cloud":
      result.elems.add field("cloudUrl", "Cloud address", "string")
    return
  let wifi = info{"wifi"}
  if not wifi.isNil and wifi.kind == JObject:
    let
      saved = wifi.str("ssid")
      networks = arrayOf(wifi{"networks"})
      network = field("wifiSsid", "Wi-Fi network", "string")
      options = newJArray()
    var listed = saved.len == 0
    for i in 0 ..< networks.elems.len:
      if networks.elems[i].getStr() == saved:
        listed = true
    if not listed:
      options.elems.add newJString(saved)
    for i in 0 ..< networks.elems.len:
      if networks.elems[i].kind == JString:
        options.elems.add networks.elems[i]
    network.put("select", newJBool(true))
    network.put("other", newJString("Other network\xe2\x80\xa6"))
    network.put("otherPlaceholder", newJString("Network name"))
    network.put("placeholder", newJString("Choose a network"))
    network.put("options", options)
    network.put("button", newJInt(AScan))
    result.elems.add network
    let password = field("wifiPassword", "Password", "string")
    password.put("secret", newJBool(true))
    password.put("placeholder", newJString(
      if wifi{"password"}.getBool(): "Saved (type to change)" else: "Password"))
    result.elems.add password
  let layout = self.layoutField(info)
  if not layout.isNil:
    result.elems.add layout
  var
    rotate = field("rotate", "Rotation", "integer")
    options = newJArray()
  for angle in ["0", "90", "180", "270"]:
    options.elems.add option(angle, angle & "\xc2\xb0")
  rotate.put("options", options)
  result.elems.add rotate
  var scale = field("renderScale", "Scale", "float")
  options = newJArray()
  options.elems.add option("0", "Automatic (" & scaleLabel(autoScale) & ")")
  let held = info{"renderScale"}.text
  for step in Scales:
    if unit == 0 or parseFloat(step) * 320 <= max(unit, 320).float or step == held:
      options.elems.add option(step, scaleLabel(step))
  scale.put("options", options)
  result.elems.add scale
  if not info{"clickSounds"}.isNil:
    # Only a frame that makes them (a buzzer, a speaker, an LED that follows
    # them): the host says so by handing the mode over.
    var sounds = field("clickSounds", "Tap and click sounds", "string")
    options = newJArray()
    for (value, label) in ClickSounds:
      options.elems.add option(value, label)
    sounds.put("options", options)
    result.elems.add sounds
  if not info{"awakeAfterInputSeconds"}.isNil:
    # Only a frame that deep-sleeps: the host says so by handing it over.
    var awake = field("awakeAfterInputSeconds", "Stay awake after a press or tap", "integer")
    options = newJArray()
    let seconds = $info{"awakeAfterInputSeconds"}.getInt(300)
    var listed = false
    for (value, label) in AwakeAfterInput:
      options.elems.add option(value, label)
      if value == seconds:
        listed = true
    if not listed:
      options.elems.add option(seconds, seconds & " seconds")
    awake.put("options", options)
    result.elems.add awake
  if not info{"clock"}.isNil:
    # An ESP32's clock, set by hand where no network time reaches it.
    let clock = field("clock", "Date and time", "string")
    clock.put("placeholder", newJString("YYYY-MM-DD HH:MM"))
    result.elems.add clock

proc opener(self: SceneSettingsScene): string =
  self.state.str("from")

var wentBack {.threadvar.}: bool
  ## It went back by itself (Save, Cancel, its timeout), not merely lost the
  ## focus to a window beside it: its "close" ends it (docs/scene-layouts.md
  ## "Windows").

proc codeEditor(): string =
  ## The code editor's scene id where the frame holds it (docs/code-editor.md):
  ## the sample's id, else its name, as a plane may have given a copy another
  ## id. "" without one.
  for entry in listEntries():
    if entry.id == CodeEditorId:
      return CodeEditorId
    if result.len == 0 and entry.name == CodeEditorName:
      result = entry.id

proc codeOf(self: SceneSettingsScene, editor: string): string =
  ## The scene the header's code button opens in the code editor `editor`:
  ## on the layout's page the layout's, on the scene's and the frame's the
  ## scene's it was opened from. "" for none: no editor, a built-in scene,
  ## or the editor itself (open on it already).
  if editor.len == 0:
    return ""
  if self.onLayoutPage():
    let worn = self.frameLayout()
    if not worn.isNil:
      result = worn.id.string
  else:
    result = self.opener()
  if result == editor or isBuiltInScene(result):
    result = ""

proc leave() =
  ## Back to the scene it was opened from, nothing saved: the dispatcher
  ## knows which.
  wentBack = true
  sendEvent(evSceneSettings, newJObject(), eoScene)

proc goTo(sceneId: string, state: JsonNode) =
  ## To `sceneId`, its public fields set to `state`, as a Save goes back.
  let payload = newJObject()
  payload.put("sceneId", newJString(sceneId))
  payload.put("state", state)
  wentBack = true
  sendEvent(evSetCurrentScene, payload, eoScene)

const
  KeyField = "\1" ## + service.field: a key of the scene's, typed on the frame (docs/service-keys.md)
  ForgetField = "\2" ## + service: forget what was typed for it

proc addKeyFields(self: SceneSettingsScene, rows: JsonNode) =
  ## The scene's keys under its fields (service_keys.keyRows): each a field
  ## to type a new one in, its placeholder what it holds now, never a whole
  ## secret; and a switch to forget what was typed here.
  var fields = self.state{"fields"}
  if fields.isNil or fields.kind != JArray:
    fields = newJArray()
    self.state.put("fields", fields)
  let values = self.valueMap()
  for row in arrayOf(rows).elems:
    let
      service = row.str("service")
      title = row.str("title")
    for f in arrayOf(row{"fields"}).elems:
      let
        name = KeyField & service & "." & f.str("name")
        value = f.str("value")
        entry = field(name, title & " " & f.str("label"), "string")
      if f{"secret"}.getBool():
        entry.put("secret", newJBool(true))
        entry.put("placeholder", newJString(if value.len == 0: "Not set" else: value))
      elif value.len > 0:
        values.put(name, newJString(value))
      fields.elems.add entry
    if row{"typed"}.getBool():
      fields.elems.add field(ForgetField & service, "Forget the " & title & " key typed here", "boolean")

proc saveKeys(self: SceneSettingsScene): JsonNode =
  ## The keys typed on the form, kept on this frame for the scene, and the
  ## scene's own fields without them.
  let
    edited = self.formObject("edited")
    values = self.valueMap()
    scene = self.opener()
  result = newJArray()
  for f in self.fieldList().elems:
    let name = f.str("name")
    if name.startsWith(KeyField):
      let dot = name.find('.')
      if edited.hasKey(name) and dot > 1:
        discard setLocalKey(scene, name[1 ..< dot], name[dot + 1 .. ^1], values{name}.text.strip())
    elif name.startsWith(ForgetField):
      if values{name}.isOn:
        discard setLocalKey(scene, name[1 .. ^1], "", "")
    else:
      result.elems.add f

proc collect(fields, values: JsonNode): JsonNode =
  ## The values of `fields` as their owner keeps them (`saved`), by name.
  result = newJObject()
  for i in 0 ..< fields.elems.len:
    let field = fields.elems[i]
    let name = field.str("name")
    let value = field.saved(values{name})
    if not value.isNil:
      result.put(name, value)

proc save(self: SceneSettingsScene) =
  ## Back to the scene, its fields set to the values here. A scene's own
  ## settings window on a desktop stays instead, as an Apply would: the values
  ## go to the scene where it runs, in its window (`setSceneState` aimed at
  ## it), and the window keeps the focus, its Save quiet until the next edit.
  if self.opener().len == 0:
    leave()
    return
  let values = collect(self.saveKeys(), self.valueMap())
  if self.ownWindow():
    let payload = newJObject()
    payload.put("state", values)
    sendEvent(some(SceneId(self.opener())), evSetSceneState, payload, eoScene)
    self.formObject("edited").fields.clear()
    sendEvent(evRender, newJObject(), eoScene)
    return
  goTo(self.opener(), values)

proc saveFrame(self: SceneSettingsScene, fields: JsonNode) =
  ## The frame page's Save: what was edited there to the host, which applies
  ## what differs from what it has (Wi-Fi joins in the background, the scale
  ## is drawn at once, a rotation restarts the frame) and takes a password
  ## alone for the saved network. The page stays up so what it did shows.
  let changes = collect(fields, self.objectAt("frameValues"))
  self.state.put("frameValues", newJObject())
  self.state.put("address", newJBool(false))
  # A new rotation restarts the frame (the canvas is sized when it starts:
  # fos_frame_settings.c, frame_settings_linux.nim), and the page says so
  # until then: a reTerminal Sticky going blank for ten seconds after Save
  # looked like a crash (2026-11-22).
  let rotate = changes{"rotate"}
  let before = frameInfo()
  if not rotate.isNil and not before.isNil and rotate.getInt(-1) != before{"rotate"}.getInt(-1):
    self.state.put("restarting", newJBool(true))
  let layout = changes{"layout"}
  if not layout.isNil:
    # The frame's own to keep: no host setting.
    chooseLayout(layout.getStr())
    changes.delete("layout")
  if changes.len > 0 and not frameSettingsApply.isNil:
    forgetUiTarget(self.uiId, SettingsNode)
    frameSettingsApply(changes)

proc openSubPage(self: SceneSettingsScene, page, name: string, form: JsonNode) =
  self.state.put("pageForm", form)
  forgetUiTarget(self.uiId, SettingsNode)
  frameAction("close")
  self.state.put("page", newJString(page))
  self.showName(name)

proc openLayoutPage(self: SceneSettingsScene) =
  ## The settings of the layout showing, on a page of their own.
  let worn = self.frameLayout()
  if worn.isNil:
    return
  let form = newJObject()
  settingsOf(worn, form)
  self.openSubPage("layout", "Layout settings", form)

proc openKeysPage(self: SceneSettingsScene) =
  ## The service keys (docs/scene-settings.md "Service keys"): one field
  ## each, holding what was typed on the frame, a secret behind its eye. What
  ## a plane sent is said in the field's placeholder, a secret's never shown.
  let
    form = newJObject()
    fields = newJArray()
    values = newJObject()
    typed = serviceKeysTyped()
    sent = self.frameConfig.settings
  for i in 0 ..< ServiceKeys.len:
    # A field by its label, which no two keys share. The table's strings as
    # they are, not copies (flash).
    template group: untyped = ServiceKeys[i][0]
    template name: untyped = ServiceKeys[i][1]
    template label: untyped = ServiceKeys[i][2]
    let
      f = field(label, label, "string")
      given = sent{group, name}.getStr()
      secret = name != "url"
      own = typed{group, name}
    if secret:
      f.put("secret", newJBool(true))
    f.put("placeholder", newJString(if given.len == 0: "Not set"
      elif secret: "Saved (type to change)" else: given))
    if not own.isNil:
      values.put(label, own)
    fields.elems.add f
  form.put("fields", fields)
  form.put("values", values)
  self.openSubPage("keys", "Service keys", form)

proc saveKeysPage(self: SceneSettingsScene) =
  ## The keys edited here, kept by the host (frame_service_keys.nim): an
  ## emptied one goes. The log says which, never a value.
  let edited = self.formObject("edited")
  var names = ""
  for i in 0 ..< ServiceKeys.len:
    template label: untyped = ServiceKeys[i][2]
    if not edited{label}.isNil:
      typeServiceKey(ServiceKeys[i][0], ServiceKeys[i][1], self.valueMap().str(label).strip())
      if names.len > 0: names.add ", "
      names.add label
  if names.len > 0 and keepServiceKeys():
    self.logger.log(%*{"event": "settings:frame:keys", "keys": names})
  self.showPage(true)

proc saveLayoutPage(self: SceneSettingsScene) =
  ## Kept on the frame under the layout's id, and on the bar at once.
  let worn = self.frameLayout()
  let values = collect(self.fieldList(), self.valueMap())
  if not worn.isNil and values.len > 0:
    saveLayoutState(worn.id.string, values)
    for key, value in values.pairs:
      worn.state.put(key, value)
    rhythmMarkDue(worn)
  self.showPage(true)

proc press(self: SceneSettingsScene, action: int) =
  ## One of the frame page's buttons. Restart and Reboot ask twice: the
  ## first tap turns the button into "Tap again", the second sends the
  ## device command (docs/events-contract.json, origin `panel`), which the
  ## host runs as it runs a schedule's.
  var asking = -1
  if action == AScan:
    frameAction("scan")
  elif action == ACheckUpdate:
    frameAction("checkUpdate")
  elif action >= ALinkCloud and action <= ACancelLink:
    # The host's own words for them, in the order of the numbers.
    self.state.put("address", newJBool(false))
    frameAction(["linkCloud", "adopt", "cancelLink"][action - ALinkCloud])
  elif action == AAddress:
    self.state.put("address", newJBool(true))
  elif action == AUnlink or action == ACancelUnlink:
    self.state.put("unlinking", newJBool(action == AUnlink))
  elif action == ALayout:
    self.openLayoutPage()
  elif action == AKeys:
    self.openKeysPage()
  elif action == ARender:
    sendEvent(evRender, newJObject(), eoPanel)
  elif self.state{"confirm"}.getInt(-1) == action:
    if action == AInstallUpdate:
      frameAction("installUpdate")
    elif action == AUnlinkNow:
      self.state.put("unlinking", newJBool(false))
      frameAction("unlink")
    elif action == AUpdateScenes:
      if not sceneStoreAction.isNil:
        sceneStoreAction(self.uiId, "updateAll", "{}")
    else:
      sendEvent(if action == ARestart: evRestart else: evReboot, newJObject(), eoPanel)
  else:
    asking = action
  self.state.put("confirm", newJInt(asking))

proc acting(self: SceneSettingsScene) =
  ## What the last handler did, to the values of the page showing.
  let
    frame = self.onFrame()
    info = if frame: frameInfo() else: nil
    handler = acted
  acted = -1
  if frame and info.isNil:
    # Turned off while it showed: the scene's form, the frame's values gone.
    self.showPage(false)
    return
  let
    fields = if frame: self.frameFields(info, "") else: self.fieldList()
    values = if frame: self.objectAt("frameValues") else: self.valueMap()
  if handler < HAction:
    self.state.put("confirm", newJInt(-1))
  if handler == HCancel:
    if self.onSubPage(): self.showPage(true)
    elif frame and self.state{"unlinking"}.getBool():
      self.state.put("unlinking", newJBool(false))
    elif frame and not info{"link"}.isNil:
      # Back from connecting a plane is to the frame page: the link ends.
      self.state.put("frameValues", newJObject())
      self.press(ACancelLink)
    elif frame and not self.openedOnFrame(): self.showPage(false)
    else: leave()
  elif handler == HSave:
    if self.onKeysPage(): self.saveKeysPage()
    elif self.onLayoutPage(): self.saveLayoutPage()
    elif frame: self.saveFrame(fields)
    else: self.save()
  elif handler == HCode:
    # The scene's code (the layout's, on its page) in the code editor, which
    # opens on it (its public field `open`, set as a Save sets the scene's).
    let editor = codeEditor()
    let code = self.codeOf(editor)
    if code.len > 0:
      let state = newJObject()
      state.put("open", newJString(code))
      goTo(editor, state)
  elif handler == HGear:
    if self.ownWindow():
      # The frame page has a window of its own: it comes forward.
      sendEvent(evSceneSettings, %*{"page": "frame"}, eoScene)
    else:
      # Lit on the frame's page and its sub-pages: back to the scene's form.
      self.showPage(not frame and not self.onSubPage())
  elif handler >= HAction:
    self.press(handler - HAction)
  elif handler >= HShow and handler < HSelect:
    # A secret field's eye: what is typed in it shown, or hidden again.
    let index = handler - HShow
    if index < fields.elems.len:
      let name = fields.elems[index].str("name")
      self.state.put("shown", newJString(if self.state.str("shown") == name: "" else: name))
  elif handler >= HSelect:
    let index = handler - HSelect
    if index < fields.elems.len and actedText != HeadingValue:
      let
        field = fields.elems[index]
        other = actedText == OtherValue
      values.put(field.str("name"), newJString(if other: "" else: actedText))
      if not frame:
        self.formObject("edited").put(field.str("name"), newJBool(true))
      # Beside the values, on a field that has an `other`: the frame page's,
      # whose names it knows, never a scene's, which could be called anything.
      if field.str("other").len > 0:
        values.put("typing", newJBool(other))
  else:
    let
      index = if handler >= HToggle: handler - HToggle else: handler - HText
    if index >= 0 and index < fields.elems.len:
      let field = fields.elems[index]
      let name = field.str("name")
      if handler >= HToggle:
        values.put(name, newJBool(not values{name}.isOn))
      else:
        values.put(name, newJString(actedText))
      if not frame:
        self.formObject("edited").put(name, newJBool(true))
  self.touch()

proc onHandler(handler: int, name: string, event: JsonNode, hit: UiHit) {.raises: [].} =
  ## The form's one handler, run by the hit test (ui/events.nim): what it
  ## was and a field's text, for `acting` once the hit test is done.
  acted = handler
  actedText = event.str("value")

# --------------------------------------------------------------- the picture
#
# As in the scene switcher: class names appended in place, one call each, and
# a class that depends on something in a branch of its own. `move` hands a
# string on: Nim 2.2.4 passes a plain one to a sink without clearing it, and
# the next assignment would free what the node holds.

proc on(node: sink SvgNode, attr: string, handler: int): SvgNode =
  node.attrs.add((attr, $handler))
  node

type Look = object
  paper: bool
  size, pad, gap, line: int

proc button(look: Look, label: string, handler: int, primary: bool): SvgNode =
  var c = "shrink-0 flex items-center rounded-full font-bold"
  c.px("h", look.line * 4 div 5)
  c.px("px", look.size)
  if look.paper: c.add " border-2 border-black"
  elif primary: c.add " bg-sky-600 active:bg-sky-500"
  else: c.add " bg-zinc-800 active:bg-zinc-600"
  el("div", move c, SvgNode(text: label)).role(if primary: "primary" else: "button").on("on-click", handler)

proc icon(look: Look, path: string, side = 0): SvgNode =
  # The hole winds against the teeth: the default fill rule cuts it out.
  let path = SvgNode(tag: "path", attrs: @[("d", path), ("fill", "currentColor")])
  let side = if side > 0: side else: look.size * 6 div 5
  var i = ""
  i.px("w", side)
  i.px("h", side)
  result = el("svg", move i, path)
  result.attrs.add(("viewBox", "0 0 48 48"))

proc iconButton(look: Look, lit: bool, path: string, handler: int, wide = false): SvgNode =
  ## A round button with a picture on it; `wide`, the header's: half as wide
  ## again as it is tall, its picture larger, easy to hit with a thumb.
  var c = "shrink-0 flex items-center justify-center rounded-full"
  c.px("h", look.line * 4 div 5)
  c.px("w", if wide: look.line * 6 div 5 else: look.line * 4 div 5)
  if look.paper: c.add(if lit: " bg-black text-white" else: " border-2 border-black")
  elif lit: c.add " bg-sky-600 active:bg-sky-500"
  else: c.add " bg-zinc-800 active:bg-zinc-600"
  el("div", move c, look.icon(path, if wide: look.size * 3 div 2 else: 0)).role(
    if lit: "selected" else: "button").on("on-click", handler)

proc gear(look: Look, lit, named: bool): SvgNode =
  ## The gear that opens the frame page, lit while it or the layout's page
  ## shows, with its name beside it where the header has the room.
  if not named:
    return look.iconButton(lit, gearPath(), HGear, wide = true)
  var c = "shrink-0 flex items-center rounded-full font-bold"
  c.px("h", look.line * 4 div 5)
  c.px("px", look.size)
  c.px("gap", look.size div 2)
  if look.paper: c.add " border-2 border-black"
  else: c.add " bg-zinc-800 active:bg-zinc-600"
  result = el("div", move c, look.icon(gearPath(), look.size * 3 div 2)).on("on-click", HGear)
  result.children.add el("span", "whitespace-nowrap", SvgNode(text: "Frame settings"))
  result = result.role("button")

proc fieldBox(look: Look): string =
  result = "w-full rounded-lg"
  result.px("px", look.size * 2 div 3)
  if look.paper: result.add " border-2 border-black"
  else: result.add " bg-zinc-800 focus:bg-zinc-700 placeholder:text-zinc-500"

proc optionRow(look: Look, value, label: string, picked: bool): SvgNode =
  ## One option of a select box's list, the one it holds lit.
  var c = "rounded-lg"
  if picked: c.add(if look.paper: " bg-black text-white" else: " bg-sky-600")
  elif not look.paper: c.add " active:bg-zinc-600"
  result = el("option", move c, SvgNode(text: label)).role(if picked: "picked" else: "option")
  result.attrs.add(("value", value))

proc headingRow(look: Look, label: string): SvgNode =
  ## A group's name in a select box's list, over its options: picks nothing.
  var c = if look.paper: "font-bold" else: "text-zinc-400"
  c.px("text", look.size * 4 div 5)
  result = el("option", move c, SvgNode(text: label)).role("muted")
  result.attrs.add(("value", HeadingValue))

proc selectBox(look: Look, field: JsonNode, options: JsonNode, held: string, index: int): SvgNode =
  ## A select box: its options, strings or {value, label}, in a list that
  ## opens over the panel (ui/layout.nim), and its `other` last.
  var c = fieldBox(look)
  c.px("h", look.line)
  result = el("select", move c)
  result.attrs.add(("value", held))
  result.attrs.add(("placeholder", field.str("placeholder")))
  discard result.on("on-change", HSelect + index)
  for j in 0 ..< options.elems.len:
    let option = options.elems[j]
    let name = if option.kind == JObject: option{"value"}.text else: option.text
    let label = option.str("label")
    if option{"heading"}.getBool():
      result.children.add look.headingRow(label)
    else:
      result.children.add look.optionRow(name, if label.len > 0: label else: name, name == held)
  let other = field.str("other")
  if other.len > 0:
    result.children.add look.optionRow(OtherValue, other, held == OtherValue)
  result = result.role("field")

proc row(look: Look, field: JsonNode, value: JsonNode, index: int, typing = false, shown = false): SvgNode =
  ## One field: its label and what changes it. `typing`: its select box's
  ## `other` option is picked, and its own value is typed under it. `shown`:
  ## a secret field's text in the clear (its eye, beside it, is lit).
  let
    kind = field.str("type")
    options = field{"options"}
  var label = field.str("label")
  if label.len == 0:
    label = field.str("name")
  var c = "flex flex-col"
  c.px("gap", look.gap div 3)
  result = el("div", move c)
  if kind == "boolean":
    # A switch, the label beside it: the whole row toggles.
    c = "flex items-center justify-between"
    c.px("h", look.line)
    result.attrs[0][1] = move c
    discard result.on("on-click", HToggle + index)
    result.children.add el("span", "", SvgNode(text: label))
    let lit = value.isOn
    c = "shrink-0 flex rounded-full p-[3px]"
    c.px("w", look.line * 6 div 5)
    c.px("h", look.line * 2 div 3)
    if lit: c.add " justify-end"
    if look.paper: c.add " border-2 border-black"
    elif lit: c.add " bg-sky-500"
    else: c.add " bg-zinc-700"
    var k = "h-full aspect-square rounded-full"
    k.add(if look.paper and lit: " bg-black" elif look.paper: " border-2 border-black" else: " bg-white")
    result.children.add el("div", move c, el("div", move k).role(if lit: "knobOn" else: "knob")).role(
      if lit: "switchOn" else: "switch")
    return
  c = "text-zinc-400"
  if look.paper: c = ""
  c.px("text", look.size * 4 div 5)
  result.children.add el("span", move c, SvgNode(text: label)).role("muted")
  let choices = arrayOf(options)
  if field{"select"}.getBool() or choices.elems.len > 0:
    let box = look.selectBox(field, choices, if typing: OtherValue else: value.text, index)
    let action = field{"button"}.getInt(-1)
    if action < 0:
      result.children.add box
    else:
      # A button on the select box's line: scan for networks, a layout's gear.
      let boxLine = el("div", "flex items-center gap-2", el("div", "flex-1 min-w-0", box))
      boxLine.children.add look.iconButton(false, if action == AScan: RefreshPath else: gearPath(), HAction + action)
      result.children.add boxLine
    if not typing:
      return
  # Text to type: a line, or lines for text and JSON.
  let lines = kind in ["text", "json"]
  c = fieldBox(look)
  if lines:
    c.px("h", look.line * 5 div 2)
    c.px("py", look.size div 3)
  else:
    c.px("h", look.line)
  let input = el(if lines: "textarea" else: "input", move c)
  input.attrs.add(("value", value.text))
  input.attrs.add(("placeholder", field.str(if typing: "otherPlaceholder" else: "placeholder")))
  let secret = field{"secret"}.getBool()
  if secret and not shown: input.attrs.add(("type", "password"))
  elif kind in ["integer", "float"]: input.attrs.add(("type", "number"))
  let box = input.on("on-change", HText + index).role("field")
  if secret and not lines:
    # A password typed blind on a frame's keyboard is easy to get wrong: an
    # eye on its line shows it, and hides it again.
    let line = el("div", "flex items-center gap-2", el("div", "flex-1 min-w-0", box))
    line.children.add look.iconButton(shown, EyePath, HShow + index)
    result.children.add line
  else:
    result.children.add box

proc fieldList(self: SceneSettingsScene, look: Look, padX, padY: int): SvgNode =
  ## The fields, one under the other, or a line that says there are none.
  var c = "flex flex-col"
  c.px("px", padX)
  c.px("py", padY)
  c.px("gap", look.gap)
  result = el("div", move c)
  let
    fields = self.fieldList()
    values = self.valueMap()
  for i in 0 ..< fields.elems.len:
    let field = fields.elems[i]
    if field.kind == JObject and field.str("type") notin Unedited:
      let name = field.str("name")
      result.children.add look.row(field, values{name}, i, shown = self.state.str("shown") == name)
  if result.children.len == 0:
    c = "text-center"
    if not look.paper: c.add " text-zinc-400"
    result.children.add el("div", move c,
      SvgNode(text: if self.opener().len == 0: "No scene is showing." else: "This scene has no settings.")).role("muted")

proc grey(look: Look): string =
  ## Grey text (plain on e-paper).
  if look.paper: "" else: "text-zinc-400"

proc pressButton(look: Look, label: string, action: int, asking = -1): SvgNode =
  ## One of the frame page's buttons; "Tap again" in red while it asks for
  ## the second tap (`asking` is it).
  result = look.button(if asking == action: "Tap again" else: label, HAction + action, false)
  if asking == action:
    result.attrs[0][1].add(if look.paper: " bg-black text-white" else: " bg-red-600 active:bg-red-500")

proc note(list: SvgNode, look: Look, text: string) =
  ## A smaller grey line under what it is about; none for no text.
  if text.len == 0:
    return
  var c = look.grey
  c.px("text", look.size * 3 div 4)
  list.children.add el("div", move c, SvgNode(text: text)).role("muted")

proc pageList(self: SceneSettingsScene, look: Look, padX, padY: int): SvgNode =
  ## The fields of the page showing, and on the service keys what they do.
  result = self.fieldList(look, padX, padY)
  if self.onKeysPage():
    result.note(look, KeysNote)

proc offers(actions: seq[JsonNode], action: string): bool =
  ## Whether the host lists `action` among what the page may do.
  for a in actions:
    if a.getStr() == action:
      return true

var
  linkQr {.threadvar.}: Image ## the QR code of the link under way, while one is ...
  linkQrText {.threadvar.}: string ## ... and what it says

const LinkHints = [
  "Open the page above and enter the code.",
  "Scan the QR code, or open the page above and enter the code.",
  "In your FrameOS backend, Adopt frame with the address and code above.",
  "In your FrameOS backend, Adopt frame with the address and code above, or paste what the QR code says."]
  ## What to do, by plane (cloud, backend) and whether a QR code shows.

const
  UnlinkWords = "The frame keeps its scenes and its Wi-Fi, and stops taking scenes, settings and " &
    "commands from it. To manage it again, link it again from this page."
  LinkFailed = ["reach", "address", "refused", "lapsed", "enroll"]
    ## Why a cloud link stopped, by the host's word for it (`link.failed`).
  LinkFailedWords = [
    "No FrameOS Cloud answered there. Check the address and try again.",
    "This address cannot be used. Change it below.",
    "It did not take the code. Try again.",
    "Nobody entered the code in time. Try again.",
    "The code was approved, but the frame could not join. Try again."]

proc linkPage(look: Look, link: JsonNode, width, height: int, color: bool, address: SvgNode): SvgNode =
  ## A control plane being connected (docs/scene-settings.md "Connecting the
  ## frame"): the same page for the cloud and a backend, a QR code of what
  ## the person has to share beside its code, where it goes and Cancel. The
  ## host draws neither code anywhere else and keeps no picture while one
  ## shows. The QR code is black on white, as a camera reads it best, on
  ## every panel, and left out where there is no room for one that scans.
  ## The cloud's `address` field (where it asked) when the link stopped, or
  ## when Change address beside its code asked for it; a link that stopped
  ## stays up saying why, with Try again.
  let
    backend = link.str("to") == "backend"
    code = link.str("code")
    side = min(height * 45 div 100, width * 2 div 5)
    text = link.str("qr")
    failed = link.str("failed")
  if code.len == 0 or side < 96 or text.len == 0:
    linkQr = nil
  elif linkQr.isNil or linkQrText != text or linkQr.width != side:
    # What the host hands over always fits a code (192 bytes at most).
    linkQrText = text
    linkQr = qrImage(qrEncode(text), side, padding = 2)
  var c = "flex items-center"
  c.px("p", look.pad)
  c.px("gap", look.gap)
  result = el("div", move c)
  if not linkQr.isNil:
    var q = "shrink-0"
    q.px("w", side)
    q.px("h", side)
    let picture = el("img", move q)
    picture.image = linkQr
    result.children.add picture
  c = "flex-1 min-w-0 flex flex-col"
  c.px("gap", look.gap div 2)
  let words = el("div", move c,
    el("div", "font-bold", SvgNode(text: if backend: "Your FrameOS backend" else: "FrameOS Cloud")))
  result.children.add words
  if failed.len > 0:
    words.children.add el("div", "", SvgNode(text: LinkFailedWords[max(LinkFailed.find(failed), 0)]))
    words.note(look, link.str("detail"))
  elif code.len == 0:
    # Asked for, and not answered yet; or approved, and enrolling.
    words.note(look, "Waiting for FrameOS Cloud\xe2\x80\xa6")
  else:
    # The code as large as the page lets it be, in the panel's accent where it
    # shows colors (red is an ink of every color e-paper).
    var k = "font-bold"
    k.px("text", look.size * 2)
    if color: k.add(if look.paper: " text-red-600" else: " text-sky-400")
    words.children.add el("div", move k, SvgNode(text: code))
    words.children.add el("div", look.grey, SvgNode(text: link.str("where"))).role("muted")
    words.note(look, LinkHints[ord(backend) * 2 + ord(not linkQr.isNil)])
  if not address.isNil:
    words.children.add address
  let row = el("div", "flex flex-wrap gap-2")
  if failed.len > 0:
    row.children.add look.pressButton("Try again", ALinkCloud)
  row.children.add look.pressButton("Cancel", ACancelLink)
  if code.len > 0 and not backend and address.isNil:
    row.children.add look.pressButton("Change address", AAddress)
  words.children.add row

proc frameList(self: SceneSettingsScene, look: Look, info: JsonNode, autoScale: string, unit, width,
    height: int): SvgNode =
  ## The frame page: how it is doing (a card of label and text rows), its
  ## buttons, what can be changed (the same rows as a scene's fields); or,
  ## while a control plane is being connected, that.
  let
    actions = arrayOf(info{"actions"}).elems
    link = info{"link"}
  if not link.isNil and link.kind == JObject:
    # Whether the panel shows colors (utils/asset_colors): an accent for the code.
    # The link's own field (the cloud's address, saved with Save), and what
    # the host would not take of it.
    let fields = self.frameFields(info, "")
    var address: SvgNode
    # Not while it waits for its first answer: that is a moment, too short
    # to type in.
    if fields.elems.len > 0 and (link.str("failed").len > 0 or self.state{"address"}.getBool()):
      address = look.row(fields.elems[0], current(self.objectAt("frameValues"), info, "cloudUrl"), 0)
      address.note(look, info.str("note"))
    return look.linkPage(link, width, height, panelShowsColor(self.frameConfig.device), address)
  linkQr = nil
  var c = "flex flex-col"
  c.px("p", look.pad)
  c.px("gap", look.gap)
  result = el("div", move c)
  if self.state{"unlinking"}.getBool() and actions.offers("unlink"):
    # Leaving the plane that manages the frame (the host's `unlink`): asked
    # here, and again on the button ("Tap again"), as nothing at the frame
    # links it back but a new code.
    result.children.add el("div", "font-bold",
      SvgNode(text: "Unlink from " & info.str("managedBy") & "?"))
    result.children.add el("div", "", SvgNode(text: UnlinkWords))
    let row = el("div", "flex gap-2", look.pressButton("Unlink", AUnlinkNow, self.state{"confirm"}.getInt(-1)))
    row.children.add look.pressButton("Cancel", ACancelUnlink)
    result.children.add row
    return
  let card = el("div", if look.paper: "flex flex-col gap-1 p-3 rounded-lg border-2 border-black"
    else: "flex flex-col gap-1 p-3 rounded-lg bg-zinc-900")
  proc line(card: SvgNode, look: Look, label, text: string) =
    if text.len > 0:
      let row = el("div", "flex gap-3", el("span", look.grey, SvgNode(text: label)).role("muted"))
      row.children.add el("div", "grow min-w-0 flex justify-end",
        el("span", "truncate", SvgNode(text: text)))
      card.children.add row
  let wifi = info{"wifi"}
  if not wifi.isNil and wifi.kind == JObject:
    card.line(look, "Wi-Fi", wifiLine(wifi))
    if wifi.str("state") == "connected":
      let rssi = wifi{"rssi"}
      if not rssi.isNil and rssi.kind == JInt:
        card.line(look, "Signal", $rssi.getInt() & " dBm")
      card.line(look, "Address", wifi.str("ip"))
  let battery = info{"battery", "percent"}
  if not battery.isNil and battery.kind == JInt:
    card.line(look, "Battery", $battery.getInt() & "%")
  card.line(look, "Not saved", info.str("note"))
  if self.state{"restarting"}.getBool():
    card.line(look, "Rotation", "Restarting to turn the screen")
  # Who manages it: nobody, where the host offers a plane to link to (the
  # buttons below, each opening the same page: linkPage).
  let
    cloud = actions.offers("linkCloud")
    backend = actions.offers("adopt")
  card.line(look, "Managed by", if cloud or backend: "Nobody" else: info.str("managedBy"))
  card.line(look, "Version", info.str("version"))
  let update = info{"updateState"}.getInt(-1)
  if update == UpdateAvailable:
    card.line(look, "Update", info.str("updateVersion") & " available")
  elif update >= 0:
    card.line(look, "Update", UpdateWords[update])
  # The store scenes with a newer version, where the control plane says.
  let scenes = sceneUpdates(self.uiId)
  if scenes.busy:
    card.line(look, "Scenes", "Updating\xe2\x80\xa6")
  elif scenes.listed == 0:
    card.line(look, "Scenes", UpdateWords[2])
  elif scenes.listed > 0:
    card.line(look, "Scenes", $scenes.listed & (if scenes.listed == 1: " update" else: " updates"))
  result.children.add card.role("card")
  let asking = self.state{"confirm"}.getInt(-1)
  # What the frame can do, right under how it is doing: the fields below can
  # run longer than the panel.
  c = "flex flex-wrap"
  c.px("gap", look.gap div 2)
  let buttons = el("div", move c)
  buttons.children.add look.pressButton("Render again", ARender)
  if update == UpdateAvailable:
    buttons.children.add look.pressButton("Install update", AInstallUpdate, asking)
  elif update >= 0 and update != UpdateChecking and update != UpdateInstalling:
    buttons.children.add look.pressButton("Check for updates", ACheckUpdate)
  if scenes.movable > 0 and not scenes.busy:
    buttons.children.add look.pressButton("Update scenes", AUpdateScenes, asking)
  if actions.offers("restart"):
    buttons.children.add look.pressButton("Restart FrameOS", ARestart, asking)
  buttons.children.add look.pressButton("Reboot", AReboot, asking)
  if cloud: buttons.children.add look.pressButton("Link to cloud", ALinkCloud)
  if backend: buttons.children.add look.pressButton("Link to backend", AAdopt)
  if actions.offers("unlink"): buttons.children.add look.pressButton("Unlink", AUnlink)
  # Where the host keeps keys typed on the frame (frame_service_keys.nim).
  if not serviceKeysSave.isNil: buttons.children.add look.pressButton("Service keys", AKeys)
  result.children.add buttons
  let
    fields = self.frameFields(info, autoScale, unit)
    edits = self.objectAt("frameValues")
    typing = edits{"typing"}.getBool()
  for i in 0 ..< fields.elems.len:
    let field = fields.elems[i]
    let name = field.str("name")
    result.children.add look.row(field, current(edits, info, name), i, typing and name == "wifiSsid",
      self.state.str("shown") == name)
    # A turned LCD copies every frame to its place (embedded_main.nim
    # packImageRgb565, 30 ms at 480x480): there is no drawing it turned.
    let note =
      if name == "rotate" and not look.paper: "A new rotation restarts the frame. Any rotation but 0\xc2\xb0 adds a noticeable delay to every frame of an animated scene."
      elif name == "rotate": "A new rotation restarts the frame."
      elif name == "clock" and info{"wifi", "state"}.getStr() == "connected": "Online, the clock follows network time."
      else: ""
    if note.len > 0:
      result.note(look, note)

proc box(c: var string, x, y, w, h: int) =
  c.add "absolute"
  c.px("left", x)
  c.px("top", y)
  c.px("w", w)
  c.px("h", h)

proc roundTree(self: SceneSettingsScene, look: Look, root: SvgNode, width, height: int, title: string,
    keyboardTop: int, gear: bool, body: SvgNode, cancel = "Cancel", saveLit = true) =
  ## A round panel's: the scene's name in the top arc, Cancel and Save
  ## under it, and `body` (the fields, or the frame page's rows) in a list as
  ## wide as the circle is where the list ends, everything `RoundInset` in
  ## from the rim. With the keyboard up (on the circle's lower half,
  ## ui/keyboard.nim) the name makes way for the buttons and the list ends
  ## above the keys. With `gear` the gear that opens the frame page sits
  ## between Cancel and Save.
  let
    cx = width div 2
    cy = height div 2
    radius = max(min(width, height) div 2 - RoundInset, 8)
    rowH = look.line * 4 div 5
    keys = keyboardTop < height
  # The first row's top edge, where the circle is 45% of its width wide.
  var
    y = cy - chordHalf(radius, radius * 45 div 100)
    half: int
    c: string
  # The name is hidden, not left out: an element's key is its place in the
  # tree, and the field with the keyboard has to keep its own.
  half = max(chordHalf(radius, cy - y) - 2, 4)
  c.box(cx - half, y, 2 * half, rowH)
  c.add(if keys: " hidden" else: " flex items-center justify-center")
  root.children.add el("div", move c, el("span", "truncate font-bold", SvgNode(text: title)))
  if not keys:
    y += rowH + look.gap div 2
  half = max(chordHalf(radius, cy - y) - 2, 4)
  c.box(cx - half, y, 2 * half, rowH)
  c.add " flex items-center justify-center"
  c.px("gap", look.gap)
  let buttons = el("div", move c)
  buttons.children.add look.button(cancel, HCancel, false)
  if gear:
    buttons.children.add look.gear(false, named = false)
  buttons.children.add look.button("Save", HSave, saveLit)
  root.children.add buttons
  y += rowH + look.gap div 2
  # As far below the centre as it starts above it, or to the keyboard.
  let bottom = if keys: keyboardTop - look.gap div 2 else: 2 * cy - y
  half = max(chordHalf(radius, max(abs(y - cy), abs(bottom - cy))) - 2, 4)
  c.box(cx - half, y, 2 * half, max(bottom - y, 1))
  c.add " overflow-y-auto"
  root.children.add el("div", move c, body)

proc tree*(self: SceneSettingsScene, width, height: int, paper: bool, title: string, round = false,
    keyboardTop = high(int), info: JsonNode = nil, sizeUnit = 0): SvgNode =
  ## The panel as a UI tree: a header with Cancel, the scene's name and
  ## Save, and under it the fields in a list that scrolls. With the host's
  ## `info` (frameSettingsRead) a gear left of Save opens the frame page,
  ## where Cancel is Back. On a `round` panel the scene's alone inside its
  ## circle, the keyboard's top at `keyboardTop` while it is up. `sizeUnit`:
  ## what its sizes are a share of, the panel's shorter edge for a UI laid out
  ## at its render scale (sceneSwitcher's uiRoom); the canvas's without it.
  let unit = if sizeUnit > 0: sizeUnit else: min(width, height)
  var look = Look(paper: paper, size: clamp(unit * 4 div 100, 14, 28))
  look.pad = clamp(unit * 4 div 100, 8, 32)
  look.gap = look.size
  look.line = look.size * 23 div 10
  var c = "flex flex-col h-full"
  c.px("text", look.size)
  # E-paper's white and black are the canvas's own; an LCD's dark page covers
  # every pixel, so a key repaints only what it changed.
  if not paper: c.add " bg-zinc-950 text-white"
  result = el("div", move c).role("page")
  if round:
    if not info.isNil and self.onFrame():
      # The frame page (Wi-Fi, rotation, scale, restart), as the form is:
      # its name in the top arc, Back and Save under it, its rows in the
      # list as wide as the circle, which ends above the keyboard while it
      # is up. Save is lit while there is something to save.
      let edits = self.state{"frameValues"}
      self.roundTree(look, result, width, height, "Frame settings", min(keyboardTop, height),
        gear = false, self.frameList(look, info,
          scaleText(autoRenderScale(unit, unit, self.frameConfig.device)), unit, width, height),
        cancel = "Back", saveLit = not edits.isNil and edits.len > 0)
    else:
      self.roundTree(look, result, width, height, title, min(keyboardTop, height),
        gear = not info.isNil and not self.panelWindow(), self.pageList(look, 2, look.gap div 2))
    return
  c = "shrink-0 flex items-center"
  c.px("h", look.line * 3 div 2)
  c.px("px", look.pad)
  c.px("gap", look.gap div 2)
  c.add(if paper: " border-b-2 border-black" else: " border-b border-zinc-800")
  let
    header = el("div", move c)
    frame = not info.isNil and self.onFrame()
    # Connecting a control plane: its own title and nothing to save.
    connecting = frame and not info{"link"}.isNil
    subPage = self.onSubPage()
  header.children.add look.button(if frame or subPage: "Back" else: "Cancel", HCancel, false)
  header.children.add el("span", "grow truncate text-center font-bold",
    SvgNode(text: if connecting: "Connect" elif frame and self.state{"unlinking"}.getBool(): "Unlink"
      elif frame: "Frame settings" else: title))
  # The scene's code (on the layout's page the layout's), where the frame
  # holds the code editor (not the editor's own: it is open on it already).
  let code = self.codeOf(codeEditor()).len > 0
  if code:
    header.children.add look.iconButton(false, CodePath, HCode, wide = true)
  if not info.isNil and not self.panelWindow():
    # Lit on the frame's page and its sub-pages, which are the frame's. Named
    # where there are about 31 of the text's size: the two buttons, the
    # title and the name (36 with the code button beside them).
    header.children.add look.gear(frame or subPage,
      named = not frame and not subPage and width >= look.size * (if code: 36 else: 31))
  # Lit while there is something to save: after a Save it goes quiet, which
  # is how the frame page says it took it.
  let edits = if frame: self.state{"frameValues"} else: self.form(){"edited"}
  header.children.add look.button("Save", HSave, not edits.isNil and edits.len > 0)
  result.children.add header.role("bar")
  let body = if frame: self.frameList(look, info, scaleText(autoRenderScale(unit, unit, self.frameConfig.device)), unit,
      width, height)
    else: self.pageList(look, look.pad, look.pad)
  result.children.add el("div", "flex-1 overflow-y-auto", body)

proc title(self: SceneSettingsScene): string =
  ## The scene's name, from the host's scene list (its id without one).
  if self.onKeysPage():
    return "Service keys"
  if self.onLayoutPage():
    return "Layout settings"
  result = self.opener()
  for entry in listEntries():
    if entry.id == result and entry.name.len > 0:
      return entry.name

proc drawForm*(self: SceneSettingsScene, image: Image) =
  ## One render: laid out, drawn into `image`, and the form left behind for
  ## the pointer and the keyboard; back by itself once nobody has touched it
  ## for a while (the switcher's `drawUi`).
  (self.paper, self.slow) = panelLook(self.frameConfig, image)
  let round = isRound(self.frameConfig)
  # At the frame's render scale, as its scenes are (sceneSwitcher's uiRoom).
  let (roomW, roomH) = uiRoom(self.frameConfig, image.width, image.height)
  var keyboardTop = high(int)
  if round:
    # The keyboard is up: where it will go (ui/layout.nim asks the same).
    let target = uiTarget(self.uiId, SettingsNode, create = false)
    if not target.isNil and target.input.keyboard and target.input.focus > 0:
      keyboardTop = keyboardBox(roomW, roomH, true)[0]
  let info = frameInfo()
  if info.isNil and (self.onFrame() or self.onKeysPage()):
    # Turned off while it showed: the frame's pages go with it.
    self.showPage(false)
  if self.drawUi(self.uiId, self.tree(roomW, roomH, self.paper, self.title(), round,
      keyboardTop, info, self.sizeUnit(image)), image, self.paper, self.slow, onHandler, IdleSeconds,
      roomW, roomH):
    leave()

proc back(self: SceneSettingsScene) =
  ## One step back: from a sub-page to the frame page, from the frame page to
  ## the scene's form, from the form to the scene.
  if self.onSubPage():
    self.showPage(true)
    self.touch()
    sendEvent(evRender, newJObject(), eoScene)
  elif self.onFrame() and not self.openedOnFrame():
    self.showPage(false)
    self.touch()
    sendEvent(evRender, newJObject(), eoScene)
  else:
    leave()

# ------------------------------------------------------------ the scene

proc startAfresh(self: SceneSettingsScene) =
  ## No field with the keyboard, the list at its top, no page and no edits:
  ## what the dispatcher hands over next is all it knows.
  if self.onFrame():
    frameAction("close")
  forgetUiTarget(self.uiId, SettingsNode)
  self.state = newJObject()
  self.showName("Scene settings")

proc settingsOwnRun(self: FrameScene, context: ExecutionContext) {.nimcall.} =
  ## What raises here is reported by the caller, as for any scene. The
  ## payload is read with `{}` alone, which answers nil for what is missing.
  let self = SceneSettingsScene(self)
  let payload = context.payload
  # Input that came through the HTTP write door (the frame access key,
  # frame_settings_hooks.nim): this panel is the frame's own, and a key
  # handed out to pick scenes presses nothing on it. The host's own events
  # (the switch, open, close, the render) are never sent under that flag.
  if framePageWithheld:
    return
  case context.event
  of "setCurrentScene":
    # Opened from a scene (the dispatcher always says which, `from`): afresh,
    # as an ESP32's close leaves it. Brought forward again from a window,
    # the switch says nothing and it is as it was left, edits and all.
    if not payload{"state", "from"}.isNil:
      self.startAfresh()
    # What the dispatcher read off the scene it was opened from.
    for key in ["from", "fields", "values", "opened", "layout", "noLayout", "home"]:
      let value = payload{"state", key}
      if not value.isNil:
        self.state.put(key, value)
    # Its keys, while the frame offers its own page (docs/service-keys.md).
    let keys = payload{"state", "keys"}
    if not keys.isNil and not frameInfo().isNil:
      self.addKeyFields(keys)
    # It opens on the scene's form; with no scene showing there is nothing
    # on that one, and the frame page is what the status screen sent you here
    # for.
    if (self.state{"page"}.isNil or not payload{"state", "noLayout"}.isNil) and
        (self.opener().len == 0 or self.openedOnFrame()) and not frameInfo().isNil:
      self.showPage(true)
  of "open":
    self.touch()
    wentBack = false
    builtInAway(self.id.string, false)
    if self.state{"away"}.getBool():
      # Brought forward from a window: the host's news for the frame page
      # again.
      self.state.delete("away")
      if self.onFrame():
        frameAction("open")
  of "close":
    # Sent back by the dispatcher (its command again from anyone, a layout's
    # close) is going back too.
    let sentBack = self.state{"goneBack"}.getBool()
    if self.state.hasKey("goneBack"):
      self.state.delete("goneBack")
    if wentBack or sentBack or not builtInScenesStay:
      # Done: opened again, it starts afresh: no field has the keyboard, the
      # list is at its top, and it knows no scene until the dispatcher says.
      wentBack = false
      builtInAway(self.id.string, false)
      self.startAfresh()
    else:
      # The focus went to a window beside it (docs/scene-layouts.md
      # "Windows"): it stays open there as it was, and does not go back by
      # itself (switcher.drawUi). Opened from a scene again, it starts afresh.
      if self.onFrame():
        frameAction("close")
      self.state.put("away", newJBool(true))
      builtInAway(self.id.string, true)
  of "render":
    if context.hasImage and not context.image.isNil:
      self.drawForm(context.image)
  of "button":
    # The frame's buttons as the keys (ui/events.nim "keys"): next and prev
    # walk the form, the green key presses what is ringed. Back (and menu)
    # goes back, once a list, the keyboard or the ring is gone.
    acted = -1
    let goesBack = payload.str("role") in ["back", "menu"] and payload.str("action") == "press"
    if (if goesBack: not uiKeys([self.uiId], "Escape") else: not uiButtonKeys([self.uiId], payload)):
      if goesBack:
        self.back()
    else:
      if acted >= 0:
        self.acting()
      self.touch()
      sendEvent(evRender, newJObject(), eoScene)
  of evBack:
    # The frame's back (a swipe in from the left), as on a phone: the
    # keyboard goes away first, then the frame page, then the form, unsaved.
    if dismissKeyboard(self.uiId, SettingsNode):
      self.touch()
      sendEvent(evRender, newJObject(), eoScene)
    else:
      self.back()
  else:
    # The pointer, and keys for a field (ui/events.nim hit-tests them). A slow
    # panel shows no press: what only moves the press waits for a tap.
    acted = -1
    var changed = false
    when not defined(frameosEmbedded):
      if context.event == "keyDown":
        changed = uiTypedKeys([self.uiId], context.payload) # Tab walks the form, Enter presses
    if not changed:
      changed = dispatchUiEvent(self.uiId, context.event, context.payload)
    if acted >= 0:
      self.acting()
    if changed or acted >= 0:
      self.touch()
      if not self.slow or context.event in ["tap", "pointerUp", "keyDown", "textInput"]:
        sendEvent(evRender, newJObject(), eoScene)

proc runSettings(self: FrameScene, context: ExecutionContext) =
  if builtInRunner.isNil or not builtInRunner(self, context):
    settingsOwnRun(self, context)

proc renderSettings(self: FrameScene, context: ExecutionContext): Image =
  self.ensureCanvas(context)
  runSettings(self, context)
  context.image

proc initSettings(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  ## Nothing persisted to start from: what it shows comes with the switch.
  let (paper, slow) = panelLook(frameConfig)
  SceneSettingsScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(), ownRun: settingsOwnRun,
    shownName: "Scene settings", refreshInterval: IdleSeconds, backgroundColor: background(paper), paper: paper,
    slow: slow)

var exportedScene* = ExportedInterpretedScene(
  name: "Scene settings",
  refreshInterval: IdleSeconds,
  backgroundColor: background(false),
  init: initSettings,
  runEvent: runSettings,
  render: renderSettings,
)
  ## An interpreted scene's export (with no nodes of its own), so a host that
  ## holds one scene (single_scene_host) keeps it like any other.

{.pop.}
