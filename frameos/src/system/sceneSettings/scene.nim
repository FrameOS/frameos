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
## lets it be, as the switcher's tiles are; no ESP32 board is round. Flash is the budget on an ESP32 (AGENTS.md): one
## handler for everything (numbered), classes appended in place, and no Nim
## checks in this module (every index is guarded by its loop): JSON arrays
## are read through `elems` once their kind is known, since json's `[]` and
## `items` bring their own asserts in with them.

import std/[json, options, parseutils, strutils, tables, times]
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
import frameos/ui/tree
import frameos/utils/image
import frameos/utils/svg_frames
import system/sceneSwitcher/scene as switcher

{.push overflowChecks: off, rangeChecks: off, boundChecks: off, fieldChecks: off, stackTrace: off,
  lineTrace: off.}

type
  SceneSettingsScene* = SceneSwitcherScene
    ## The switcher's own type, its `entries` unused and `paper` the panel's:
    ## one set of destroy and trace hooks in flash for the two built-in scenes.

  # The frame's own page (docs/scene-settings.md "The frame page"), behind
  # the gear: what the host knows of the frame, read on every render. The
  # host gives facts and the page has the words, so every host shows the
  # same page.
  FrameSettingsRead* = proc(): JsonNode {.nimcall, gcsafe, raises: [].}
    ## nil when the page is not offered (no host has one, or the frame's
    ## control plane turned it off). Else {wifi: {state, ssid, hotspot,
    ## rssi, ip, networks: [name…], scanning, password}, rotate,
    ## renderScale, battery: {percent}, managedBy, version,
    ## actions: ["restart"…], note}: `battery` absent without one; `wifi`
    ## absent, no network to set here; `state` one of connected, connecting,
    ## notFound, auth, hotspot, unset, off; `password` a password is saved;
    ## `actions` the device commands this host runs besides render and
    ## reboot; `note` what the last Save could not do.
  FrameSettingsApply* = proc(changes: JsonNode) {.nimcall, gcsafe, raises: [].}
    ## What Save changed: wifiSsid with wifiPassword (empty: the saved one
    ## for the same network, none for another), rotate, renderScale.
  FrameSettingsAction* = proc(action: string) {.nimcall, gcsafe, raises: [].}
    ## "open" when the page comes up, "close" when it goes, "scan" for the
    ## networks in range.

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
  HText = 1000
  HToggle = 2000
  HSelect = 13000 ## + field: a select box's pick
  HAction = 20000 ## + one of the buttons below
  AScan = 0
  ARender = 1
  ARestart = 2
  AReboot = 3
  ALayout = 4
  ACheckUpdate = 5
  AInstallUpdate = 6
  OtherValue = "\1" ## a select box's `other` option; no value of its own is this
  # The types the panel cannot edit: what they hold is not text.
  Unedited = ["node", "scene", "image"]
  # The scales offered (frontend/src/utils/renderScale.ts RENDER_SCALE_STEPS).
  Scales = ["0.25", "0.5", "0.75", "1", "1.25", "1.5", "2", "2.5", "3", "4"]
  # A gear, 48 units square: the teeth clockwise, the hole the other way.
  GearPath = "M20 9L21 3L27 3L28 9L32 11L36 7L41 12L37 16L39 20L45 21L45 27L39 28L37 32L41 36L36 41L32 37" &
    "L28 39L27 45L21 45L20 39L16 37L12 41L7 36L11 32L9 28L3 27L3 21L9 20L11 16L7 12L12 7L16 11Z" &
    "M17 24a7 7 0 1 0 14 0a7 7 0 1 0 -14 0Z"
  # A circle with an arrow, the same 48 units.
  RefreshPath = "M24 8a16 16 0 1 0 16 16h-5a11 11 0 1 1-11-11v6l10-8.5L24 2Z"
  # wifiLine's words, by the host's `state`.
  WifiStates = ["connected", "hotspot", "notFound", "auth", "connecting", "unset"]
  WifiBefore = ["Connected to ", "Setup hotspot ", "Can't find ", "Wrong password for ", "Connecting to "]
  WifiAfter = ["", "", "", "?", "\xe2\x80\xa6"]

var
  frameSettingsRead*: FrameSettingsRead
  frameSettingsApply*: FrameSettingsApply
  frameSettingsAction*: FrameSettingsAction

var
  # What the last handler did: its number and the text it carried. Read by
  # runEvent once the hit test is done, so the handler holds nothing.
  acted {.threadvar.}: int
  actedText {.threadvar.}: string

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  ## `node[key] = value` for an object node, without json's assert.
  node.fields[key] = value

# ------------------------------------------------------------------ values

proc form(self: SceneSettingsScene): JsonNode =
  ## What the page's fields live in: the layout's on its page, else the scene's.
  result = if self.state{"page"}.getStr() == "layout": self.state{"layoutForm"} else: self.state

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
  self.state{"page"}.getStr() == "frame"

proc onLayoutPage(self: SceneSettingsScene): bool =
  self.state{"page"}.getStr() == "layout"

proc showName(self: SceneSettingsScene, name: string) =
  ## What a layout around it calls this page.
  self.shownName = name
  if not self.wornLayout.isNil:
    self.wornLayout.shownName = name
    rhythmMarkDue(self.wornLayout)

proc openedOnFrame(self: SceneSettingsScene): bool =
  ## Opened straight on the frame page (`sceneSettings {page: "frame"}`): Back
  ## goes to the scene, not by way of its form.
  self.state{"opened"}.getStr() == "frame"

proc frameAction(action: string) =
  if not frameSettingsAction.isNil:
    frameSettingsAction(action)

proc showPage(self: SceneSettingsScene, frame: bool) =
  ## The scene's form or the frame page, its list at the top and no field
  ## with the keyboard. The host hears the frame page come up (a scan, on a
  ## frame that is not on Wi-Fi) and go away (no more redraws for its news).
  forgetUiTarget(SceneSettingsId, SettingsNode)
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
    result = if name == "wifiSsid": info{"wifi", "ssid"} else: info{name}

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
  let kind = field{"type"}.getStr()
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
  let i = WifiStates.find(wifi{"state"}.getStr())
  if i < 0: "Not connected"
  elif i == WifiBefore.len: "Not set up"
  else: WifiBefore[i] & quoted(wifi{if i == 1: "hotspot" else: "ssid"}.getStr()) & WifiAfter[i]

proc field(name, label, kind: string): JsonNode =
  result = newJObject()
  result.put("name", newJString(name))
  result.put("label", newJString(label))
  result.put("type", newJString(kind))

proc option(value, label: string): JsonNode =
  result = newJObject()
  result.put("value", newJString(value))
  result.put("label", newJString(label))

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

proc layoutField(self: SceneSettingsScene, info: JsonNode): JsonNode =
  ## The layout the frame shows its scenes in, its gear beside it for one with
  ## settings. nil for a frame with no layouts on it.
  let layouts = if layoutListing.isNil: @[] else: layoutListing()
  if layouts.len == 0:
    return nil
  result = field("layout", "Layout", "string")
  let options = newJArray()
  if chosenLayout().len > 0:
    options.elems.add option("", "As each scene says")
  options.elems.add option(NoLayout, "No layout")
  for i in 0 ..< layouts.len:
    options.elems.add option(layouts[i].id, layouts[i].name)
  result.put("options", options)
  info.put("layout", newJString(if self.wornLayout.isNil: NoLayout else: self.wornLayout.id.string))
  if not self.wornLayout.isNil and InterpretedFrameScene(self.wornLayout).publicStateFields.len > 0:
    result.put("button", newJInt(ALayout))

proc frameFields(self: SceneSettingsScene, info: JsonNode, autoScale: string, unit = 0): JsonNode =
  ## The page's fields, in the shape of a scene's, from the host's facts:
  ## the network (those in range, the saved one first when it is not among
  ## them, and a name to type), its password, the rotation and the scale.
  ## The scales offered leave a layout of 320 px or more on the panel's
  ## shorter edge `unit` (uiScale's floor: past it the page itself stops
  ## following), and the scale set elsewhere stays as it is.
  result = newJArray()
  let wifi = info{"wifi"}
  if not wifi.isNil and wifi.kind == JObject:
    let
      saved = wifi{"ssid"}.getStr()
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
  if not info{"clockDate"}.isNil:
    # An ESP32's clock, set by hand where no network time reaches it.
    let date = field("clockDate", "Date", "string")
    date.put("placeholder", newJString("YYYY-MM-DD"))
    result.elems.add date
    let time = field("clockTime", "Time", "string")
    time.put("placeholder", newJString("HH:MM"))
    result.elems.add time

proc opener(self: SceneSettingsScene): string =
  self.state{"from"}.getStr()

proc leave() =
  ## Back to the scene it was opened from, nothing saved: the dispatcher
  ## knows which.
  sendEvent(evSceneSettings, newJObject(), eoScene)

proc collect(fields, values: JsonNode): JsonNode =
  ## The values of `fields` as their owner keeps them (`saved`), by name.
  result = newJObject()
  for i in 0 ..< fields.elems.len:
    let field = fields.elems[i]
    let name = field{"name"}.getStr()
    let value = field.saved(values{name})
    if not value.isNil:
      result.put(name, value)

proc save(self: SceneSettingsScene) =
  ## Back to the scene, its fields set to the values here.
  if self.opener().len == 0:
    leave()
    return
  let payload = newJObject()
  payload.put("sceneId", newJString(self.opener()))
  payload.put("state", collect(self.fieldList(), self.valueMap()))
  sendEvent(evSetCurrentScene, payload, eoScene)

proc saveFrame(self: SceneSettingsScene, fields: JsonNode) =
  ## The frame page's Save: what was edited there to the host, which applies
  ## what differs from what it has (Wi-Fi joins in the background, the scale
  ## is drawn at once, a rotation restarts the frame) and takes a password
  ## alone for the saved network. The page stays up so what it did shows.
  let changes = collect(fields, self.objectAt("frameValues"))
  self.state.put("frameValues", newJObject())
  let layout = changes{"layout"}
  if not layout.isNil:
    # The frame's own to keep: no host setting.
    chooseLayout(layout.getStr())
    changes.delete("layout")
  if changes.len > 0 and not frameSettingsApply.isNil:
    forgetUiTarget(SceneSettingsId, SettingsNode)
    frameSettingsApply(changes)

proc openLayoutPage(self: SceneSettingsScene) =
  ## The settings of the layout showing, on a page of their own.
  if self.wornLayout.isNil:
    return
  let form = newJObject()
  settingsOf(self.wornLayout, form)
  self.state.put("layoutForm", form)
  forgetUiTarget(SceneSettingsId, SettingsNode)
  frameAction("close")
  self.state.put("page", newJString("layout"))
  self.showName("Layout settings")

proc saveLayoutPage(self: SceneSettingsScene) =
  ## Kept on the frame under the layout's id, and on the bar at once.
  let worn = self.wornLayout
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
  elif action == ALayout:
    self.openLayoutPage()
  elif action == ARender:
    sendEvent(evRender, newJObject(), eoPanel)
  elif self.state{"confirm"}.getInt(-1) == action:
    if action == AInstallUpdate:
      frameAction("installUpdate")
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
    if self.onLayoutPage(): self.showPage(true)
    elif frame and not self.openedOnFrame(): self.showPage(false)
    else: leave()
  elif handler == HSave:
    if self.onLayoutPage(): self.saveLayoutPage()
    elif frame: self.saveFrame(fields)
    else: self.save()
  elif handler == HGear:
    self.showPage(not frame)
  elif handler >= HAction:
    self.press(handler - HAction)
  elif handler >= HSelect:
    let index = handler - HSelect
    if index < fields.elems.len:
      let
        field = fields.elems[index]
        other = actedText == OtherValue
      values.put(field{"name"}.getStr(), newJString(if other: "" else: actedText))
      if not frame:
        self.formObject("edited").put(field{"name"}.getStr(), newJBool(true))
      # Beside the values, on a field that has an `other`: the frame page's,
      # whose names it knows, never a scene's, which could be called anything.
      if field{"other"}.getStr().len > 0:
        values.put("typing", newJBool(other))
  else:
    let
      index = if handler >= HToggle: handler - HToggle else: handler - HText
    if index >= 0 and index < fields.elems.len:
      let field = fields.elems[index]
      let name = field{"name"}.getStr()
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
  actedText = event{"value"}.getStr()

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
  el("div", move c, SvgNode(text: label)).on("on-click", handler)

proc iconButton(look: Look, lit: bool, path: string, handler: int): SvgNode =
  ## A round button with a picture on it.
  var c = "shrink-0 flex items-center justify-center rounded-full"
  c.px("h", look.line * 4 div 5)
  c.px("w", look.line * 4 div 5)
  if look.paper: c.add(if lit: " bg-black text-white" else: " border-2 border-black")
  elif lit: c.add " bg-sky-600 active:bg-sky-500"
  else: c.add " bg-zinc-800 active:bg-zinc-600"
  # The hole winds against the teeth: the default fill rule cuts it out.
  let path = SvgNode(tag: "path", attrs: @[("d", path), ("fill", "currentColor")])
  var i = ""
  i.px("w", look.size * 6 div 5)
  i.px("h", look.size * 6 div 5)
  let icon = el("svg", move i, path)
  icon.attrs.add(("viewBox", "0 0 48 48"))
  el("div", move c, icon).on("on-click", handler)

proc gear(look: Look, lit: bool): SvgNode =
  ## The gear that opens the frame page, lit while it shows.
  look.iconButton(lit, GearPath, HGear)

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
  result = el("option", move c, SvgNode(text: label))
  result.attrs.add(("value", value))

proc selectBox(look: Look, field: JsonNode, options: JsonNode, held: string, index: int): SvgNode =
  ## A select box: its options, strings or {value, label}, in a list that
  ## opens over the panel (ui/layout.nim), and its `other` last.
  var c = fieldBox(look)
  c.px("h", look.line)
  result = el("select", move c)
  result.attrs.add(("value", held))
  result.attrs.add(("placeholder", field{"placeholder"}.getStr()))
  discard result.on("on-change", HSelect + index)
  for j in 0 ..< options.elems.len:
    let option = options.elems[j]
    let name = if option.kind == JObject: option{"value"}.text else: option.text
    let label = option{"label"}.getStr()
    result.children.add look.optionRow(name, if label.len > 0: label else: name, name == held)
  let other = field{"other"}.getStr()
  if other.len > 0:
    result.children.add look.optionRow(OtherValue, other, held == OtherValue)

proc row(look: Look, field: JsonNode, value: JsonNode, index: int, typing = false): SvgNode =
  ## One field: its label and what changes it. `typing`: its select box's
  ## `other` option is picked, and its own value is typed under it.
  let
    kind = field{"type"}.getStr()
    options = field{"options"}
  var label = field{"label"}.getStr()
  if label.len == 0:
    label = field{"name"}.getStr()
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
    result.children.add el("div", move c, el("div", move k))
    return
  c = "text-zinc-400"
  if look.paper: c = ""
  c.px("text", look.size * 4 div 5)
  result.children.add el("span", move c, SvgNode(text: label))
  let choices = arrayOf(options)
  if field{"select"}.getBool() or choices.elems.len > 0:
    let box = look.selectBox(field, choices, if typing: OtherValue else: value.text, index)
    let action = field{"button"}.getInt(-1)
    if action < 0:
      result.children.add box
    else:
      # A button on the select box's line: scan for networks, a layout's gear.
      let boxLine = el("div", "flex items-center gap-2", el("div", "flex-1 min-w-0", box))
      boxLine.children.add look.iconButton(false, if action == AScan: RefreshPath else: GearPath, HAction + action)
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
  input.attrs.add(("placeholder", field{if typing: "otherPlaceholder" else: "placeholder"}.getStr()))
  if field{"secret"}.getBool(): input.attrs.add(("type", "password"))
  elif kind in ["integer", "float"]: input.attrs.add(("type", "number"))
  result.children.add input.on("on-change", HText + index)

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
    if field.kind == JObject and field{"type"}.getStr() notin Unedited:
      result.children.add look.row(field, values{field{"name"}.getStr()}, i)
  if result.children.len == 0:
    c = "text-center"
    if not look.paper: c.add " text-zinc-400"
    result.children.add el("div", move c,
      SvgNode(text: if self.opener().len == 0: "No scene is showing." else: "This scene has no settings."))

proc grey(look: Look): string =
  ## Grey text (plain on e-paper).
  if look.paper: "" else: "text-zinc-400"

proc pressButton(look: Look, label: string, action: int, asking = -1): SvgNode =
  ## One of the frame page's buttons; "Tap again" in red while it asks for
  ## the second tap (`asking` is it).
  result = look.button(if asking == action: "Tap again" else: label, HAction + action, false)
  if asking == action:
    result.attrs[0][1].add(if look.paper: " bg-black text-white" else: " bg-red-600 active:bg-red-500")

proc frameList(self: SceneSettingsScene, look: Look, info: JsonNode, autoScale: string, unit: int): SvgNode =
  ## The frame page: how it is doing (a card of label and text rows), what
  ## can be changed (the same rows as a scene's fields), and its buttons.
  var c = "flex flex-col"
  c.px("p", look.pad)
  c.px("gap", look.gap)
  result = el("div", move c)
  let card = el("div", if look.paper: "flex flex-col gap-1 p-3 rounded-lg border-2 border-black"
    else: "flex flex-col gap-1 p-3 rounded-lg bg-zinc-900")
  proc line(card: SvgNode, look: Look, label, text: string) =
    if text.len > 0:
      let row = el("div", "flex gap-3", el("span", look.grey, SvgNode(text: label)))
      row.children.add el("div", "grow min-w-0 flex justify-end",
        el("span", "truncate", SvgNode(text: text)))
      card.children.add row
  let wifi = info{"wifi"}
  if not wifi.isNil and wifi.kind == JObject:
    card.line(look, "Wi-Fi", wifiLine(wifi))
    if wifi{"state"}.getStr() == "connected":
      let rssi = wifi{"rssi"}
      if not rssi.isNil and rssi.kind == JInt:
        card.line(look, "Signal", $rssi.getInt() & " dBm")
      card.line(look, "Address", wifi{"ip"}.getStr())
  let battery = info{"battery", "percent"}
  if not battery.isNil and battery.kind == JInt:
    card.line(look, "Battery", $battery.getInt() & "%")
  card.line(look, "Not saved", info{"note"}.getStr())
  card.line(look, "Managed by", info{"managedBy"}.getStr())
  card.line(look, "Version", info{"version"}.getStr())
  let
    update = info{"update"}
    updateState = update{"state"}.getStr()
  card.line(look, "Update", case updateState
    of "checking": "Checking\xe2\x80\xa6"
    of "current": "This is the latest version"
    of "available": update{"version"}.getStr() & " is available"
    of "failed": "Could not check for updates"
    of "installing": "Installing. The frame restarts when it is done."
    else: "")
  result.children.add card
  let
    fields = self.frameFields(info, autoScale, unit)
    edits = self.objectAt("frameValues")
    typing = edits{"typing"}.getBool()
    asking = self.state{"confirm"}.getInt(-1)
  for i in 0 ..< fields.elems.len:
    let field = fields.elems[i]
    let name = field{"name"}.getStr()
    result.children.add look.row(field, current(edits, info, name), i, typing and name == "wifiSsid")
    if name == "rotate" and not look.paper:
      # A turned LCD copies every frame to its place (embedded_main.nim
      # packImageRgb565, 30 ms at 480x480): there is no drawing it turned.
      var c = look.grey
      c.px("text", look.size * 3 div 4)
      result.children.add el("div", move c, SvgNode(text: "Any rotation but 0\xc2\xb0 adds a noticeable delay to every frame of an animated scene."))
    elif name == "clockTime" and info{"wifi", "state"}.getStr() == "connected":
      var c = look.grey
      c.px("text", look.size * 3 div 4)
      result.children.add el("div", move c, SvgNode(text: "While this frame can reach the internet, its clock follows network time."))
  c = "flex flex-wrap"
  c.px("gap", look.gap div 2)
  let buttons = el("div", move c)
  buttons.children.add look.pressButton("Render again", ARender)
  if updateState == "available":
    buttons.children.add look.pressButton("Install update", AInstallUpdate, asking)
  elif updateState.len > 0 and updateState != "checking" and updateState != "installing":
    buttons.children.add look.pressButton("Check for updates", ACheckUpdate)
  if %"restart" in arrayOf(info{"actions"}).elems:
    buttons.children.add look.pressButton("Restart FrameOS", ARestart, asking)
  buttons.children.add look.pressButton("Reboot", AReboot, asking)
  result.children.add buttons

when not defined(frameosEmbedded):
  proc box(c: var string, x, y, w, h: int) =
    c.add "absolute"
    c.px("left", x)
    c.px("top", y)
    c.px("w", w)
    c.px("h", h)

  proc roundTree(self: SceneSettingsScene, look: Look, root: SvgNode, width, height: int, title: string,
      keyboardTop: int) =
    ## A round panel's: the scene's name in the top arc, Cancel and Save
    ## under it, and the fields in a list as wide as the circle is where the
    ## list ends, everything `RoundInset` in from the rim. With the keyboard
    ## up (on the circle's lower half, ui/keyboard.nim) the name makes way
    ## for the buttons and the list ends above the keys.
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
    buttons.children.add look.button("Cancel", HCancel, false)
    buttons.children.add look.button("Save", HSave, true)
    root.children.add buttons
    y += rowH + look.gap div 2
    # As far below the centre as it starts above it, or to the keyboard.
    let bottom = if keys: keyboardTop - look.gap div 2 else: 2 * cy - y
    half = max(chordHalf(radius, max(abs(y - cy), abs(bottom - cy))) - 2, 4)
    c.box(cx - half, y, 2 * half, max(bottom - y, 1))
    c.add " overflow-y-auto"
    root.children.add el("div", move c, self.fieldList(look, 2, look.gap div 2))

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
  result = el("div", move c)
  when not defined(frameosEmbedded):
    if round:
      self.roundTree(look, result, width, height, title, min(keyboardTop, height))
      return
  c = "shrink-0 flex items-center"
  c.px("h", look.line * 3 div 2)
  c.px("px", look.pad)
  c.px("gap", look.gap div 2)
  c.add(if paper: " border-b-2 border-black" else: " border-b border-zinc-800")
  let
    header = el("div", move c)
    frame = not info.isNil and self.onFrame()
    layoutPage = self.onLayoutPage()
  header.children.add look.button(if frame or layoutPage: "Back" else: "Cancel", HCancel, false)
  header.children.add el("span", "grow truncate text-center font-bold",
    SvgNode(text: if frame: "Frame settings" else: title))
  if not info.isNil and not layoutPage:
    header.children.add look.gear(frame)
  # Lit while there is something to save: after a Save it goes quiet, which
  # is how the frame page says it took it.
  let edits = if frame: self.state{"frameValues"} else: self.form(){"edited"}
  header.children.add look.button("Save", HSave, not edits.isNil and edits.len > 0)
  result.children.add header
  let body = if frame: self.frameList(look, info, scaleText(autoRenderScale(unit, unit, self.frameConfig.device)), unit)
    else: self.fieldList(look, look.pad, look.pad)
  result.children.add el("div", "flex-1 overflow-y-auto", body)

proc title(self: SceneSettingsScene): string =
  ## The scene's name, from the host's scene list (its id without one).
  if self.onLayoutPage():
    return "Layout settings"
  result = self.opener()
  if not sceneSwitcherListing.isNil:
    try:
      let entries = sceneSwitcherListing()
      for i in 0 ..< entries.len:
        if entries[i].id == result and entries[i].name.len > 0:
          return entries[i].name
    except Exception:
      discard

proc drawForm*(self: SceneSettingsScene, image: Image) =
  ## One render: laid out, drawn into `image`, and the form left behind for
  ## the pointer and the keyboard; back by itself once nobody has touched it
  ## for a while (the switcher's `drawUi`).
  self.paper = paperPanel(self.frameConfig, image)
  let round = isRound(self.frameConfig)
  # At the frame's render scale, as its scenes are (sceneSwitcher's uiRoom).
  let (roomW, roomH) = uiRoom(self.frameConfig, image.width, image.height)
  var keyboardTop = high(int)
  if round:
    # The keyboard is up: where it will go (ui/layout.nim asks the same).
    let target = uiTarget(SceneSettingsId, SettingsNode, create = false)
    if not target.isNil and target.input.keyboard and target.input.focus > 0:
      keyboardTop = keyboardBox(roomW, roomH, true)[0]
  let info = if round: nil else: frameInfo()
  if info.isNil and self.onFrame():
    self.showPage(false)
  if self.drawUi(SceneSettingsId, self.tree(roomW, roomH, self.paper, self.title(), round,
      keyboardTop, info, min(image.width, image.height)), image, self.paper, onHandler, IdleSeconds,
      roomW, roomH):
    leave()

proc back(self: SceneSettingsScene) =
  ## One step back: from the frame page to the scene's form, from the form
  ## to the scene.
  if self.onLayoutPage():
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

proc settingsOwnRun(self: FrameScene, context: ExecutionContext) {.nimcall.} =
  ## What raises here is reported by the caller, as for any scene. The
  ## payload is read with `{}` alone, which answers nil for what is missing.
  let self = SceneSettingsScene(self)
  let payload = context.payload
  case context.event
  of "setCurrentScene":
    # What the dispatcher read off the scene it was opened from.
    for key in ["from", "fields", "values", "opened", "layout"]:
      let value = payload{"state", key}
      if not value.isNil:
        self.state.put(key, value)
    # It opens on the scene's form; with no scene showing there is nothing
    # on that one, and the frame page is what the status screen sent you here
    # for.
    if self.state{"page"}.isNil and (self.opener().len == 0 or self.openedOnFrame()) and not frameInfo().isNil:
      self.showPage(true)
  of "open":
    self.touch()
  of "close":
    # Opened again, it starts afresh: no field has the keyboard, the list is
    # at its top, and it knows no scene until the dispatcher says.
    if self.onFrame():
      frameAction("close")
    forgetUiTarget(SceneSettingsId, SettingsNode)
    self.state = newJObject()
  of "render":
    if context.hasImage and not context.image.isNil:
      self.drawForm(context.image)
  of "button":
    if payload{"role"}.getStr() == "back" and payload{"action"}.getStr() == "press":
      self.back()
  of evBack:
    # The frame's back (a swipe in from the left), as on a phone: the
    # keyboard goes away first, then the frame page, then the form, unsaved.
    if dismissKeyboard(SceneSettingsId, SettingsNode):
      self.touch()
      sendEvent(evRender, newJObject(), eoScene)
    else:
      self.back()
  else:
    # The pointer, and keys for a field (ui/events.nim hit-tests them). E-paper
    # shows no press: what only moves the press waits for a tap.
    acted = -1
    let changed = dispatchUiEvent(SceneSettingsId, context.event, context.payload)
    if acted >= 0:
      self.acting()
    if changed or acted >= 0:
      self.touch()
      if not self.paper or context.event in ["tap", "pointerUp", "keyDown", "textInput"]:
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
  let paper = paperPanel(frameConfig)
  SceneSettingsScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(), ownRun: settingsOwnRun,
    shownName: "Scene settings", refreshInterval: IdleSeconds, backgroundColor: background(paper), paper: paper)

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
