## The scene switcher, `system/sceneSwitcher` (docs/scene-switcher.md): every
## scene on the frame as a tile with its title, in the frame's scene list
## order, to tap, or to walk with the buttons and pick.
##
## Built into every runtime (the Linux runner registers it with the system
## scenes, frameos/single_scene_host builds it for the ESP32 and the preview)
## and shown like any scene. `sceneSwitcher` (docs/events-contract.json) opens
## it, and the dispatcher (event_loop.nim) hands it `state.from`, the scene it
## was opened from; the same event while it shows goes back there, which is
## what its Close button, a `back` key and its idle timeout dispatch.
##
## It is drawn with the JSX layout (ui/layout.nim): the tree is built here, in
## Nim, so it needs no QuickJS, and its taps are hit-tested by ui/events.nim
## like a JS app's UI. A fast panel gets a dark grid with each scene's last
## picture where the host keeps one (`sceneSwitcherThumbnail`: the Linux
## runner's scene snapshots); e-paper gets black on white with the
## highlighted tile inverted, so it reads on a one-bit panel and follows the
## keys. The scene list is the host's (`sceneSwitcherListing`): the order
## `setCurrentScene {direction}` walks, with each scene's name.

import std/[json, math, options, strutils, times]
import pixie
import pixie/fileformats/svg
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/ui/layout
import frameos/ui/events
import frameos/utils/font
import frameos/utils/image
import frameos/utils/svg_frames

type
  SwitcherEntry* = object
    id*, name*: string

  SwitcherListing* = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.}
    ## The frame's scenes in its scene list's order, with their names.
  SwitcherThumbnail* = proc (frameConfig: FrameConfig, sceneId: string,
      width, height: int): Image {.nimcall, gcsafe.}
    ## A scene's last picture, `width` x `height` exactly, or nil.

  SwitcherGrid* = object
    ## Where the tiles go: `perPage` of them, `cols` across, from (x0, y0).
    cols*, rows*, perPage*, pages*: int
    tileW*, tileH*, gap*, x0*, y0*, pad*, headerH*: int

  SceneSwitcherScene* = ref object of FrameScene
    entries*: seq[SwitcherEntry] ## what the last render or key listed
    paper*: bool ## drawn for e-paper last time (paperPanel)

const
  SwitcherNode = 1 ## the ui/events target its tiles live in
  IdleSecondsFast* = 60.0
  IdleSecondsPaper* = 300.0
  MaxCols = 6
  MaxRows = 6

var
  sceneSwitcherListing*: SwitcherListing
  sceneSwitcherThumbnail*: SwitcherThumbnail
  # A page arrow's tap, for runEvent to act on once the hit test is done:
  # the handler holds no reference to the scene.
  pageAsked {.threadvar.}: int

proc isBuiltInScene*(sceneId: string): bool =
  ## A scene the runtime draws itself, on every host: no slot, no file.
  sceneId == SceneSwitcherId

# ------------------------------------------------------------------ the model

proc listEntries(): seq[SwitcherEntry] =
  if sceneSwitcherListing.isNil:
    return @[]
  try:
    result = sceneSwitcherListing()
  except Exception:
    result = @[]

proc paperPanel*(frameConfig: FrameConfig, canvas: Image = nil): bool =
  ## Whether the switcher is drawn for e-paper (black on white, no press
  ## feedback): any panel that is not an LCD. An LCD's canvas is its RGB565
  ## buffer; an ESP32 with any other canvas is e-paper or a monochrome OLED.
  if not canvas.isNil and canvas.format == pfRgb565:
    return false
  if frameConfig.isNil:
    return false
  let device = frameConfig.device
  device == "embedded" or device.startsWith("waveshare.") or device.startsWith("inky") or
    device.startsWith("pimoroni.inky")

proc idleSeconds*(paper: bool): float =
  ## How long the switcher waits for a touch or a key before it goes back.
  if paper: IdleSecondsPaper else: IdleSecondsFast

proc canvasSize(frameConfig: FrameConfig): (int, int) =
  if frameConfig.rotate in [90, 270]: (frameConfig.height, frameConfig.width)
  else: (frameConfig.width, frameConfig.height)

proc switcherGrid*(count, width, height: int, thumbnails: bool): SwitcherGrid =
  ## The tile grid for `count` scenes on a `width` x `height` canvas: every
  ## scene on one page while the tiles stay big enough to read, else as many
  ## per page as fit. Among the grids that hold them all, the one whose
  ## pictures (at the canvas's own aspect) or name cards come out largest.
  let unit = min(width, height).float
  result.pad = clamp(int(round(unit * 0.035)), 4, 24)
  result.gap = clamp(int(round(unit * 0.025)), 3, 16)
  result.headerH = clamp(int(round(unit * 0.11)), 18, 64)
  result.x0 = result.pad
  result.y0 = result.headerH + result.gap
  let
    gw = max(width - 2 * result.pad, 1)
    gh = max(height - result.y0 - result.pad, 1)
    minW = min(clamp(unit * 0.2, 48, 200), gw.float)
    minH = min(clamp(unit * 0.15, 36, 160), gh.float)
    aspect = width.float / max(height, 1).float
  var
    best = -1.0
    bestFits = false
  for cols in 1 .. MaxCols:
    for rows in 1 .. MaxRows:
      let
        tw = (gw - result.gap * (cols - 1)) div cols
        th = (gh - result.gap * (rows - 1)) div rows
      if tw.float < minW or th.float < minH:
        continue
      let capacity = cols * rows
      let fits = capacity >= max(count, 1)
      var quality: float
      if thumbnails:
        # The picture: what is left under the title, at the canvas's aspect.
        let
          titleH = clamp(th.float * 0.2, 14, 44)
          pw = min(tw.float * 0.9, max(th.float - titleH, 1) * 0.9 * aspect)
        quality = pw * pw / aspect
      else:
        # A card with a name: as large as it gets, not much taller than wide.
        quality = min(tw.float, th.float * 2.2) * min(th.float, tw.float * 1.2)
      # A grid that holds them all beats one that pages; among those that
      # page, the one that holds the most.
      let score = if fits: quality else: capacity.float
      if (fits and not bestFits) or (fits == bestFits and score > best):
        best = score
        bestFits = fits
        result.cols = cols
        result.rows = rows
        result.tileW = tw
        result.tileH = th
  if result.cols == 0:
    result.cols = 1
    result.rows = 1
    result.tileW = gw
    result.tileH = gh
  result.perPage = result.cols * result.rows
  result.pages = max(1, (count + result.perPage - 1) div result.perPage)

proc grid(self: SceneSwitcherScene, width, height: int): SwitcherGrid =
  switcherGrid(self.entries.len, width, height, not sceneSwitcherThumbnail.isNil)

proc grid(self: SceneSwitcherScene): SwitcherGrid =
  let (width, height) = canvasSize(self.frameConfig)
  self.grid(width, height)

proc indexOf(self: SceneSwitcherScene, sceneId: string): int =
  for i, entry in self.entries:
    if entry.id == sceneId:
      return i
  -1

proc highlighted*(self: SceneSwitcherScene): int =
  ## The highlighted tile, the first when the highlight names no scene on the
  ## list; -1 for an empty list.
  if self.entries.len == 0:
    return -1
  max(self.indexOf(self.state{"highlight"}.getStr()), 0)

proc touch(self: SceneSwitcherScene) =
  ## Somebody did something: the idle timeout starts over.
  self.state["touchedAt"] = %epochTime()

proc highlight(self: SceneSwitcherScene, index: int) =
  ## The tile at `index` (wrapping around) highlighted, and its page shown.
  if self.entries.len == 0:
    return
  let i = ((index mod self.entries.len) + self.entries.len) mod self.entries.len
  self.state["highlight"] = %self.entries[i].id
  self.state["page"] = %(i div max(self.grid().perPage, 1))

proc turnPage(self: SceneSwitcherScene, delta: int) =
  ## Another page (wrapping around), its first tile highlighted.
  let grid = self.grid()
  if grid.pages <= 1:
    return
  let page = ((self.state{"page"}.getInt(0) + delta) mod grid.pages + grid.pages) mod grid.pages
  self.highlight(page * grid.perPage)

proc choose(self: SceneSwitcherScene, index: int) =
  ## Show the scene at `index`.
  if index >= 0 and index < self.entries.len:
    sendEvent(evSetCurrentScene, %*{"sceneId": self.entries[index].id}, eoScene)

proc leave() =
  ## Back to the scene it was opened from: the dispatcher knows which.
  sendEvent(evSceneSwitcher, newJObject(), eoScene)

proc opened(self: SceneSwitcherScene) =
  ## Shown: the scene it was opened from is the highlighted one.
  self.entries = listEntries()
  self.highlight(max(self.indexOf(self.state{"from"}.getStr()), 0))
  self.touch()

# ---------------------------------------------------------------- input

proc pressed(self: SceneSwitcherScene, payload: JsonNode) =
  ## A key, by its role: next / down and prev / up walk the tiles, a press
  ## one step and a double press two, so every tap counts; primary, refresh
  ## and menu (OK, REFRESH, BOOT) show the highlighted scene, back goes back.
  ## A long press is the frame's (its event map walks the scenes) or nothing.
  let action = payload{"action"}.getStr("press")
  if action != "press" and action != "doublePress":
    return
  var role = payload{"role"}.getStr()
  if role.len == 0:
    role = buttonRoleForLabel(payload{"label"}.getStr().strip().toUpperAscii())
  let steps = if action == "doublePress": 2 else: 1
  if self.entries.len == 0:
    self.entries = listEntries()
  case role
  of "next", "down": self.highlight(self.highlighted() + steps)
  of "prev", "up": self.highlight(self.highlighted() - steps)
  of "primary", "refresh", "menu": self.choose(self.highlighted())
  of "back": leave()
  else: return
  self.touch()

when not defined(frameosEmbedded):
  proc keyed(self: SceneSwitcherScene, payload: JsonNode) =
    ## A keyboard (Linux, the preview): the arrows walk the grid, Enter shows,
    ## Escape goes back.
    if self.entries.len == 0:
      self.entries = listEntries()
    let cols = self.grid().cols
    case payload{"code"}.getStr()
    of "ArrowRight": self.highlight(self.highlighted() + 1)
    of "ArrowLeft": self.highlight(self.highlighted() - 1)
    of "ArrowDown": self.highlight(self.highlighted() + cols)
    of "ArrowUp": self.highlight(self.highlighted() - cols)
    of "PageDown": self.turnPage(1)
    of "PageUp": self.turnPage(-1)
    of "Enter", "NumpadEnter", "Space": self.choose(self.highlighted())
    of "Escape", "Backspace": leave()
    else: return
    self.touch()

# --------------------------------------------------------------- the picture
#
# Class names are appended in place, one call per class: flash is the budget
# on an ESP32, and every `&` of a few strings is its own allocation and
# overflow checks at each call site.

proc el(tag: string, classes: sink string, children: varargs[SvgNode]): SvgNode =
  result = SvgNode(tag: tag)
  if classes.len > 0:
    result.attrs.add(("class", classes))
  for child in children:
    result.children.add child

proc txt(text: string): SvgNode = SvgNode(text: text)

proc px(c: var string, name: string, v: int) =
  ## ` name-[Npx]`: a Tailwind class with an arbitrary length.
  c.add ' '
  c.add name
  c.add "-["
  c.addInt v
  c.add "px]"

proc at(c: var string, x, y, w, h: int) =
  c.add "absolute"
  c.px("left", x)
  c.px("top", y)
  c.px("w", w)
  c.px("h", h)

proc square(c: var string, size: int) =
  c.px("w", size)
  c.px("h", size)

proc onClick(node: SvgNode, handler: int): SvgNode =
  node.attrs.add(("on-click", $handler))
  node

proc chevron(size: int, left: bool, color: string): SvgNode =
  ## A page arrow, drawn: no font has to have the glyph.
  let path = SvgNode(tag: "path", attrs: @[("d", if left: "M15 5l-7 7 7 7" else: "M9 5l7 7-7 7"),
    ("fill", "none"), ("stroke", color), ("stroke-width", "2.6"),
    ("stroke-linecap", "round"), ("stroke-linejoin", "round")])
  var c = "shrink-0"
  c.square(size)
  SvgNode(tag: "svg", attrs: @[("viewBox", "0 0 24 24"), ("class", c)], children: @[path])

type TileLook = object
  ## What every part of a tile shares.
  paper, lit, showing: bool
  unit, border, inner, radius: int
  muted: string

proc number(look: TileLook, index: int): SvgNode =
  el("span", "shrink-0 font-bold" & look.muted, txt($(index + 1)))

proc dot(look: TileLook): SvgNode =
  ## By the title of the scene it was opened from.
  var c = "shrink-0 rounded-full"
  c.square(max(4, look.unit div 18))
  c.add(if not look.paper: " bg-sky-400" elif look.lit: " bg-white" else: " bg-black")
  el("div", c)

proc titleRow(look: TileLook, index, size: int, height = 0): SvgNode =
  var c = "flex items-center leading-none"
  c.px("gap", max(2, size div 3))
  c.px("text", size)
  if height > 0:
    c.px("h", height)
  result = el("div", c, look.number(index))
  if look.showing:
    result.children.add look.dot()

when not defined(frameosEmbedded):
  proc pictureTile(self: SceneSwitcherScene, tile: SvgNode, look: TileLook, index: int,
      grid: SwitcherGrid, title: string) =
    ## A tile's picture and the title under it: the scene's last snapshot,
    ## where the host keeps one (Linux), or its number in the picture's place.
    let
      titleH = clamp(int(round(grid.tileH.float * 0.2)), 14, 44)
      pw = max(grid.tileW - 2 * look.border - 2 * look.inner, 1)
      ph = max(grid.tileH - 2 * look.border - 2 * look.inner - titleH, 1)
      size = clamp(int(round(titleH.float * 0.62)), 10, 28)
    var picture: Image
    try:
      picture = sceneSwitcherThumbnail(self.frameConfig, self.entries[index].id, pw, ph)
    except Exception:
      picture = nil
    var c = "shrink-0"
    c.px("rounded", max(look.radius - look.inner, 2))
    c.px("w", pw)
    c.px("h", ph)
    if not picture.isNil:
      tile.children.add SvgNode(tag: "img", image: picture, attrs: @[("class", c)])
    else:
      # No picture yet (a scene not shown since the card was made).
      c.add " flex items-center justify-center font-bold"
      c.add(if not look.paper: " bg-zinc-700" elif look.lit: " border-2 border-white" else: " border-2 border-black")
      c.px("text", clamp(ph div 3, 12, 64))
      c.add look.muted
      tile.children.add el("div", c, txt($(index + 1)))
    let row = look.titleRow(index, size, titleH)
    row.children.add el("span", if look.paper: "truncate font-bold" else: "truncate", txt(title))
    tile.children.add row

proc tile(self: SceneSwitcherScene, index: int, grid: SwitcherGrid, slot: int, paper: bool,
    lit: bool): SvgNode =
  let entry = self.entries[index]
  var look = TileLook(paper: paper, lit: lit, showing: entry.id == self.state{"from"}.getStr(),
    unit: min(grid.tileW, grid.tileH))
  look.border = max(2, look.unit div (if paper: 40 else: 45))
  look.inner = max(3, look.unit div 22)
  look.radius = clamp(look.unit div 12, 3, 16)
  look.muted = if paper: "" elif lit: " text-sky-200" else: " text-zinc-400"
  let title = if entry.name.len > 0: entry.name else: entry.id
  var c: string
  c.at(grid.x0 + (slot mod grid.cols) * (grid.tileW + grid.gap),
    grid.y0 + (slot div grid.cols) * (grid.tileH + grid.gap), grid.tileW, grid.tileH)
  c.add " flex flex-col"
  c.px("border", look.border)
  c.px("rounded", look.radius)
  c.px("p", look.inner)
  c.add(
    if paper: (if lit: " bg-black border-black text-white" else: " bg-white border-black text-black")
    elif lit: " bg-zinc-800 border-sky-400 text-white active:bg-zinc-600"
    else: " bg-zinc-800 border-zinc-800 text-white active:bg-zinc-600 active:border-zinc-600")
  result = el("div", c).onClick(index)
  when not defined(frameosEmbedded):
    if not sceneSwitcherThumbnail.isNil:
      self.pictureTile(result, look, index, grid, title)
      return
  # Names only: an ESP32 keeps no picture of a scene it is not showing.
  let size = clamp(int(round(min(grid.tileH.float * 0.18, grid.tileW.float * 0.14))), 12, 40)
  result.children.add look.titleRow(index, size)
  var name = "grow flex items-center justify-center text-center font-bold line-clamp-3"
  name.px("text", size)
  result.children.add el("div", name, txt(title))

proc tree*(self: SceneSwitcherScene, width, height: int, paper: bool): SvgNode =
  ## The switcher as a UI tree: the header (its title, the page and its
  ## arrows, Close) and one page of tiles, each where switcherGrid put it.
  let
    grid = self.grid(width, height)
    page = clamp(self.state{"page"}.getInt(0), 0, grid.pages - 1)
    lit = self.highlighted()
    size = clamp(grid.headerH * 45 div 100, 12, 32)
    small = max(size * 3 div 4, 10)
    button = if paper: " border-2 border-black" else: " bg-zinc-800 active:bg-zinc-600"
  result = el("div", if paper: "relative w-full h-full bg-white text-black"
    else: "relative w-full h-full bg-zinc-950 text-white")
  var c: string
  c.at(0, 0, width, grid.headerH)
  c.add " flex items-center"
  c.px("gap", grid.gap)
  c.px("px", grid.pad)
  if paper:
    c.add " border-b-2 border-black"
  let header = el("div", c)
  c = "grow truncate font-bold"
  c.px("text", size)
  header.children.add el("span", c, txt("Scenes"))
  if grid.pages > 1:
    let
      arrow = clamp(grid.headerH * 6 div 10, 14, 40)
      ink = if paper: "#000000" else: "#ffffff"
    var round = "shrink-0 flex items-center justify-center rounded-full"
    round.square(arrow)
    round.add button
    header.children.add el("div", round, chevron(arrow * 2 div 3, true, ink)).onClick(self.entries.len + 1)
    c = "shrink-0"
    c.px("text", small)
    header.children.add el("span", c, txt($(page + 1) & " / " & $grid.pages))
    header.children.add el("div", round, chevron(arrow * 2 div 3, false, ink)).onClick(self.entries.len + 2)
  c = "shrink-0 rounded-full"
  c.px("px", max(6, small))
  c.px("py", max(2, small div 4))
  c.px("text", small)
  c.add button
  header.children.add el("div", c, txt("Close")).onClick(self.entries.len)
  result.children.add header
  if self.entries.len == 0:
    c = ""
    c.at(0, grid.y0, width, max(height - grid.y0, 1))
    c.add " flex items-center justify-center text-center"
    c.px("text", size)
    result.children.add el("div", c, txt("No scenes installed yet."))
    return
  for slot in 0 ..< grid.perPage:
    let index = page * grid.perPage + slot
    if index >= self.entries.len:
      break
    result.children.add self.tile(index, grid, slot, paper, index == lit)

proc background(paper: bool): Color =
  if paper: color(1, 1, 1, 1) else: color(0.035, 0.035, 0.043, 1) # zinc-950

proc draw*(self: SceneSwitcherScene, image: Image) =
  ## One render: the list read again, laid out, drawn into `image`, and the
  ## tiles left behind for the pointer.
  self.entries = listEntries()
  self.paper = paperPanel(self.frameConfig, image)
  let
    paper = self.paper
    target = uiTarget(SceneSwitcherId, SwitcherNode)
  var regions: seq[UiRegion]
  # E-paper shows no press: a refresh to say a finger is down is seconds of
  # flashing for nothing. Its tiles still take the tap.
  let svg = layoutUi(self.tree(image.width, image.height, paper), image.width, image.height,
    (if paper: UiInput() else: target.input), regions, target.memo)
  var owed = some(background(paper))
  if not renderSvgFrame(svg, image, owed, wholeFrame = true, reuse = true):
    discard renderSvgIntoTarget(svg, image, owed)
  if owed.isSome:
    image.fill(owed.get())
  target.regions = move(regions)
  target.offsetX = 0
  target.offsetY = 0
  var ids: seq[string]
  for entry in self.entries:
    ids.add entry.id
  target.call = proc (handler: int, name: string, event: JsonNode,
      localX, localY, width, height: float32) {.closure, raises: [].} =
    try:
      if handler < ids.len:
        sendEvent(evSetCurrentScene, %*{"sceneId": ids[handler]}, eoScene)
      elif handler == ids.len:
        leave()
      else:
        pageAsked = if handler == ids.len + 1: -1 else: 1
    except Exception:
      discard
  # Back by itself once nobody has touched it for a while; until then, a
  # render when that time is up.
  let
    idle = idleSeconds(paper)
    since = epochTime() - self.state{"touchedAt"}.getFloat(epochTime())
  if since >= idle:
    leave()
    self.refreshInterval = idle
  else:
    self.refreshInterval = max(idle - since, 1.0)

# ------------------------------------------------------------ the scene

proc runSwitcher(self: FrameScene, context: ExecutionContext) =
  let self = SceneSwitcherScene(self)
  let payload = if context.payload.isNil or context.payload.kind != JObject: newJObject() else: context.payload
  try:
    case context.event
    of "setCurrentScene":
      # What the dispatcher says it was opened from (event_loop.nim).
      let state = payload{"state"}
      if not state.isNil and state.kind == JObject and state.hasKey("from"):
        self.state["from"] = state["from"]
    of "open":
      self.opened()
    of "render":
      if context.hasImage and not context.image.isNil:
        self.draw(context.image)
    of "button":
      self.pressed(payload)
    of "keyDown":
      when not defined(frameosEmbedded):
        self.keyed(payload)
    of "swipe":
      # Across the tiles, as on a phone: the next page or the one before.
      case payload{"direction"}.getStr()
      of "left":
        self.turnPage(1)
        self.touch()
      of "right":
        self.turnPage(-1)
        self.touch()
      else: discard
    of "tap", "doubleTap", "longPress", "pointerDown", "pointerUp", "pointerMove", "pointerCancel":
      # E-paper hears the tap alone: the rest only moves what is pressed.
      if context.event == "tap" or not self.paper:
        pageAsked = 0
        let changed = dispatchUiEvent(SceneSwitcherId, context.event, payload)
        if pageAsked != 0:
          self.turnPage(pageAsked)
          pageAsked = 0
        if changed and context.event == "tap":
          # A tile, Close or an arrow: what it did is the next picture (a
          # switch, or the page in the state). A tap on nothing is nothing.
          self.touch()
        elif changed:
          # What is pressed moved: an LCD shows it.
          sendEvent(evRender, newJObject(), eoScene)
    else:
      discard
  except CatchableError as e:
    self.logger.log(%*{"event": "sceneSwitcher:error", "contextEvent": context.event, "error": e.msg})

proc renderSwitcher(self: FrameScene, context: ExecutionContext): Image =
  if not context.hasImage or context.image.isNil:
    let (w, h) = canvasSize(self.frameConfig)
    context.image = newImage(max(w, 1), max(h, 1))
    context.hasImage = true
  runSwitcher(self, context)
  context.image

proc initSwitcher(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = newJObject()
  if not persistedState.isNil and persistedState.kind == JObject:
    for key, value in persistedState:
      state[key] = value
  # Until the first render says (an ESP32's LCD is known by its canvas).
  let paper = paperPanel(frameConfig)
  SceneSwitcherScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: state,
    refreshInterval: idleSeconds(paper), backgroundColor: background(paper), paper: paper)

var exportedScene* = ExportedInterpretedScene(
  name: "Scene switcher",
  publicStateFields: @[],
  persistedStateKeys: @[],
  refreshInterval: IdleSecondsFast,
  backgroundColor: background(false),
  init: initSwitcher,
  runEvent: runSwitcher,
  render: renderSwitcher,
)
  ## An interpreted scene's export (with no nodes of its own), so a host that
  ## holds one scene (single_scene_host) keeps it like any other.
