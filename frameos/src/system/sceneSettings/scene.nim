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
## the idle timeout dispatch `sceneSettings`, which goes back without them.
##
## Drawn with the JSX layout (ui/layout.nim) from a tree built here in Nim,
## with the layout's fields, the keyboard on the screen and a list that
## scrolls: no QuickJS. Flash is the budget on an ESP32 (AGENTS.md): one
## handler for everything (numbered), classes appended in place, and no Nim
## checks in this module (every index is guarded by its loop).

import std/[json, options, parseutils, strutils, tables, times]
import pixie
import pixie/fileformats/svg
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/ui/layout
import frameos/ui/events
import frameos/utils/image
import frameos/utils/svg_frames
import system/sceneSwitcher/scene as switcher

{.push overflowChecks: off, rangeChecks: off, boundChecks: off, fieldChecks: off, stackTrace: off,
  lineTrace: off.}

type
  SceneSettingsScene* = ref object of FrameScene
    paper*: bool ## drawn for e-paper last time (switcher.paperPanel)

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

proc touch(self: SceneSettingsScene) =
  ## Somebody did something: the idle timeout starts over.
  self.state.put("touchedAt", newJFloat(epochTime()))

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
  for field in self.fieldList():
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
    if index >= 0 and index < fields.len:
      let field = fields[index]
      let name = field{"name"}.getStr()
      let values = self.valueMap()
      if handler >= HChoice:
        let choice = (handler - HChoice) mod 100
        let options = field{"options"}
        if not options.isNil and choice < options.len:
          values.put(name, newJString(options[choice]{"value"}.getStr()))
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

proc el(tag: string, classes: sink string, child: sink SvgNode = nil): SvgNode =
  result = SvgNode(tag: tag, attrs: @[("class", classes)])
  if not child.isNil:
    result.children.add child

proc px(c: var string, name: string, v: int) =
  c.add ' '
  c.add name
  c.add "-["
  c.addInt v
  c.add "px]"

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
  if not options.isNil and options.kind == JArray and options.len > 0:
    # Choices: one tap picks one.
    c = "flex flex-wrap"
    c.px("gap", look.gap div 2)
    let chips = el("div", move c)
    let current = value.text
    for j in 0 ..< min(options.len, 100):
      let option = options[j]
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

proc tree*(self: SceneSettingsScene, width, height: int, paper: bool, title: string): SvgNode =
  ## The panel as a UI tree: a header with Cancel, the scene's name and
  ## Save, and under it the fields in a list that scrolls.
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
  c = "flex flex-col"
  c.px("p", look.pad)
  c.px("gap", look.gap)
  let list = el("div", move c)
  let
    fields = self.fieldList()
    values = self.valueMap()
  for i in 0 ..< fields.len:
    let field = fields[i]
    if field.kind == JObject and field{"type"}.getStr() notin Unedited:
      list.children.add look.row(field, values{field{"name"}.getStr()}, i)
  if list.children.len == 0:
    c = "text-center"
    if not paper: c.add " text-zinc-400"
    list.children.add el("div", move c, SvgNode(text: "This scene has no settings."))
  result.children.add el("div", "flex-1 overflow-y-auto", list)

proc title(self: SceneSettingsScene): string =
  ## The scene's name, from the host's scene list (its id without one).
  result = self.opener()
  if not sceneSwitcherListing.isNil:
    try:
      for entry in sceneSwitcherListing():
        if entry.id == result and entry.name.len > 0:
          return entry.name
    except Exception:
      discard

proc draw*(self: SceneSettingsScene, image: Image) =
  ## One render: laid out, drawn into `image`, and the form left behind for
  ## the pointer and the keyboard.
  self.paper = paperPanel(self.frameConfig, image)
  let target = uiTarget(SceneSettingsId, SettingsNode)
  target.input.paper = self.paper
  var regions: seq[UiRegion]
  let svg = layoutUi(self.tree(image.width, image.height, self.paper, self.title()),
    image.width, image.height, target.input, regions, target.memo)
  let bg = if self.paper: color(1, 1, 1, 1) else: color(0.035, 0.035, 0.043, 1)
  var owed = some(bg)
  if not renderSvgFrame(svg, image, owed, wholeFrame = true, reuse = true):
    discard renderSvgIntoTarget(svg, image, owed)
  if owed.isSome:
    image.fill(bg)
  target.regions = move(regions)
  target.offsetX = 0
  target.offsetY = 0
  target.call = onHandler
  # Back by itself once nobody has touched it for a while; until then, a
  # render when that time is up.
  let
    idle = IdleSeconds
    now = epochTime()
    since = now - self.state{"touchedAt"}.getFloat(now)
  if since >= idle:
    leave()
    self.refreshInterval = idle
  else:
    self.refreshInterval = max(idle - since, 1.0)

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
      self.draw(context.image)
  of "button":
    if payload{"role"}.getStr() == "back" and payload{"action"}.getStr() == "press":
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
  if not context.hasImage or context.image.isNil:
    let (w, h) =
      if self.frameConfig.rotate == 90 or self.frameConfig.rotate == 270: (self.frameConfig.height, self.frameConfig.width)
      else: (self.frameConfig.width, self.frameConfig.height)
    context.image = newImage(max(w, 1), max(h, 1))
    context.hasImage = true
  runSettings(self, context)
  context.image

proc initSettings(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  ## Nothing persisted to start from: what it shows comes with the switch.
  let paper = paperPanel(frameConfig)
  SceneSettingsScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(),
    refreshInterval: IdleSeconds, backgroundColor: if paper: color(1, 1, 1, 1) else: color(0.035, 0.035, 0.043, 1),
    paper: paper)

var exportedScene* = ExportedInterpretedScene(
  name: "Scene settings",
  refreshInterval: IdleSeconds,
  backgroundColor: color(0.035, 0.035, 0.043, 1),
  init: initSettings,
  runEvent: runSettings,
  render: renderSettings,
)
  ## An interpreted scene's export (with no nodes of its own), so a host that
  ## holds one scene (single_scene_host) keeps it like any other.

{.pop.}
