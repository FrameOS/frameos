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
  from frameos/events import isSceneSettings
import pixie
import pixie/fileformats/svg
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/panel_shape
import frameos/render_scale
import frameos/scene_rhythm
import frameos/ui/layout
import frameos/ui/events
import frameos/ui/theme
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
    ## A scene's last picture, `width` x `height` or smaller in that shape
    ## (it is stretched to the tile), or nil.
  SwitcherThumbnailPass* = proc (start: bool): bool {.nimcall, gcsafe.}
    ## Around a render's pictures: `start` before the first, then after the
    ## last, whether one was left out for time (and another render is due).

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
    roomW, roomH, unit: int ## what the last render laid out in (tree): 0 before one

const
  SwitcherNode = 1 ## the ui/events target its tiles live in
  IdleSecondsFast* = 60.0
  IdleSecondsPaper* = 300.0
  MaxCols = 6
  MaxRows = 6
  # The page arrows, drawn (no font has to have the glyph): one markup, its
  # path's points either way.
  ChevronHead = "<svg viewBox=\"0 0 24 24\"><path d=\"M"
  ChevronTail = "\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>"

var
  sceneSwitcherListing*: SwitcherListing
  sceneSwitcherThumbnail*: SwitcherThumbnail
  sceneSwitcherThumbnailPass*: SwitcherThumbnailPass
  # What the last hit test ran: a tile's index, Close (the tile count), an
  # arrow (count + 1, + 2), or -1. Read by runEvent once the hit test is
  # done, so the handler holds nothing of the scene's.
  tapped {.threadvar.}: int

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  ## `node[key] = value` for an object node, without json's assert.
  node.fields[key] = value

when defined(frameosEmbedded):
  proc isBuiltInScene*(sceneId: string): bool =
    ## A scene the runtime draws itself, on every host: no slot, no file. The
    ## switcher and the scene settings (system/sceneSettings/scene.nim).
    sceneId == SceneSwitcherId or sceneId == SceneSettingsId
else:
  proc isBuiltInScene*(sceneId: string): bool =
    ## A scene the runtime draws itself: no slot, no file. The switcher, the
    ## scene settings (system/sceneSettings/scene.nim; on a desktop one a
    ## scene, `settingsWindowId`) and, off the ESP32, the terminal
    ## (system/terminal/scene.nim).
    sceneId == SceneSwitcherId or sceneId == SceneTerminalId or isSceneSettings(sceneId)

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

proc uiScale*(frameConfig: FrameConfig, width, height: int): float =
  ## The frame's render scale (render_scale.nim) for a built-in scene's UI,
  ## the switcher's and the settings', kept where they stay usable: no
  ## smaller than 3/4 and laid out on no less than 320 px, so the settings
  ## that set it can always set it back.
  clamp(frameRenderScale(frameConfig), 0.75, max(1.0, min(width, height).float / 320.0))

proc uiRoom*(frameConfig: FrameConfig, width, height: int): (int, int) =
  ## What a built-in UI is laid out on: the canvas over its scale. Its
  ## sizes come from the canvas (its `unit`), so at 1.5 everything is half
  ## as large again with less room, as a scaled JSX scene is.
  let scale = uiScale(frameConfig, width, height)
  (scaledLength(width, scale), scaledLength(height, scale))

when not defined(frameosEmbedded):
  const DesktopUnit = 400
    ## A built-in scene's unit in a desktop's window: its letters a size from
    ## the desktops' apps (16 px in the settings, 12 in the terminal).

  proc panelUnit*(frameConfig: FrameConfig, image: Image): int =
    ## The panel's shorter edge, as it is turned (the canvas's without a
    ## config): what a built-in scene's sizes are a share of in a window on a
    ## desktop too, so its letters keep the frame's size there and a bigger
    ## window shows more of it, not more of the same larger.
    if not frameConfig.isNil:
      let (w, h) = canvasSize(frameConfig)
      result = min(w, h)
    if result <= 0:
      result = min(image.width, image.height)
    # In a desktop's window it is one of the desktop's apps, sized as on a
    # small frame whatever the panel: at the desktops' own zoom, twice that
    # from a 2160 px short side (1000 on e-paper) at the frame's render scale.
    if not onDesktop.isNil and onDesktop():
      let laidOut = result.float / max(frameRenderScale(frameConfig), 0.25)
      let zoom = if laidOut >= (if paperPanel(frameConfig, image): 1000.0 else: 2160.0): 2 else: 1
      result = min(result, DesktopUnit * zoom)

template sizeUnit*(self: FrameScene, image: Image): int =
  ## A built-in scene's `unit` (its `tree`'s `sizeUnit`): the canvas's shorter
  ## edge on an ESP32, which draws them full screen alone; elsewhere the
  ## panel's (panelUnit), the same full screen, and the same in a window.
  when defined(frameosEmbedded): min(image.width, image.height)
  else: panelUnit(self.frameConfig, image)

proc ensureCanvas*(self: FrameScene, context: ExecutionContext) =
  ## The canvas a built-in scene draws into: the host's, else one the size of
  ## the frame as it is turned.
  if not context.hasImage or context.image.isNil:
    let (w, h) = canvasSize(self.frameConfig)
    context.image = newImage(max(w, 1), max(h, 1))
    context.hasImage = true

proc permille(v, p: int): int {.inline.} = (v * p + 500) div 1000

proc switcherGrid*(count, width, height: int, thumbnails: bool, round = false, unit = 0): SwitcherGrid =
  ## The tile grid for `count` scenes on a `width` x `height` canvas: the
  ## densest one whose tiles stay big enough to read, whatever the count, so
  ## a tile is the same size with three scenes as with thirty and fewer
  ## scenes fill fewer of its slots (the owner's rule, 2026-11-10: tiles that
  ## grew to fill the page looked odd, and on an ESP32 each picture's pixels
  ## are what the switcher's render costs). Among grids as dense, the one
  ## whose pictures (at the canvas's own aspect) or name cards come out
  ## largest. More scenes than a page holds page.
  ## On a round panel the grid is the square inscribed in the circle that
  ## stays `RoundInset` in from the rim, so no tile has a corner off the glass.
  ## `unit`: what the sizes are a share of (the panel's shorter edge, for a
  ## UI laid out at its render scale); the canvas's shorter edge without it.
  let unit = if unit > 0: unit else: min(width, height)
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
    bestCapacity = 0
  for cols in 1 .. MaxCols:
    for rows in 1 .. MaxRows:
      let
        tw = (gw - result.gap * (cols - 1)) div cols
        th = (gh - result.gap * (rows - 1)) div rows
      if tw < minW or th < minH:
        continue
      let capacity = cols * rows
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
      if capacity > bestCapacity or (capacity == bestCapacity and quality > best):
        best = quality
        bestCapacity = capacity
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

proc isRound*(frameConfig: FrameConfig): bool =
  ## Whether the frame's panel shows only the circle inside it
  ## (frameos/panel_shape.nim); never on an ESP32.
  when defined(frameosEmbedded): false
  else: not frameConfig.isNil and panelIsRound(frameConfig.device)

proc grid(self: SceneSwitcherScene, width, height: int, unit = 0): SwitcherGrid =
  when defined(frameosEmbedded):
    switcherGrid(self.entries.len, width, height, false, unit = unit)
  else:
    switcherGrid(self.entries.len, width, height, not sceneSwitcherThumbnail.isNil,
      round = isRound(self.frameConfig), unit = unit)

proc grid(self: SceneSwitcherScene): SwitcherGrid =
  ## The grid the last render drew: at the UI's scale (uiRoom), in the room
  ## it had. Inside a layout that is the hole the layout left, not the panel:
  ## measured on the whole panel, a page held more tiles than the drawn one,
  ## so a page turn lit a tile of the page after and the last pages could not
  ## be reached (the reTerminal E1003 in a Windows 98 window, 2026-11-10).
  if self.roomW > 0 and self.roomH > 0:
    return self.grid(self.roomW, self.roomH, self.unit)
  let (width, height) = canvasSize(self.frameConfig)
  let (roomW, roomH) = uiRoom(self.frameConfig, width, height)
  self.grid(roomW, roomH, min(width, height))

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

proc turnPage(self: SceneSwitcherScene, delta: int): bool {.discardable.} =
  ## Another page (wrapping around), its first tile highlighted. False when
  ## there is only the one.
  let grid = self.grid()
  if grid.pages > 1:
    let page = ((self.state{"page"}.getInt(0) + delta) mod grid.pages + grid.pages) mod grid.pages
    self.highlight(page * grid.perPage)
    result = true

proc showTurnedPage() =
  ## A tap or a swipe changes nothing the dispatcher watches for them (the
  ## contract's `tap` and `swipe` render `never`, unlike a key's or `back`'s
  ## `if-state-changed`), so the page they turned is asked for here. Without
  ## it the next page showed only when something else rendered: on the
  ## reTerminal E1003 a tap on the arrow did nothing until the panel happened
  ## to refresh (2026-11-10).
  sendEvent(evRender, newJObject(), eoScene)

when not defined(frameosEmbedded):
  var wentBack {.threadvar.}: bool
    ## It went back by itself (a scene picked, Close, its timeout), not merely
    ## lost the focus to a window beside it: its "close" ends it
    ## (docs/scene-layouts.md "Windows").

proc choose(self: SceneSwitcherScene, index: int) =
  ## Show the scene at `index`.
  if index >= 0 and index < self.entries.len:
    let payload = newJObject()
    payload.put("sceneId", newJString(self.entries[index].id))
    when not defined(frameosEmbedded):
      wentBack = true
    sendEvent(evSetCurrentScene, payload, eoScene)

proc leave() =
  ## Back to the scene it was opened from: the dispatcher knows which.
  when not defined(frameosEmbedded):
    wentBack = true
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
  # The layout theme's look for a button (ui/theme.nim), on a Pi.
  when not defined(frameosEmbedded):
    result = result.role("button")

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
  result = el("div", c, el("span", n, txt(number)).role("muted"))
  if look.showing:
    var d = "shrink-0 rounded-full"
    d.square(max(4, look.unit div 18))
    if not look.paper: d.add " bg-sky-400"
    elif look.lit: d.add " bg-white"
    else: d.add " bg-black"
    result.children.add el("div", d).role("accent")

proc pictureTile(self: SceneSwitcherScene, tile: SvgNode, look: TileLook, index: int,
    grid: SwitcherGrid, title: string): bool =
  ## A tile's picture and the title under it: the scene's last snapshot,
  ## where the host keeps one, else its number in the picture's place. Linux
  ## only: an ESP32's tiles are name cards (see `tile`).
  let
    titleH = clamp(permille(grid.tileH, 200), 14, 44)
    pw = max(grid.tileW - 2 * look.border - 2 * look.inner, 1)
    ph = max(grid.tileH - 2 * look.border - 2 * look.inner - titleH, 1)
    size = clamp(min(permille(titleH, 620), permille(grid.tileW, 130)), 10, 28)
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
    tile.children.add el("div", c, txt($(index + 1))).role("field")
  let row = look.titleRow(index, size, titleH)
  row.children.add el("span", if look.paper: "truncate font-bold" else: "truncate", txt(title))
  tile.children.add row
  true

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
  # An ESP32 shows names only: loading, scaling and drawing a picture per tile
  # made the drawer take seconds to open on a 10" e-paper panel (the owner's
  # call, 2026-11-10), and writing them cost seconds of flash after renders.
  # The preview keeps no picture of a scene it is not showing either.
  when not defined(frameosEmbedded):
    if not sceneSwitcherThumbnail.isNil and self.pictureTile(result, look, index, grid, title):
      return result.role(if look.lit: "tileLit" else: "tile")
  let size = clamp(min(permille(grid.tileH, 180), permille(grid.tileW, 140)), 12, 40)
  result.children.add look.titleRow(index, size)
  var name = "grow flex items-center justify-center text-center font-bold line-clamp-3"
  name.px("text", size)
  result.children.add el("div", name, txt(title))
  when not defined(frameosEmbedded):
    result = result.role(if look.lit: "tileLit" else: "tile")

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
  header.children.add el("div", c, txt("Close")).role("button").onClick(self.entries.len)
  root.children.add header.role("bar")

when not defined(frameosEmbedded):
  # No ESP32 board is round (frameos/panel_shape.nim): the firmware
  # carries the rectangular header alone.
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
      title.children.add el("span", c, txt(pageText(page, grid.pages))).role("muted")
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
    root.children.add el("div", c, txt("Close")).role("button").onClick(self.entries.len)
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

proc tree*(self: SceneSwitcherScene, width, height: int, paper: bool, unit = 0): SvgNode =
  ## The switcher as a UI tree: the header (its title, the page and its
  ## arrows, Close), or on a round panel the same around the circle, and one
  ## page of tiles, each where switcherGrid put it. The outermost element
  ## fills the canvas by itself (ui/layout.nim), its children placed on it.
  ## `unit`: what its sizes are a share of (uiRoom).
  self.roomW = width
  self.roomH = height
  self.unit = unit
  let
    grid = self.grid(width, height, unit)
    page = clamp(self.state{"page"}.getInt(0), 0, grid.pages - 1)
    lit = self.highlighted()
    size = clamp(grid.headerH * 45 div 100, 12, 32)
    small = max(size * 3 div 4, 10)
    button = if paper: " border-2 border-black" else: " bg-zinc-800 active:bg-zinc-600"
  # E-paper's white and black are the canvas's own (the scene background, and
  # the layout's text color); an LCD's dark page covers every pixel, so a
  # press repaints only what it changed (utils/svg_frames.nim).
  result = el("div", if paper: "" else: "bg-zinc-950 text-white").role("page")
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
    call: UiHandlerCall, idle: float, roomW, roomH: int): bool =
  ## A built-in scene's render (the switcher's, the settings'): `tree` laid
  ## out on `roomW` x `roomH` (uiRoom), drawn stretched to fill `image` as
  ## vectors, and its regions left with `call` for the pointer, which is
  ## divided by the same scale. True once nobody has touched it for `idle`
  ## seconds, when the scene goes back; until then the next render is due
  ## when that time is up.
  # Not a pass of the scene_rhythm: the panel the scene underneath left in
  # these buffers is gone, and a panel of it that is not due must not stay.
  rhythmForgetCanvases()
  let target = uiTarget(sceneId, 1)
  target.input.paper = paper
  target.input.round = isRound(self.frameConfig)
  var regions: seq[UiRegion]
  let svg = layoutUi(tree, roomW, roomH, target.input, regions, target.memo)
  let bg = background(paper)
  var owed = some(bg)
  if not renderSvgFrame(svg, image, owed, wholeFrame = true, reuse = true):
    discard renderSvgIntoTarget(svg, image, owed)
  if owed.isSome:
    image.fill(bg)
  target.regions = move(regions)
  target.offsetX = 0
  target.offsetY = 0
  target.scale = image.width.float32 / max(roomW, 1).float32
  target.call = call
  when not defined(frameosEmbedded):
    if self.state{"away"}.getBool():
      # Left open in a window (docs/scene-layouts.md "Windows"): it waits for
      # whoever brings it forward again, and draws again when something does.
      self.refreshInterval = idle
      self.refreshIntervalDefault = idle
      return false
  let
    now = epochTime()
    since = now - self.state{"touchedAt"}.getFloat(now)
  result = since >= idle
  self.refreshInterval = if result: idle else: max(idle - since, 1.0)
  # What a layout around it goes by (refresh_interval.ownRefreshInterval).
  self.refreshIntervalDefault = self.refreshInterval

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
  var more = false
  when not defined(frameosEmbedded):
    # Pictures that would have kept the panel waiting come in the next
    # render (the Linux host's decode budget, scene_switcher_linux.nim). Not
    # on e-paper, where each render is a refresh: it waits for all of them.
    let pass = if self.paper: nil else: sceneSwitcherThumbnailPass
    if not pass.isNil:
      try: discard pass(true) except Exception: discard
  let (roomW, roomH) = uiRoom(self.frameConfig, image.width, image.height)
  let tree = self.tree(roomW, roomH, self.paper, self.sizeUnit(image))
  when not defined(frameosEmbedded):
    if not pass.isNil:
      try: more = pass(false) except Exception: more = false
  if self.drawUi(SceneSwitcherId, tree, image, self.paper, onTap, idleSeconds(self.paper), roomW, roomH):
    leave()
  elif more:
    rhythmMarkDue(self)
    sendEvent(evRender, newJObject(), eoScene)

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
    elif self.turnPage(if tapped == count + 1: -1 else: 1): showTurnedPage()
    tapped = -1
    self.touch()
  elif changed and not tap:
    # What is pressed moved: an LCD shows it.
    sendEvent(evRender, newJObject(), eoScene)

proc switcherOwnRun(self: FrameScene, context: ExecutionContext) {.nimcall.} =
  ## What raises here is reported by the caller, as for any scene: the
  ## dispatcher's `event:error`, the render pass's own. The payload is read
  ## with `{}` alone, which answers a nil or a non-object payload with nil.
  let self = SceneSwitcherScene(self)
  let payload = context.payload
  case context.event
  of "setCurrentScene":
    # What the dispatcher says it was opened from (event_loop.nim).
    for key in ["from", "layout"]:
      let value = payload{"state", key}
      if not value.isNil:
        self.state.put(key, value)
  of "open":
    when not defined(frameosEmbedded):
      wentBack = false
      if self.state.hasKey("away"):
        self.state.delete("away")
    self.opened()
  of "close":
    when defined(frameosEmbedded):
      # Opened again by name (a `setCurrentScene` to it), it was opened from
      # nowhere it knows: no stale scene to go back to.
      self.forget()
    else:
      if wentBack or not builtInScenesStay:
        # Done: opened again by name, it knows no scene to go back to.
        wentBack = false
        self.forget()
      else:
        # The focus went to a window beside it (docs/scene-layouts.md
        # "Windows"): it stays open there, Close still going back where it
        # was opened from, and does not go back by itself (drawUi).
        self.state.put("away", newJBool(true))
  of "render":
    if context.hasImage and not context.image.isNil:
      self.draw(context.image)
  of "button":
    self.pressed(payload)
  of evBack, evForward:
    # The frame's back and forward (a swipe in from the left or the right
    # edge): the page before or the next one, as a swipe across the tiles.
    self.turnPage(if context.event == evForward: 1 else: -1)
    self.touch()
  of "swipe":
    # Across the tiles, as on a phone: the next page or the one before.
    let direction = payload{"direction"}.getStr()
    if direction == "left" or direction == "right":
      if self.turnPage(if direction == "left": 1 else: -1): showTurnedPage()
      self.touch()
  else:
    when not defined(frameosEmbedded):
      if context.event == "keyDown":
        self.keyed(payload)
        return
    # A pointer event (and what is not one, which the hit test makes
    # nothing of: it has no position).
    self.pointer(context.event, payload)

proc runSwitcher(self: FrameScene, context: ExecutionContext) =
  if builtInRunner.isNil or not builtInRunner(self, context):
    switcherOwnRun(self, context)

proc renderSwitcher(self: FrameScene, context: ExecutionContext): Image =
  self.ensureCanvas(context)
  runSwitcher(self, context)
  context.image

proc initSwitcher(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  ## Nothing persisted to start from: the switcher keeps no state file.
  # Until the first render says (an ESP32's LCD is known by its canvas).
  let paper = paperPanel(frameConfig)
  SceneSwitcherScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(), ownRun: switcherOwnRun,
    shownName: "Scene switcher", refreshInterval: idleSeconds(paper), backgroundColor: background(paper), paper: paper)

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
