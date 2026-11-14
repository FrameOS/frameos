## The terminal, `system/terminal` (docs/terminal.md): the frame's console on
## its own screen. A line to type the commands an ESP32's serial console takes
## (system/terminal/commands.nim), and the frame's answers above it, scrolling.
##
## Built into the runtimes that run scenes side by side, the Linux runner
## (system/scenes.nim) and the browser's (frameos/single_scene_host.nim), and
## shown like the scene switcher and the scene settings: `terminal`
## (docs/events-contract.json) opens it, and the dispatcher (event_loop.nim)
## hands it `state.from`, the scene it was opened from, and that scene's public
## values. The same command, a `back` or its idle timeout goes back there; on a
## desktop of windows it stays open as a window while another has the focus
## (docs/scene-layouts.md "Windows"). Not on an ESP32: its console is its
## serial port, and its flash has no room for a second one.
##
## Drawn with the JSX layout (ui/layout.nim) from a tree built here, the line
## a field with the keyboard (ui/events.nim): a key typed on a keyboard goes
## to it at once, a tap on it brings the keyboard on the screen up.

import std/[json, strutils, tables]
import pixie
import pixie/fileformats/svg
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/ui/layout
import frameos/ui/events
import frameos/ui/theme
import frameos/ui/tree
from frameos/scene_rhythm import builtInRunner
import system/sceneSwitcher/scene as switcher
import system/sceneSettings/scene as settings
import ./commands

type
  TerminalScene* = ref object of FrameScene
    paper*: bool
    lines*: seq[string]   ## what it has said, each command typed among it
    history*: seq[string] ## the commands typed, oldest first
    browsing: int         ## where ArrowUp has got to in `history`; its length while a new line is typed
    typed*: string        ## the line being typed
    scanning: bool        ## a `wifi-scan` waits for its networks
    focusWanted: bool     ## the line gets the keyboard at the next chance

const
  TerminalNode = 1 ## the ui/events target its line lives in
  IdleSeconds* = 300.0
    ## How long it waits for a key before it goes back by itself, as the
    ## scene settings do; a window left open on a desktop waits for good.
  MaxLines = 200
  MaxHistory = 50
  HText = 1
  HKey = 2
  CommandMark* = "\x01"
    ## Before a command typed, in `lines`: drawn after the prompt, as it was typed.
  Banner = "FrameOS terminal: the commands of an ESP32's serial console. Type help."

var
  # What the last handler did, read once the hit test is done.
  acted {.threadvar.}: int
  actedText {.threadvar.}: string
  wentBack {.threadvar.}: bool
    ## It went back by itself (a scene picked, its timeout, `back`), not merely
    ## lost the focus to a window beside it: its "close" ends it.

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  node.fields[key] = value

proc opener(self: TerminalScene): string =
  self.state{"from"}.getStr()

proc say(self: TerminalScene, lines: openArray[string]) =
  for line in lines:
    self.lines.add line
  if self.lines.len > MaxLines:
    self.lines = self.lines[self.lines.len - MaxLines .. ^1]
  self.focusWanted = true

proc startAfresh(self: TerminalScene) =
  ## Nothing typed, nothing said: what the dispatcher hands over next is all
  ## it knows.
  forgetUiTarget(SceneTerminalId, TerminalNode)
  self.state = newJObject()
  self.lines = @[Banner]
  self.history = @[]
  self.browsing = 0
  self.typed = ""
  self.scanning = false
  self.focusWanted = true

proc leave() =
  ## Back to the scene it was opened from: the dispatcher knows which.
  wentBack = true
  sendEvent(evTerminal, newJObject(), eoScene)

# ------------------------------------------------------------------ the line

proc lineRegion(target: UiTarget): int =
  ## The line's region in the last render: its only field.
  for i in 0 ..< target.regions.len:
    if target.regions[i].field == 1:
      return i
  -1

proc keepFocus(self: TerminalScene, keyboard: bool) =
  ## The line has the keyboard, holding what is typed, its end in view: so a
  ## key typed on a keyboard goes into it, and after a command the next one
  ## can be typed at once. `keyboard`: the one on the screen stays up.
  let target = uiTarget(SceneTerminalId, TerminalNode, create = false)
  if target.isNil:
    return
  let r = target.lineRegion()
  if r < 0:
    return
  target.input.focus = target.regions[r].key + 1
  target.input.text = self.typed
  target.input.caret = self.typed.len
  target.input.keyboard = keyboard
  target.input.reveal = true
  self.focusWanted = false

proc submit(self: TerminalScene) =
  let line = self.typed
  self.typed = ""
  self.say([CommandMark & line])
  if line.strip().len > 0:
    if self.history.len == 0 or self.history[^1] != line:
      self.history.add line
      if self.history.len > MaxHistory:
        self.history.delete(0)
  self.browsing = self.history.len
  let outcome = run(line, self.frameConfig, self.opener(), self.state{"values"})
  self.say(outcome.lines)
  if outcome.scanning:
    self.scanning = true
  if outcome.picked:
    # A scene picked goes there, as the scene switcher's tiles do.
    wentBack = true

proc browse(self: TerminalScene, back: bool) =
  ## ArrowUp and ArrowDown: the commands typed before, and back to a new line.
  if self.history.len == 0:
    return
  self.browsing = clamp(self.browsing + (if back: -1 else: 1), 0, self.history.len)
  self.typed = if self.browsing < self.history.len: self.history[self.browsing] else: ""

proc acting(self: TerminalScene, keyboard: bool) =
  let handler = acted
  acted = -1
  if handler == HText:
    self.typed = actedText
  elif handler == HKey:
    case actedText
    of "Enter":
      self.submit()
      self.keepFocus(keyboard)
    of "ArrowUp", "ArrowDown":
      self.browse(actedText == "ArrowUp")
      self.keepFocus(keyboard)
    else:
      discard

proc onHandler(handler: int, name: string, event: JsonNode, hit: UiHit) {.raises: [].} =
  ## The line's one handler, run by the hit test: what it was, for `acting`.
  acted = handler
  actedText = if handler == HKey: event{"key"}.getStr() else: event{"value"}.getStr()

# --------------------------------------------------------------- the picture

proc shown(line: string): string =
  ## The line as the layout keeps it: it folds spaces into one, as HTML does,
  ## so the console's indents and columns are no-break spaces, each run but
  ## its last, which a long line may still break at.
  const Nbsp = "\xc2\xa0"
  var i = 0
  while i < line.len:
    if line[i] != ' ':
      result.add line[i]
      inc i
      continue
    var j = i
    while j < line.len and line[j] == ' ':
      inc j
    for k in i ..< j:
      result.add(if k == j - 1 and i > 0 and j < line.len: " " else: Nbsp)
    i = j

proc prompt(paper: bool): SvgNode =
  ## `frameos>`, green on a screen, bold on e-paper, or the layout theme's
  ## `prompt` (ui/theme.nim).
  el("span", if paper: "shrink-0 font-bold" else: "shrink-0 font-bold text-emerald-400", SvgNode(text: Prompt)).role("prompt")

proc tree*(self: TerminalScene, width, height: int, paper: bool, sizeUnit = 0): SvgNode =
  ## Everything said, one line under the other, and the prompt with the line
  ## being typed under the last, in a box that scrolls: a terminal's.
  let unit = if sizeUnit > 0: sizeUnit else: min(width, height)
  let size = clamp(unit * 32 div 1000, 12, 24)
  var c = "flex flex-col h-full font-mono"
  c.px("text", size)
  c.add(if paper: " bg-white text-black" else: " bg-black text-zinc-100")
  result = el("div", move c).role("terminal")
  c = "flex-1 overflow-y-auto flex flex-col"
  c.px("px", size div 2)
  c.px("py", size div 3)
  let box = el("div", move c)
  # The lines in a box of their own: an element's key is its place among its
  # siblings (ui/layout.nim), and the line with the keyboard keeps its own
  # however many lines come before it.
  let said = el("div", "flex flex-col")
  for line in self.lines:
    c = ""
    c.px("min-h", size * 3 div 2)
    if line.startsWith(CommandMark):
      # A command typed: the prompt it was typed at, green, so the commands
      # stand out from what they said.
      c.add " flex"
      c.px("gap", size div 2)
      let row = el("div", move c, prompt(paper))
      row.children.add el("span", "min-w-0", SvgNode(text: shown(line[CommandMark.len .. ^1])))
      said.children.add row
    else:
      said.children.add el("div", move c, SvgNode(text: shown(line)))
  box.children.add said
  c = "shrink-0 flex items-center"
  c.px("gap", size div 2)
  let typing = el("div", move c)
  typing.children.add prompt(paper)
  c = "flex-1 min-w-0 bg-transparent"
  c.px("h", size * 3 div 2)
  let input = el("input", move c)
  input.attrs.add(("value", self.typed))
  input.attrs.add(("on-change", $HText))
  input.attrs.add(("on-key-down", $HKey))
  typing.children.add input
  box.children.add typing
  result.children.add box

proc draw*(self: TerminalScene, image: Image) =
  ## One render: what a scan found, the tree laid out and drawn, and the line
  ## given the keyboard once there is a line to give it to. Back by itself
  ## once nobody has typed for a while.
  if self.scanning and scanDone():
    self.scanning = false
    self.say(scanLines())
  self.paper = paperPanel(self.frameConfig, image)
  let (roomW, roomH) = uiRoom(self.frameConfig, image.width, image.height)
  let gone = self.drawUi(SceneTerminalId, self.tree(roomW, roomH, self.paper, self.sizeUnit(image)),
    image, self.paper, onHandler, IdleSeconds, roomW, roomH)
  if self.scanning:
    # Its networks come in a moment: look again then.
    self.refreshInterval = 1.0
    self.refreshIntervalDefault = 1.0
  if gone:
    leave()
  elif self.focusWanted and not self.state{"away"}.getBool():
    let target = uiTarget(SceneTerminalId, TerminalNode, create = false)
    self.keepFocus(not target.isNil and target.input.keyboard)
    if not self.focusWanted:
      # The caret, and the end of what was said, in the next picture.
      sendEvent(evRender, newJObject(), eoScene)

# ------------------------------------------------------------ the scene

proc terminalOwnRun(self: FrameScene, context: ExecutionContext) {.nimcall.} =
  let self = TerminalScene(self)
  let payload = context.payload
  case context.event
  of "setCurrentScene":
    # Opened from a scene (the dispatcher says which, `from`): afresh. Brought
    # forward again from a window, the switch says nothing, and it is as it was.
    if not payload{"state", "from"}.isNil:
      self.startAfresh()
    for key in ["from", "values", "layout"]:
      let value = payload{"state", key}
      if not value.isNil:
        self.state.put(key, value)
  of "open":
    self.touch()
    wentBack = false
    if self.state.hasKey("away"):
      self.state.delete("away")
    self.focusWanted = true
    if not settings.frameSettingsAction.isNil:
      # The host's news of the frame (its Wi-Fi) for `status`, as the frame
      # page asks for it.
      settings.frameSettingsAction("open")
  of "close":
    if not settings.frameSettingsAction.isNil:
      settings.frameSettingsAction("close")
    if wentBack or not builtInScenesStay:
      wentBack = false
      self.startAfresh()
    else:
      # The focus went to a window beside it: it stays open there as it was.
      self.state.put("away", newJBool(true))
  of "render":
    if context.hasImage and not context.image.isNil:
      self.draw(context.image)
  of "button":
    if payload{"role"}.getStr() == "back" and payload{"action"}.getStr() == "press":
      leave()
  of evBack:
    # The frame's back (a swipe in from the left): the keyboard on the screen
    # goes first, then the terminal. The line always has the keyboard, so it
    # is the one on the screen that counts here.
    let target = uiTarget(SceneTerminalId, TerminalNode, create = false)
    if not target.isNil and target.input.keyboard and dismissKeyboard(SceneTerminalId, TerminalNode):
      self.touch()
      sendEvent(evRender, newJObject(), eoScene)
    else:
      leave()
  else:
    let target = uiTarget(SceneTerminalId, TerminalNode, create = false)
    if context.event in ["keyDown", "textInput"] and not target.isNil and target.input.focus == 0:
      # Typed with nothing focused (Escape let it go): the line again.
      self.keepFocus(false)
    let keyboard = not target.isNil and target.input.keyboard
    acted = -1
    let changed = dispatchUiEvent(SceneTerminalId, context.event, context.payload)
    if acted >= 0:
      self.acting(keyboard)
    if changed or acted >= 0:
      self.touch()
      sendEvent(evRender, newJObject(), eoScene)

proc runTerminal(self: FrameScene, context: ExecutionContext) =
  if builtInRunner.isNil or not builtInRunner(self, context):
    terminalOwnRun(self, context)

proc renderTerminal(self: FrameScene, context: ExecutionContext): Image =
  self.ensureCanvas(context)
  runTerminal(self, context)
  context.image

proc initTerminal(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  ## Nothing persisted to start from: what it shows comes with the switch.
  let paper = paperPanel(frameConfig)
  result = TerminalScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(),
    ownRun: terminalOwnRun, shownName: "Terminal", refreshInterval: IdleSeconds,
    backgroundColor: background(paper), paper: paper, lines: @[Banner], focusWanted: true)

var exportedScene* = ExportedInterpretedScene(
  name: "Terminal",
  refreshInterval: IdleSeconds,
  backgroundColor: background(false),
  init: initTerminal,
  runEvent: runTerminal,
  render: renderTerminal,
)
  ## An interpreted scene's export (with no nodes of its own), so a host that
  ## holds one scene (single_scene_host) keeps it like any other.
