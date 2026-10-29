## The scene switcher, `system/sceneSwitcher` (docs/scene-switcher.md): every
## scene on the frame as a tile with its title, in the frame's scene list
## order, to tap, or to walk with the buttons and pick.
##
## Built into every runtime (the Linux runner registers it with the system
## scenes, frameos/single_scene_host builds it for the ESP32 and the preview)
## and shown like any scene. `sceneSwitcher` (docs/events-contract.json) opens
## it, and the dispatcher (event_loop.nim) hands it `state.from`, the scene it
## was opened from; the same event while it shows goes back there, which is
## what its Close button, a `back` key and its idle timeout dispatch, and so
## does `sceneSettings`.
##
## It is drawn with the JSX layout (ui/layout.nim): the tree is built here, in
## Nim, so it needs no QuickJS, and its taps are hit-tested by ui/events.nim
## like a JS app's UI. A fast panel gets a dark grid with each scene's last
## picture where the host keeps one (`sceneSwitcherThumbnail`: the Linux
## runner's scene snapshots); e-paper gets black on white with the
## highlighted tile inverted, so it reads on a one-bit panel and follows the
## keys. The scene list is the host's (`sceneSwitcherListing`): the order
## `setCurrentScene {direction}` walks, with each scene's name.
##
## Flash is the budget on an ESP32 (AGENTS.md): the firmware gets the names
## only layout, no keyboard, no pictures and no round panel (none of its
## boards has one), integer arithmetic, and no Nim checks in this module.
## Every index here is guarded by the loop or the test that reaches it.

import std/[json, options, tables, times]
when not defined(frameosEmbedded):
  import std/[math, strutils]
import pixie
import pixie/fileformats/svg
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/panel_shape
import frameos/ui/layout
import frameos/ui/events
import frameos/ui/tree
import frameos/utils/font
import frameos/utils/image
import frameos/utils/svg_frames

{.push overflowChecks: off, rangeChecks: off, boundChecks: off, fieldChecks: off, stackTrace: off,
  lineTrace: off.}

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
    ## A round panel (frameos/panel_shape): the tiles fill the square inside
    ## the circle `radius` px around (cx, cy) (`RoundInset` in from the rim),
    ## and the title, the arrows and Close sit in the four arcs around it.
    round*: bool
    cx*, cy*, radius*, side*: int

  SceneSwitcherScene* = ref object of FrameScene
    entries*: seq[SwitcherEntry] ## what the last render or key listed
    paper*: bool ## drawn for e-paper last time (paperPanel)

const
  SwitcherNode = 1 ## the ui/events target its tiles live in
  IdleSecondsFast* = 60.0
  IdleSecondsPaper* = 300.0
  RoundInset* = 12
    ## How far in from a round panel's rim everything stays: its bezel covers
    ## some of the circle, and a finger at the very edge misses the glass.
  MaxCols = 6
  MaxRows = 6
  # The page arrows, drawn (no font has to have the glyph): one markup, its
  # path's points either way.
  ChevronHead = "<svg viewBox=\"0 0 24 24\"><path d=\"M"
  ChevronTail = "\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>"

var
  sceneSwitcherListing*: SwitcherListing
  sceneSwitcherThumbnail*: SwitcherThumbnail
  # What the last hit test ran: a tile's index, Close (the tile count), an
  # arrow (count + 1, + 2), or -1. Read by runEvent once the hit test is
  # done, so the handler holds nothing of the scene's.
  tapped {.threadvar.}: int

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  ## `node[key] = value` for an object node, without json's assert.
  node.fields[key] = value

proc isBuiltInScene*(sceneId: string): bool =
  ## A scene the runtime draws itself, on every host: no slot, no file. The
  ## switcher and the scene settings (system/sceneSettings/scene.nim).
  sceneId == SceneSwitcherId or sceneId == SceneSettingsId

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
  ## feedback): any panel that is not an LCD. An ESP32's LCD canvas is its
  ## RGB565 buffer and any other is e-paper or a monochrome OLED; a Pi says
  ## by its device.
  let lcd = not canvas.isNil and canvas.format == pfRgb565
  when defined(frameosEmbedded):
    panelIsPaper("", lcd)
  else:
    not frameConfig.isNil and panelIsPaper(frameConfig.device, lcd)

proc idleSeconds*(paper: bool): float =
  ## How long the switcher waits for a touch or a key before it goes back.
  if paper: IdleSecondsPaper else: IdleSecondsFast

proc canvasSize(frameConfig: FrameConfig): (int, int) =
  if frameConfig.rotate == 90 or frameConfig.rotate == 270: (frameConfig.height, frameConfig.width)
  else: (frameConfig.width, frameConfig.height)

proc ensureCanvas*(self: FrameScene, context: ExecutionContext) =
  ## The canvas a built-in scene draws into: the host's, else one the size of
  ## the frame as it is turned.
  if not context.hasImage or context.image.isNil:
    let (w, h) = canvasSize(self.frameConfig)
    context.image = newImage(max(w, 1), max(h, 1))
    context.hasImage = true

proc permille(v, p: int): int {.inline.} = (v * p + 500) div 1000

proc switcherGrid*(count, width, height: int, thumbnails: bool, round = false): SwitcherGrid =
  ## The tile grid for `count` scenes on a `width` x `height` canvas: every
  ## scene on one page while the tiles stay big enough to read, else as many
  ## per page as fit. Among the grids that hold them all, the one whose
  ## pictures (at the canvas's own aspect) or name cards come out largest.
  ## On a round panel the grid is the square inscribed in the circle that
  ## stays `RoundInset` in from the rim, so no tile has a corner off the glass.
  let unit = min(width, height)
  result.pad = clamp(permille(unit, 35), 4, 24)
  result.gap = clamp(permille(unit, 25), 3, 16)
  result.headerH = clamp(permille(unit, 110), 18, 64)
  result.x0 = result.pad
  result.y0 = result.headerH + result.gap
  var
    gw = max(width - 2 * result.pad, 1)
    gh = max(height - result.y0 - result.pad, 1)
  when not defined(frameosEmbedded):
    if round:
      result.round = true
      result.cx = width div 2
      result.cy = height div 2
      result.radius = max(min(width, height) div 2 - RoundInset, 8)
      # Two pixels inside the circle at its corners, whatever the rounding.
      result.side = max(int(floor(result.radius.float * sqrt(2.0))) - 4, 8)
      result.x0 = result.cx - result.side div 2
      result.y0 = result.cy - result.side div 2
      gw = result.side
      gh = result.side
  let
    minW = min(clamp(unit div 5, 48, 200), gw)
    minH = min(clamp(permille(unit, 150), 36, 160), gh)
  var
    best = -1.0
    bestFits = false
  for cols in 1 .. MaxCols:
    for rows in 1 .. MaxRows:
      let
        tw = (gw - result.gap * (cols - 1)) div cols
        th = (gh - result.gap * (rows - 1)) div rows
      if tw < minW or th < minH:
        continue
      let capacity = cols * rows
      let fits = capacity >= max(count, 1)
      # A card with a name: as large as it gets, not much taller than wide.
      var quality = float(min(tw, th * 11 div 5) * min(th, tw * 6 div 5))
      when not defined(frameosEmbedded):
        if thumbnails:
          # The picture: what is left under the title, at the canvas's aspect.
          let
            aspect = width.float / max(height, 1).float
            titleH = clamp(th.float * 0.2, 14, 44)
            pw = min(tw.float * 0.9, max(th.float - titleH, 1) * 0.9 * aspect)
          quality = pw * pw / aspect
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
  when defined(frameosEmbedded):
    switcherGrid(self.entries.len, width, height, false)
  else:
    switcherGrid(self.entries.len, width, height, not sceneSwitcherThumbnail.isNil,
      round = not self.frameConfig.isNil and panelIsRound(self.frameConfig.device))

proc grid(self: SceneSwitcherScene): SwitcherGrid =
  let (width, height) = canvasSize(self.frameConfig)
  self.grid(width, height)

proc indexOf(self: SceneSwitcherScene, sceneId: string): int =
  for i in 0 ..< self.entries.len:
    if self.entries[i].id == sceneId:
      return i
  -1

proc opener(self: SceneSwitcherScene): string =
  ## The scene it was opened from (event_loop.nim hands it over), or "".
  self.state{"from"}.getStr()

proc forget(self: SceneSwitcherScene) =
  ## Opened from nowhere it knows: Close goes to the list's first scene.
  self.state.put("from", newJString(""))

proc highlighted*(self: SceneSwitcherScene): int =
  ## The highlighted tile, the first when the highlight names no scene on the
  ## list; -1 for an empty list.
  if self.entries.len == 0:
    return -1
  max(self.indexOf(self.state{"highlight"}.getStr()), 0)

proc touch*(self: FrameScene) =
  ## Somebody did something: the idle timeout starts over (a built-in
  ## scene's `drawUi`).
  self.state.put("touchedAt", newJFloat(epochTime()))

proc highlight(self: SceneSwitcherScene, index: int) =
  ## The tile at `index` (wrapping around) highlighted, and its page shown.
  let count = self.entries.len
  if count == 0:
    return
  let i = ((index mod count) + count) mod count
  self.state.put("highlight", newJString(self.entries[i].id))
  self.state.put("page", newJInt(i div max(self.grid().perPage, 1)))

proc turnPage(self: SceneSwitcherScene, delta: int) =
  ## Another page (wrapping around), its first tile highlighted.
  let grid = self.grid()
  if grid.pages > 1:
    let page = ((self.state{"page"}.getInt(0) + delta) mod grid.pages + grid.pages) mod grid.pages
    self.highlight(page * grid.perPage)

proc choose(self: SceneSwitcherScene, index: int) =
  ## Show the scene at `index`.
  if index >= 0 and index < self.entries.len:
    let payload = newJObject()
    payload.put("sceneId", newJString(self.entries[index].id))
    sendEvent(evSetCurrentScene, payload, eoScene)

proc leave() =
  ## Back to the scene it was opened from: the dispatcher knows which.
  sendEvent(evSceneSwitcher, newJObject(), eoScene)

proc opened(self: SceneSwitcherScene) =
  ## Shown: the scene it was opened from is the highlighted one, the list's
  ## first when there is none or it is gone (then Close goes to the first).
  self.entries = listEntries()
  let index = self.indexOf(self.opener())
  if index < 0:
    self.forget()
  self.highlight(max(index, 0))
  self.touch()

# ---------------------------------------------------------------- input

proc pressed(self: SceneSwitcherScene, payload: JsonNode) =
  ## A key, by its role (the input state gives every `button` one): next /
  ## down and prev / up walk the tiles, a press one step and a double press
  ## two, so every tap counts; primary, refresh and menu (OK, REFRESH, BOOT)
  ## show the highlighted scene, back goes back. A long press is the frame's
  ## (its event map walks the scenes) or nothing.
  # One way out (no early `return`): each one repeats the clean-up of what
  # was read so far.
  let action = payload{"action"}.getStr()
  let steps = if action == "press": 1 elif action == "doublePress": 2 else: 0
  if steps > 0:
    if self.entries.len == 0:
      self.entries = listEntries()
    var acted = true
    case payload{"role"}.getStr()
    of "next", "down": self.highlight(self.highlighted() + steps)
    of "prev", "up": self.highlight(self.highlighted() - steps)
    of "primary", "refresh", "menu": self.choose(self.highlighted())
    of "back": leave()
    else: acted = false
    if acted:
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
# Class names are appended in place, one call per class, and a class that
# depends on something is appended in a branch of its own: every `&` of a few
# strings, and every `if` that yields a string, is its own temporary at each
# call site. Nodes are handed on (`sink`), never copied.

proc txt(text: sink string): SvgNode = SvgNode(text: text)

proc pageText(page, pages: int): string =
  ## "2 / 3".
  result.addInt(page + 1)
  result.add " / "
  result.addInt pages

proc at(c: var string, x, y, w, h: int) =
  c.add "absolute"
  c.px("left", x)
  c.px("top", y)
  c.px("w", w)
  c.px("h", h)

proc square(c: var string, size: int) =
  c.px("w", size)
  c.px("h", size)

proc onClick(node: sink SvgNode, handler: int): SvgNode =
  node.attrs.add(("on-click", $handler))
  node

proc arrowButton(size: int, left: bool, button: string): SvgNode =
  ## A round page arrow, its chevron in the text color.
  var c = "shrink-0 flex items-center justify-center rounded-full"
  c.square(size)
  c.add button
  result = el("div", c)
  var markup = ChevronHead
  if left: markup.add "15 5l-7 7 7 7"
  else: markup.add "9 5l7 7-7 7"
  markup.add ChevronTail
  # Markup with no text in it: read straight into nodes, nothing to raise.
  let chevron = parseSvgNodesFast(markup)
  if not chevron.isNil:
    var s = "shrink-0"
    s.square(size * 2 div 3)
    chevron.attrs.add(("class", s))
    result.children.add chevron

type TileLook = object
  ## What every tile on the page shares, and the one at hand.
  paper, lit, showing: bool
  unit, border, inner, radius: int

proc mute(c: var string, look: TileLook) =
  ## A tile's quieter text, on an LCD.
  if look.paper: discard
  elif look.lit: c.add " text-sky-200"
  else: c.add " text-zinc-400"

proc titleRow(look: TileLook, index, size: int, height = 0): SvgNode =
  ## The tile's number, and a dot when it is the scene it was opened from.
  var c = "flex items-center leading-none"
  c.px("gap", max(2, size div 3))
  c.px("text", size)
  if height > 0:
    c.px("h", height)
  var n = "shrink-0 font-bold"
  n.mute(look)
  var number: string
  number.addInt(index + 1)
  result = el("div", c, el("span", n, txt(number)))
  if look.showing:
    var d = "shrink-0 rounded-full"
    d.square(max(4, look.unit div 18))
    if not look.paper: d.add " bg-sky-400"
    elif look.lit: d.add " bg-white"
    else: d.add " bg-black"
    result.children.add el("div", d)

when not defined(frameosEmbedded):
  proc pictureTile(self: SceneSwitcherScene, tile: SvgNode, look: TileLook, index: int,
      grid: SwitcherGrid, title: string) =
    ## A tile's picture and the title under it: the scene's last snapshot,
    ## where the host keeps one (Linux), or its number in the picture's place.
    let
      titleH = clamp(int(round(grid.tileH.float * 0.2)), 14, 44)
      pw = max(grid.tileW - 2 * look.border - 2 * look.inner, 1)
      ph = max(grid.tileH - 2 * look.border - 2 * look.inner - titleH, 1)
      size = clamp(int(round(min(titleH.float * 0.62, grid.tileW.float * 0.13))), 10, 28)
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
      c.mute(look)
      tile.children.add el("div", c, txt($(index + 1)))
    let row = look.titleRow(index, size, titleH)
    row.children.add el("span", if look.paper: "truncate font-bold" else: "truncate", txt(title))
    tile.children.add row

proc tile(self: SceneSwitcherScene, look: TileLook, index, slot: int, grid: SwitcherGrid,
    button: string): SvgNode =
  ## The scene at `index`, in the page's `slot`.
  var c: string
  c.at(grid.x0 + (slot mod grid.cols) * (grid.tileW + grid.gap),
    grid.y0 + (slot div grid.cols) * (grid.tileH + grid.gap), grid.tileW, grid.tileH)
  c.px("border", look.border)
  c.px("rounded", look.radius)
  c.px("p", look.inner)
  c.add " flex flex-col"
  # On e-paper the page's colors, inverted for the highlight; on an LCD a
  # button, ringed for it.
  if look.paper:
    c.add " border-black"
    if look.lit: c.add " bg-black text-white"
  else:
    c.add button
    if look.lit: c.add " border-sky-400"
    else: c.add " border-zinc-800"
  result = el("div", c).onClick(index)
  var title = self.entries[index].name
  if title.len == 0:
    title = self.entries[index].id
  when not defined(frameosEmbedded):
    if not sceneSwitcherThumbnail.isNil:
      self.pictureTile(result, look, index, grid, title)
      return
  # Names only: an ESP32 keeps no picture of a scene it is not showing.
  let size = clamp(min(permille(grid.tileH, 180), permille(grid.tileW, 140)), 12, 40)
  result.children.add look.titleRow(index, size)
  var name = "grow flex items-center justify-center text-center font-bold line-clamp-3"
  name.px("text", size)
  result.children.add el("div", name, txt(title))

proc header(self: SceneSwitcherScene, root: SvgNode, grid: SwitcherGrid, page: int, paper: bool,
    width, size, small: int, button: string) =
  ## A rectangular panel's header: the title, the page and its arrows, Close.
  var c: string
  c.at(0, 0, width, grid.headerH)
  c.add " flex items-center"
  if paper: c.add " border-b-2 border-black"
  c.px("gap", grid.gap)
  c.px("px", grid.pad)
  let header = el("div", c)
  c = "grow truncate font-bold"
  c.px("text", size)
  header.children.add el("span", c, txt("Scenes"))
  if grid.pages > 1:
    let arrow = clamp(grid.headerH * 6 div 10, 14, 40)
    header.children.add arrowButton(arrow, true, button).onClick(self.entries.len + 1)
    c = "shrink-0"
    c.px("text", small)
    header.children.add el("span", c, txt(pageText(page, grid.pages)))
    header.children.add arrowButton(arrow, false, button).onClick(self.entries.len + 2)
  c = "shrink-0 rounded-full"
  c.px("px", max(6, small))
  c.px("py", max(2, small div 4))
  c.px("text", small)
  c.add button
  header.children.add el("div", c, txt("Close")).onClick(self.entries.len)
  root.children.add header

when not defined(frameosEmbedded):
  # No ESP32 board is round (frameos/panel_shape.nim): the firmware
  # carries the rectangular header alone.
  proc chordHalf(radius, dy: int): int =
    ## Half the width of a circle of `radius` at `dy` from its centre.
    if abs(dy) >= radius: 0 else: int(floor(sqrt(float(radius * radius - dy * dy))))

  proc roundChrome(self: SceneSwitcherScene, root: SvgNode, grid: SwitcherGrid, page: int, paper: bool,
      size, small: int, button: string) =
    ## A round panel's: the tiles fill the square inside the circle, and the
    ## four arcs around it hold the title and the page (12 o'clock), the page
    ## arrows (9 and 3) and Close (6). Every box is cut to the chord it sits
    ## on, so no corner leaves the circle `RoundInset` in from the rim.
    let
      arc = grid.y0 - (grid.cy - grid.radius) # the top and bottom arcs' depth
      rowH = max(min(clamp(grid.headerH * 7 div 10, 16, 44), arc - grid.gap), 8)
      top = grid.y0 - grid.gap div 2 - rowH
      titleHalf = max(chordHalf(grid.radius, grid.cy - top) - 2, 4)
    var c: string
    c.at(grid.cx - titleHalf, top, 2 * titleHalf, rowH)
    c.add " flex items-center justify-center"
    c.px("gap", max(4, small div 2))
    let title = el("div", c)
    c = "truncate font-bold"
    c.px("text", size)
    title.children.add el("span", c, txt("Scenes"))
    if grid.pages > 1:
      c = if paper: "shrink-0" else: "shrink-0 text-zinc-400"
      c.px("text", small)
      title.children.add el("span", c, txt(pageText(page, grid.pages)))
    root.children.add title
    let
      closeTop = grid.y0 + grid.side + grid.gap div 2
      closeHalf = max(chordHalf(grid.radius, closeTop + rowH - grid.cy) - 2, 4)
      closeW = min(2 * closeHalf, max(small * 6, 72))
    c = ""
    c.at(grid.cx - closeW div 2, closeTop, closeW, rowH)
    c.add " flex items-center justify-center rounded-full"
    c.px("text", small)
    c.add button
    root.children.add el("div", c, txt("Close")).onClick(self.entries.len)
    if grid.pages > 1:
      let room = grid.x0 - (grid.cx - grid.radius) - grid.gap div 2
      var a = min(clamp(grid.radius * 19 div 100, 20, 48), room - 2)
      # Its far corners on the circle at most.
      while a > 12 and (grid.side div 2 + grid.gap div 2 + a) ^ 2 + (a div 2 + 1) ^ 2 > grid.radius ^ 2:
        dec a
      let
        y = grid.cy - a div 2
        left = arrowButton(a, true, button).onClick(self.entries.len + 1)
        right = arrowButton(a, false, button).onClick(self.entries.len + 2)
      # Placed where the circle has room for them, beside the tiles.
      left.attrs[0][1].add " absolute"
      left.attrs[0][1].px("left", grid.x0 - grid.gap div 2 - a)
      left.attrs[0][1].px("top", y)
      right.attrs[0][1].add " absolute"
      right.attrs[0][1].px("left", grid.x0 + grid.side + grid.gap div 2)
      right.attrs[0][1].px("top", y)
      root.children.add left
      root.children.add right

proc tree*(self: SceneSwitcherScene, width, height: int, paper: bool): SvgNode =
  ## The switcher as a UI tree: the header (its title, the page and its
  ## arrows, Close), or on a round panel the same around the circle, and one
  ## page of tiles, each where switcherGrid put it. The outermost element
  ## fills the canvas by itself (ui/layout.nim), its children placed on it.
  let
    grid = self.grid(width, height)
    page = clamp(self.state{"page"}.getInt(0), 0, grid.pages - 1)
    lit = self.highlighted()
    size = clamp(grid.headerH * 45 div 100, 12, 32)
    small = max(size * 3 div 4, 10)
    button = if paper: " border-2 border-black" else: " bg-zinc-800 active:bg-zinc-600"
  # E-paper's white and black are the canvas's own (the scene background, and
  # the layout's text color); an LCD's dark page covers every pixel, so a
  # press repaints only what it changed (utils/svg_frames.nim).
  result = el("div", if paper: "" else: "bg-zinc-950 text-white")
  when defined(frameosEmbedded):
    self.header(result, grid, page, paper, width, size, small, button)
  else:
    if grid.round:
      self.roundChrome(result, grid, page, paper, size, small, button)
    else:
      self.header(result, grid, page, paper, width, size, small, button)
  if self.entries.len == 0:
    var c: string
    if grid.round: c.at(grid.x0, grid.y0, grid.side, grid.side)
    else: c.at(0, grid.y0, width, max(height - grid.y0, 1))
    c.add " flex items-center justify-center text-center"
    c.px("text", size)
    result.children.add el("div", c, txt("No scenes installed yet."))
  # No `return` for that: the loop below ends at once, and one way out keeps
  # one clean-up.
  var look = TileLook(paper: paper, unit: min(grid.tileW, grid.tileH))
  look.border = max(2, look.unit div (if paper: 40 else: 45))
  look.inner = max(3, look.unit div 22)
  look.radius = clamp(look.unit div 12, 3, 16)
  let opener = self.opener()
  for slot in 0 ..< grid.perPage:
    let index = page * grid.perPage + slot
    if index >= self.entries.len:
      break
    look.lit = index == lit
    look.showing = self.entries[index].id == opener
    result.children.add self.tile(look, index, slot, grid, button)

const
  PaperWhite = color(1, 1, 1, 1)
  Zinc950 = color(0.035, 0.035, 0.043, 1)

proc background*(paper: bool): Color =
  if paper: PaperWhite else: Zinc950

proc drawUi*(self: FrameScene, sceneId: string, tree: SvgNode, image: Image, paper: bool,
    call: UiHandlerCall, idle: float): bool =
  ## A built-in scene's render (the switcher's, the settings'): `tree` laid
  ## out and drawn into `image`, and its regions left with `call` for the
  ## pointer. True once nobody has touched it for `idle` seconds, when the
  ## scene goes back; until then the next render is due when that time is up.
  let target = uiTarget(sceneId, 1)
  target.input.paper = paper
  var regions: seq[UiRegion]
  let svg = layoutUi(tree, image.width, image.height, target.input, regions, target.memo)
  let bg = background(paper)
  var owed = some(bg)
  if not renderSvgFrame(svg, image, owed, wholeFrame = true, reuse = true):
    discard renderSvgIntoTarget(svg, image, owed)
  if owed.isSome:
    image.fill(bg)
  target.regions = move(regions)
  target.offsetX = 0
  target.offsetY = 0
  target.call = call
  let
    now = epochTime()
    since = now - self.state{"touchedAt"}.getFloat(now)
  result = since >= idle
  self.refreshInterval = if result: idle else: max(idle - since, 1.0)

proc onTap(handler: int, name: string, event: JsonNode, hit: UiHit) {.raises: [].} =
  ## The tiles' one handler, run by the hit test (ui/events.nim): what it
  ## hit, for `pointer` to act on once the hit test is done.
  tapped = handler

proc draw*(self: SceneSwitcherScene, image: Image) =
  ## One render: the list read again, laid out, drawn into `image`, and the
  ## tiles left behind for the pointer.
  self.entries = listEntries()
  if self.indexOf(self.opener()) < 0:
    # Gone from the list since it opened: Close goes to the list's first.
    self.forget()
  self.paper = paperPanel(self.frameConfig, image)
  # E-paper shows no press: a refresh to say a finger is down is seconds of
  # flashing for nothing. `pointer` hands it taps alone, which leave the
  # target's input (what is hovered, what is pressed) empty. Back by itself
  # once nobody has touched it for a while.
  if self.drawUi(SceneSwitcherId, self.tree(image.width, image.height, self.paper), image, self.paper,
      onTap, idleSeconds(self.paper)):
    leave()

# ------------------------------------------------------------ the scene

proc pointer(self: SceneSwitcherScene, event: string, payload: JsonNode) =
  ## A pointer event over the tiles (ui/events.nim hit-tests it). E-paper
  ## hears the tap alone: the rest only moves what is pressed.
  let tap = event == "tap"
  if not tap and self.paper:
    return
  tapped = -1
  let changed = dispatchUiEvent(SceneSwitcherId, event, payload)
  let count = self.entries.len
  if tapped >= 0:
    # A tile, Close or an arrow: what it did is the next picture (a switch,
    # or the page in the state). A tap on nothing is nothing.
    if tapped < count: self.choose(tapped)
    elif tapped == count: leave()
    else: self.turnPage(if tapped == count + 1: -1 else: 1)
    tapped = -1
    self.touch()
  elif changed and not tap:
    # What is pressed moved: an LCD shows it.
    sendEvent(evRender, newJObject(), eoScene)

proc runSwitcher(self: FrameScene, context: ExecutionContext) =
  ## What raises here is reported by the caller, as for any scene: the
  ## dispatcher's `event:error`, the render pass's own. The payload is read
  ## with `{}` alone, which answers a nil or a non-object payload with nil.
  let self = SceneSwitcherScene(self)
  let payload = context.payload
  case context.event
  of "setCurrentScene":
    # What the dispatcher says it was opened from (event_loop.nim).
    let opener = payload{"state", "from"}
    if not opener.isNil:
      self.state.put("from", opener)
  of "open":
    self.opened()
  of "close":
    # Opened again by name (a `setCurrentScene` to it), it was opened from
    # nowhere it knows: no stale scene to go back to.
    self.forget()
  of "render":
    if context.hasImage and not context.image.isNil:
      self.draw(context.image)
  of "button":
    self.pressed(payload)
  of "swipe":
    # Across the tiles, as on a phone: the next page or the one before.
    let direction = payload{"direction"}.getStr()
    if direction == "left" or direction == "right":
      self.turnPage(if direction == "left": 1 else: -1)
      self.touch()
  else:
    when not defined(frameosEmbedded):
      if context.event == "keyDown":
        self.keyed(payload)
        return
    # A pointer event (and what is not one, which the hit test makes
    # nothing of: it has no position).
    self.pointer(context.event, payload)

proc renderSwitcher(self: FrameScene, context: ExecutionContext): Image =
  self.ensureCanvas(context)
  runSwitcher(self, context)
  context.image

proc initSwitcher(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  ## Nothing persisted to start from: the switcher keeps no state file.
  # Until the first render says (an ESP32's LCD is known by its canvas).
  let paper = paperPanel(frameConfig)
  SceneSwitcherScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(),
    refreshInterval: idleSeconds(paper), backgroundColor: background(paper), paper: paper)

var exportedScene* = ExportedInterpretedScene(
  name: "Scene switcher",
  refreshInterval: IdleSecondsFast,
  backgroundColor: background(false),
  init: initSwitcher,
  runEvent: runSwitcher,
  render: renderSwitcher,
)
  ## An interpreted scene's export (with no nodes of its own), so a host that
  ## holds one scene (single_scene_host) keeps it like any other.

{.pop.}
