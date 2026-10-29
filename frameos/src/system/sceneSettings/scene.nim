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
import frameos/ui/layout
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

const
  SettingsNode = 1 ## the ui/events target its form lives in
  IdleSeconds* = 300.0
    ## How long it waits for a touch or a key before it goes back unsaved:
    ## five minutes, as long as an ESP32 that deep-sleeps stays up for it
    ## (fos_scenes.c BUILT_IN_SCENE_AWAKE_MS).
  # What a handler number means: Cancel, Save, then per field (by its index
  # in `state.fields`) a field's text, a switch, or one of its choices.
  HCancel = 0
  HSave = 1
  HText = 1000
  HToggle = 2000
  HChoice = 3000 ## + field * 100 + choice
  # The types the panel cannot edit: what they hold is not text.
  Unedited = ["node", "scene", "image"]

var
  # What the last handler did: its number and the text it carried. Read by
  # runEvent once the hit test is done, so the handler holds nothing.
  acted {.threadvar.}: int
  actedText {.threadvar.}: string

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  ## `node[key] = value` for an object node, without json's assert.
  node.fields[key] = value

# ------------------------------------------------------------------ values

proc fieldList(self: SceneSettingsScene): JsonNode =
  result = self.state{"fields"}
  if result.isNil or result.kind != JArray:
    result = newJArray()

proc valueMap(self: SceneSettingsScene): JsonNode =
  result = self.state{"values"}
  if result.isNil or result.kind != JObject:
    result = newJObject()
    self.state.put("values", result)

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
  ## parses). nil when a number field holds no number: that one is not saved.
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
  elif value.isNil: nil
  else: newJString(value.text)

proc opener(self: SceneSettingsScene): string =
  self.state{"from"}.getStr()

proc leave() =
  ## Back to the scene it was opened from, nothing saved: the dispatcher
  ## knows which.
  sendEvent(evSceneSettings, newJObject(), eoScene)

proc save(self: SceneSettingsScene) =
  ## Back to the scene, its fields set to the values here.
  if self.opener().len == 0:
    leave()
    return
  let
    state = newJObject()
    values = self.valueMap()
    fields = self.fieldList()
  for i in 0 ..< fields.elems.len:
    let field = fields.elems[i]
    let name = field{"name"}.getStr()
    let value = field.saved(values{name})
    if not value.isNil:
      state.put(name, value)
  let payload = newJObject()
  payload.put("sceneId", newJString(self.opener()))
  payload.put("state", state)
  sendEvent(evSetCurrentScene, payload, eoScene)

proc acting(self: SceneSettingsScene) =
  ## What the last handler did, to the values.
  let
    fields = self.fieldList()
    handler = acted
  acted = -1
  if handler == HCancel: leave()
  elif handler == HSave: self.save()
  else:
    let
      index = if handler >= HChoice: (handler - HChoice) div 100 elif handler >= HToggle: handler - HToggle
        else: handler - HText
    if index >= 0 and index < fields.elems.len:
      let field = fields.elems[index]
      let name = field{"name"}.getStr()
      let values = self.valueMap()
      if handler >= HChoice:
        let choice = (handler - HChoice) mod 100
        let options = field{"options"}
        if not options.isNil and options.kind == JArray and choice < options.elems.len:
          values.put(name, newJString(options.elems[choice]{"value"}.getStr()))
      elif handler >= HToggle:
        values.put(name, newJBool(not values{name}.isOn))
      else:
        values.put(name, newJString(actedText))
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

proc fieldBox(look: Look): string =
  result = "w-full rounded-lg"
  result.px("px", look.size * 2 div 3)
  if look.paper: result.add " border-2 border-black"
  else: result.add " bg-zinc-800 focus:bg-zinc-700 placeholder:text-zinc-500"

proc row(look: Look, field: JsonNode, value: JsonNode, index: int): SvgNode =
  ## One field: its label and what changes it.
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
  if not options.isNil and options.kind == JArray and options.elems.len > 0:
    # Choices: one tap picks one.
    c = "flex flex-wrap"
    c.px("gap", look.gap div 2)
    let chips = el("div", move c)
    let current = value.text
    for j in 0 ..< min(options.elems.len, 100):
      let option = options.elems[j]
      var name = option{"label"}.getStr()
      if name.len == 0:
        name = option{"value"}.getStr()
      c = "flex items-center rounded-full"
      c.px("h", look.line * 4 div 5)
      c.px("px", look.size * 3 div 4)
      let picked = option{"value"}.getStr() == current
      if look.paper:
        c.add(if picked: " bg-black text-white border-2 border-black" else: " border-2 border-black")
      else:
        c.add(if picked: " bg-sky-600" else: " bg-zinc-800 active:bg-zinc-600")
      chips.children.add el("div", move c, SvgNode(text: name)).on("on-click", HChoice + index * 100 + j)
    result.children.add chips
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
  input.attrs.add(("placeholder", field{"placeholder"}.getStr()))
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
    result.children.add el("div", move c, SvgNode(text: "This scene has no settings."))

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
    keyboardTop = high(int)): SvgNode =
  ## The panel as a UI tree: a header with Cancel, the scene's name and
  ## Save, and under it the fields in a list that scrolls. On a `round`
  ## panel the same inside its circle, the keyboard's top at `keyboardTop`
  ## while it is up.
  let unit = min(width, height)
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
  let header = el("div", move c)
  header.children.add look.button("Cancel", HCancel, false)
  header.children.add el("span", "grow truncate text-center font-bold", SvgNode(text: title))
  header.children.add look.button("Save", HSave, true)
  result.children.add header
  result.children.add el("div", "flex-1 overflow-y-auto", self.fieldList(look, look.pad, look.pad))

proc title(self: SceneSettingsScene): string =
  ## The scene's name, from the host's scene list (its id without one).
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
  var keyboardTop = high(int)
  if round:
    # The keyboard is up: where it will go (ui/layout.nim asks the same).
    let target = uiTarget(SceneSettingsId, SettingsNode, create = false)
    if not target.isNil and target.input.keyboard and target.input.focus > 0:
      keyboardTop = keyboardBox(image.width, image.height, true)[0]
  if self.drawUi(SceneSettingsId, self.tree(image.width, image.height, self.paper, self.title(), round,
      keyboardTop), image, self.paper, onHandler, IdleSeconds):
    leave()

# ------------------------------------------------------------ the scene

proc runSettings(self: FrameScene, context: ExecutionContext) =
  ## What raises here is reported by the caller, as for any scene. The
  ## payload is read with `{}` alone, which answers nil for what is missing.
  let self = SceneSettingsScene(self)
  let payload = context.payload
  case context.event
  of "setCurrentScene":
    # What the dispatcher read off the scene it was opened from.
    for key in ["from", "fields", "values"]:
      let value = payload{"state", key}
      if not value.isNil:
        self.state.put(key, value)
  of "open":
    self.touch()
  of "close":
    # Opened again, it starts afresh: no field has the keyboard, the list is
    # at its top, and it knows no scene until the dispatcher says.
    forgetUiTarget(SceneSettingsId, SettingsNode)
    self.state = newJObject()
  of "render":
    if context.hasImage and not context.image.isNil:
      self.drawForm(context.image)
  of "button":
    if payload{"role"}.getStr() == "back" and payload{"action"}.getStr() == "press":
      leave()
  of evBack:
    # The frame's back (a swipe in from the left), as on a phone: the
    # keyboard goes away first, then the form, unsaved.
    if dismissKeyboard(SceneSettingsId, SettingsNode):
      self.touch()
      sendEvent(evRender, newJObject(), eoScene)
    else:
      leave()
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

proc renderSettings(self: FrameScene, context: ExecutionContext): Image =
  self.ensureCanvas(context)
  runSettings(self, context)
  context.image

proc initSettings(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  ## Nothing persisted to start from: what it shows comes with the switch.
  let paper = paperPanel(frameConfig)
  SceneSettingsScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(),
    refreshInterval: IdleSeconds, backgroundColor: background(paper), paper: paper)

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
