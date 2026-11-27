## The scene switcher, `system/sceneSwitcher` (docs/scene-switcher.md): every
## scene on the frame as a tile with its title, in the frame's scene list
## order grouped by category, in one list that scrolls, to tap, or to walk
## with the buttons and pick.
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
## Nim, so it needs no QuickJS, and its taps and the list's scrolling are
## ui/events.nim's, as for a JS app's UI. Each scene is an icon with its
## name under it, as in a folder's icon view; a fast panel gets them on a
## dark page (a host's pictures, `sceneSwitcherThumbnail`, are no longer
## drawn: 2026-11-21); e-paper
## gets black on white with the highlighted tile inverted, so it reads on a
## one-bit panel and follows the keys, and the list scrolls to the tile they
## are on. The scene list is the host's (`sceneSwitcherListing`): the order
## `setCurrentScene {direction}` walks, with each scene's name and category,
## grouped as the desktops group them (`grouped`). A gear in the header opens
## the frame page (`sceneSettings {page: "frame"}`), where the frame offers
## one: the way back to the layout's choice when the switcher is all a layout
## left reachable. A search field beside the title (where the frame takes
## taps and the panel is not round) keeps the scenes whose name or category
## holds what is typed (`query`, cleared each time it opens).
##
## Flash is the budget on an ESP32 (AGENTS.md): the firmware gets the names
## only layout, no keyboard, no pictures and no round panel (none of its
## boards has one), integer arithmetic, and no Nim checks in this module.
## Every index here is guarded by the loop or the test that reaches it.

import std/[json, options, strutils, tables, times]
when not defined(frameosEmbedded):
  import std/math
from frameos/events import isSceneSettings
import pixie
import pixie/fileformats/svg
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/frame_settings_hooks
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
    windowSize*: string ## its own size in a desktop's window, "" for none: 800x480 (app.frame.scenes)
    icon*: string ## its icon, one path in 0 0 24 24 (scene_icon.nim), "" for none
    category*: string ## its category by its name ("Photos"), as the scene has it, "" for none
    opens*: string ## the file types it opens ("pdf", "txt md"), as the scene has it, "" for none

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
    ## Where the tiles go: `cols` across, the first at (x0, y0) with the list
    ## at its top, `rows` of them in sight at once. The list is the box
    ## (listX, listY) `listW` x `listH`, which scrolls; a category's heading
    ## is a row `headingH` tall above its tiles.
    cols*, rows*: int
    tileW*, tileH*, gap*, x0*, y0*, pad*, headerH*, headingH*: int
    ## Inside a cell: the icon (`icon` px square), its name's letters
    ## (`text`, two lines at most, centred under it), and the room around
    ## them (`inner`). The cells are `tileW` apart, `gap` between them.
    icon*, text*, inner*: int
    listX*, listY*, listW*, listH*: int
    ## A round panel (frameos/panel_shape): the list is the square inside
    ## the circle `radius` px around (cx, cy) (`RoundInset` in from the rim),
    ## and the title and Close sit in the arcs above and below it.
    round*: bool
    cx*, cy*, radius*, side*: int
    lift*: int
      ## A round panel's lens (`lens`): how far down its cell a tile drawn
      ## smaller is put, so it stays centred where a full one would be.

  SceneSwitcherScene* = ref object of FrameScene
    entries*: seq[SwitcherEntry] ## what the last render or key listed
    paper*: bool ## drawn in e-paper's look last time (panelLook)
    slow*: bool ## a press cost a refresh last time (panelLook): taps alone
    gear*: bool ## the frame offers its page (frameSettingsRead): the header's gear, after the tiles for the keys
    keysOnly*: bool ## nothing on the frame takes a tap (takesNoTaps): no Close or gear to draw
    headed*: bool ## the categories have headings (heads): wherever a scene has one
    revealing: bool ## just opened: the next render scrolls to the highlight in the room it has (draw)
    roomW, roomH, unit: int ## what the last render laid out in (tree): 0 before one

const
  SwitcherNode = 1 ## the ui/events target its tiles live in
  ListKey = 1
    ## The list's place in the tree (ui/layout.nim keys a child `key * 31 + i
    ## + 1`): the root's first child. Its scroll is kept by that key.
  IdleSecondsFast* = 60.0
  IdleSecondsSlow* = 300.0
  MaxCols = 32
  GridUnitMax = 480
    ## The most the header's sizes are a share of, and `CellUnitMax` the
    ## cells': an icon is as large on a bigger screen as on a 400 px one (and
    ## in a desktop's window), and the bigger screen shows more of them (the
    ## render scale is what makes them larger).
  CellUnitMax = 400
  # A gear, 48 units square: the teeth clockwise, the hole the other way.
  GearPath = "M20 9L21 3L27 3L28 9L32 11L36 7L41 12L37 16L39 20L45 21L45 27L39 28L37 32L41 36L36 41L32 37" &
    "L28 39L27 45L21 45L20 39L16 37L12 41L7 36L11 32L9 28L3 27L3 21L9 20L11 16L7 12L12 7L16 11Z" &
    "M17 24a7 7 0 1 0 14 0a7 7 0 1 0 -14 0Z"
  GearMark = "\1" ## the highlight on the gear: no scene's id is this
  Blank = {' ', '\t', '\v', '\r', '\l', '\f'} ## what a category is trimmed of

var
  sceneSwitcherListing*: SwitcherListing
  sceneSwitcherThumbnail*: SwitcherThumbnail
  sceneSwitcherThumbnailPass*: SwitcherThumbnailPass
  # What the last hit test ran: a tile's index, Close (the tile count), the
  # gear (count + 1), the search field (`SearchHandler`, its text in
  # `searched`), or -1. Read by runEvent once the hit test is done, so the
  # handler holds nothing of the scene's.
  tapped {.threadvar.}: int
  searched {.threadvar.}: string

const SearchHandler = 1_000_000 ## the search field's onChange: past any tile count

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  ## `node[key] = value` for an object node, without json's assert.
  node.fields[key] = value

proc gearPath*(): string =
  ## The gear that opens the frame page, here and in the scene settings: one
  ## copy of its path in flash for the two built-in scenes.
  GearPath

proc putText(node: JsonNode, key, text: string, always = false) =
  ## `node[key] = text`, where there is any text (or `always`).
  if always or text.len > 0:
    node.put(key, newJString(text))

proc listingItem*(entry: SwitcherEntry): JsonNode =
  ## The scene as `app.frame.scenes` lists it (docs/scene-layouts.md
  ## "Windows"): `{id, name}`, and its window size, icon, category and the
  ## file types it opens where it has them. One builder for every host, so
  ## their listings stay alike.
  result = newJObject()
  result.putText("id", entry.id, always = true)
  result.putText("name", entry.name, always = true)
  result.putText("windowSize", entry.windowSize)
  result.putText("icon", entry.icon)
  result.putText("category", entry.category)
  result.putText("opens", entry.opens)

proc isBuiltInScene*(sceneId: string): bool =
  ## A scene the runtime draws itself: no slot, no file. The switcher and the
  ## scene settings (system/sceneSettings/scene.nim; on a desktop one a
  ## scene, `settingsWindowId`).
  sceneId == SceneSwitcherId or isSceneSettings(sceneId)

# ------------------------------------------------------------------ the model

proc listEntries*(): seq[SwitcherEntry] =
  ## The host's scene list, empty without a host or when it fails (the
  ## settings read it too).
  if sceneSwitcherListing.isNil:
    return @[]
  try:
    result = sceneSwitcherListing()
  except Exception:
    result = @[]

proc panelLook*(frameConfig: FrameConfig, canvas: Image = nil): tuple[paper, slow: bool] =
  ## How the switcher and the settings draw for the panel: in e-paper's look
  ## (black on white, an inverted highlight) where it draws in inks
  ## (panel_shape.panelIsPaper), and hearing taps alone, waiting for every
  ## thumbnail and going back later where a press costs a refresh
  ## (panelIsFast). A board says by its panel (panel_shape.boardPanelFormat),
  ## a Pi by its device; the canvas only where neither has (an ESP32's LCD
  ## canvas is its RGB565 buffer). One proc for both: the firmware pays for
  ## one.
  let lcd = not canvas.isNil and canvas.format == pfRgb565
  when defined(frameosEmbedded):
    (panelIsPaper("", lcd), not panelIsFast("", lcd))
  else:
    if frameConfig.isNil: (false, false)
    else: (panelIsPaper(frameConfig.device, lcd), not panelIsFast(frameConfig.device, lcd))

template paperPanel*(frameConfig: FrameConfig, canvas: Image = nil): bool =
  panelLook(frameConfig, canvas).paper

template fastPanel*(frameConfig: FrameConfig, canvas: Image = nil): bool =
  not panelLook(frameConfig, canvas).slow

proc idleSeconds*(slow: bool): float =
  ## How long the switcher waits for a touch or a key before it goes back.
  if slow: IdleSecondsSlow else: IdleSecondsFast

const HomeIdleSeconds = 3600.0
  ## How often the frame's home (it never goes back by itself) draws again
  ## with nobody at it: a new scene list, the hour.

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

const
  UiUnit = 480
    ## The most a built-in scene's sizes are a share of, full screen: its
    ## letters and buttons are as large on a bigger panel as on a 480 px one
    ## (laid out at the frame's render scale, which is what makes them larger:
    ## the automatic scale is 2 on a 10.3" 1872x1404 e-paper), and the bigger
    ## panel has more room for them. The switcher's `GridUnitMax`.
  DesktopUnit = 400
    ## A built-in scene's unit in a desktop's window: its letters a size from
    ## the desktops' apps (16 px in the settings).

proc panelEdge*(frameConfig: FrameConfig, image: Image): int =
  ## The panel's shorter edge, as it is turned (the canvas's without a
  ## config): what the frame page's scales are offered for.
  if not frameConfig.isNil:
    let (w, h) = canvasSize(frameConfig)
    result = min(w, h)
  if result <= 0:
    result = min(image.width, image.height)

proc panelUnit*(frameConfig: FrameConfig, image: Image): int =
  ## What a built-in scene's sizes are a share of: the panel's shorter edge
  ## up to `UiUnit`, and in a window on a desktop a desktop's app's
  ## (`DesktopUnit`), so its letters keep their size there and a bigger
  ## window shows more of it, not more of the same larger. The frame's render
  ## scale (uiRoom) makes them larger, as it does every scene's.
  result = min(panelEdge(frameConfig, image), UiUnit)
  if not onDesktop.isNil and onDesktop():
    result = min(result, DesktopUnit)

template sizeUnit*(self: FrameScene, image: Image): int =
  ## A built-in scene's `unit` (its `tree`'s `sizeUnit`): the panel's
  ## (panelUnit), the same full screen, and the same in a window.
  panelUnit(self.frameConfig, image)

proc ensureCanvas*(self: FrameScene, context: ExecutionContext) =
  ## The canvas a built-in scene draws into: the host's, else one the size of
  ## the frame as it is turned.
  if not context.hasImage or context.image.isNil:
    let (w, h) = canvasSize(self.frameConfig)
    context.image = newImage(max(w, 1), max(h, 1))
    context.hasImage = true

proc permille(v, p: int): int {.inline.} = (v * p + 500) div 1000

proc switcherGrid*(width, height: int, thumbnails: bool, round = false, unit = 0): SwitcherGrid =
  ## Where the cells go on a `width` x `height` canvas: a folder's icon view
  ## (docs/scene-switcher.md "The tiles"), each scene an icon with its name
  ## centred under it, the cells close together from the left, as many across
  ## as fit; the rows that do not fit scroll, and `rows` is how many show.
  ## A cell is one size whatever the room (84 px at a 400 px unit, as a file
  ## manager's at 100%), so a bigger screen or window shows more of them,
  ## never larger ones. `thumbnails` is no longer drawn (2026-11-21).
  ## On a round panel the list is the square inscribed in the circle that
  ## stays `RoundInset` in from the rim, so no cell shows a corner off the
  ## glass.
  ## `unit`: what the sizes are a share of (the panel's shorter edge, for a
  ## UI laid out at its render scale; 400 in a desktop's window); the
  ## canvas's shorter edge without it.
  let unit = min(if unit > 0: unit else: min(width, height), GridUnitMax)
  let cu = min(unit, CellUnitMax)
  result.pad = clamp(permille(unit, 35), 4, 24)
  result.gap = clamp(permille(cu, 10), 2, 8)
  result.headerH = clamp(permille(unit, 110), 18, 64)
  result.headingH = clamp(permille(cu, 55), 14, 36)
  result.x0 = result.pad
  result.y0 = result.headerH + clamp(permille(unit, 25), 3, 16)
  # Under the header to the bottom edge, the whole width, so a finger
  # anywhere below the header scrolls it.
  result.listY = result.headerH
  result.listW = width
  result.listH = max(height - result.headerH, 1)
  var
    gw = max(width - 2 * result.pad, 1)
    gh = max(height - result.y0, 1) # the rows in sight: the list runs to the bottom edge
  if round:
    result.round = true
    result.cx = width div 2
    result.cy = height div 2
    result.radius = max(min(width, height) div 2 - RoundInset, 8)
    # Two pixels inside the circle at its corners, whatever the rounding.
    result.side = max(int(floor(result.radius.float * sqrt(2.0))) - 4, 8)
    result.x0 = result.cx - result.side div 2
    result.y0 = result.cy - result.side div 2
    result.listX = result.x0
    result.listY = result.y0
    result.listW = result.side
    result.listH = result.side
    gw = result.side
    gh = result.side
  result.text = clamp(permille(cu, 30), 10, 24)
  result.inner = clamp(permille(cu, 10), 2, 8)
  result.icon = clamp(permille(cu, 100), 20, 64)
  result.tileW = min(clamp(permille(cu, 210), 56, 120), gw)
  # The icon's tinted box (the icon and `inner` around it), `inner` over and
  # under it, the name's two lines, and `inner` under them: a row's names
  # never touch the next row's headings.
  result.tileH = 5 * result.inner + result.icon + 2 * (result.text * 5 div 4)
  result.cols = clamp((gw + result.gap) div (result.tileW + result.gap), 1, MaxCols)
  result.rows = max((gh + result.gap) div (result.tileH + result.gap), 1)

proc lens*(grid: SwitcherGrid, top, scroll: int): SwitcherGrid =
  ## A round panel's list is a lens: a tile is full size at the circle's
  ## middle and smaller towards its rim, a watch's list, following the finger
  ## as the list scrolls (every scroll is a render). `top`: the tile's top in
  ## the list, `scroll` how far the list is scrolled. Only what is drawn
  ## shrinks: the cell, and what a tap there does, stay.
  result = grid
  let
    dy = abs(grid.listY + top - scroll + grid.tileH div 2 - grid.cy)
    reach = max(grid.radius, 1)
    # 1000 at the middle, 1000 - 650 × (dy / radius)² towards the rim:
    # about two thirds at the list's top and bottom edges.
    k = clamp(1000 - 650 * dy * dy div reach div reach, 550, 1000)
  if k >= 1000:
    return
  result.icon = max(permille(grid.icon, k), 8)
  result.text = max(permille(grid.text, k), 8)
  result.inner = max(permille(grid.inner, k), 1)
  let drawn = 5 * result.inner + result.icon + 2 * (result.text * 5 div 4)
  result.lift = max((grid.tileH - drawn) div 2, 0)

proc isRound*(frameConfig: FrameConfig): bool =
  ## Whether the frame's panel shows only the circle inside it
  ## (frameos/panel_shape.nim): a HyperPixel 2.1 Round on a Pi, the
  ## Waveshare 1.75" AMOLED on an ESP32 (`boardPanelRound`).
  not frameConfig.isNil and panelIsRound(frameConfig.device)

proc grid(self: SceneSwitcherScene, width, height: int, unit = 0): SwitcherGrid =
  when defined(frameosEmbedded):
    switcherGrid(width, height, false, round = isRound(self.frameConfig), unit = unit)
  else:
    switcherGrid(width, height, not sceneSwitcherThumbnail.isNil, round = isRound(self.frameConfig), unit = unit)

proc grid(self: SceneSwitcherScene): SwitcherGrid =
  ## The grid the last render drew: at the UI's scale (uiRoom), in the room
  ## it had. Inside a layout that is the hole the layout left, not the panel:
  ## measured on the whole panel, a screen held more tiles than the drawn
  ## one, and the keys scrolled the list by the wrong amount (the reTerminal
  ## E1003 in a Windows 98 window, 2026-11-10, when the list had pages).
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

# ------------------------------------------------------------- the categories

proc groupName(category: string): string =
  ## A category as the desktops' `grouped` reads it: trimmed, and "Other" in
  ## any case the same as none ("").
  var a = 0
  var z = category.len
  while a < z and category[a] in Blank:
    inc a
  while z > a and category[z - 1] in Blank:
    dec z
  result = category.substr(a, z - 1)
  if result.len == 5:
    var other = true
    for i in 0 ..< 5:
      if (ord(result[i]) or 0x20) != ord("other"[i]):
        other = false
    if other:
      result.setLen(0)

proc folded(s: string, i: int): int =
  ## The byte at `i` as `toLowerCase` leaves it, for comparing: A to Z and
  ## the Latin-1 capitals (UTF-8 C3 80 to C3 9E, but for the sign C3 97)
  ## lowered. What other scripts' capitals the desktops lower too only
  ## changes the order of names that differ in nothing else.
  let c = ord(s[i])
  if c >= ord('A') and c <= ord('Z') or c >= 0x80 and c <= 0x9E and c != 0x97 and i > 0 and s[i - 1] == '\xC3':
    c + 32
  else:
    c

proc isSystemGroup(name: string): bool =
  ## Whether `name` is the frame's own apps' category, "System" in any case:
  ## the first group (the store, Files, the terminal, the code editor).
  result = name.len == 6
  for i in 0 ..< min(name.len, 6):
    if (ord(name[i]) or 0x20) != ord("system"[i]):
      result = false

proc before(a, b: string): bool =
  ## Whether the category `a` goes before `b`, as `grouped` sorts them:
  ## System first, then by the names with case aside, and by the names
  ## themselves when that ties.
  var i = 0
  var decided = a.isSystemGroup != b.isSystemGroup
  result = a.isSystemGroup
  while not decided and i < min(a.len, b.len):
    let x = folded(a, i)
    let y = folded(b, i)
    if x != y:
      result = x < y
      decided = true
    inc i
  if not decided:
    result = if a.len != b.len: a.len < b.len else: a < b

proc grouped*(entries: seq[SwitcherEntry]): seq[SwitcherEntry] =
  ## `entries` in the order the switcher shows them, which is the desktops'
  ## `grouped` (docs/scene-layouts.md "Long lists of scenes"): each category's scenes
  ## under it, System first (the frame's own apps), then the categories by
  ## name with case aside, then the scenes with none (or "Other"); in the
  ## list's order within each, and the list as it is where no scene has one.
  ## Each one's `category` becomes its group's name, "" for Other: the first
  ## one has a category when any does.
  var names: seq[string]
  result = entries
  for i in 0 ..< result.len:
    result[i].category = groupName(result[i].category)
    if result[i].category.len > 0 and result[i].category notin names:
      var at = names.len
      while at > 0 and before(result[i].category, names[at - 1]):
        dec at
      names.insert(result[i].category, at)
  if names.len > 0:
    let all = move(result)
    result = newSeqOfCap[SwitcherEntry](all.len)
    for name in names:
      for entry in all:
        if entry.category == name:
          result.add entry
    for entry in all:
      if entry.category.len == 0:
        result.add entry

proc holds(text, part: string): bool =
  ## Whether `part` is in `text`, ASCII letters in either case.
  if part.len == 0:
    return true
  for start in 0 .. text.len - part.len:
    var k = 0
    while k < part.len and text[start + k].toLowerAscii == part[k].toLowerAscii:
      inc k
    if k == part.len:
      return true
  false

proc list(self: SceneSwitcherScene) =
  ## The host's scenes, in the order they are drawn, those the search holds
  ## (by name, category or id), and whether their categories get headings:
  ## wherever a scene has one, even a lone scene, and never where none has
  ## (a list with no categories is one flow with no heading over it).
  self.entries = grouped(listEntries())
  let query = self.state{"query"}.getStr()
  if query.len > 0:
    var kept: seq[SwitcherEntry]
    for entry in self.entries:
      if entry.name.holds(query) or entry.category.holds(query) or entry.id.holds(query):
        kept.add entry
    self.entries = move(kept)
  self.headed = self.entries.len > 0 and self.entries[0].category.len > 0

proc heads*(self: SceneSwitcherScene, index: int): bool =
  ## Whether the cell at `index` starts a category, a heading above it:
  ## wherever a scene has a category (`headed`), Other's heading over the
  ## scenes with none after them, and never where no scene has one.
  self.headed and
    (index == 0 or self.entries[index].category != self.entries[index - 1].category)

type Spot* = tuple[col, top: int]
  ## Where a tile goes in the list: its column, and its top from the list's.

proc rowH(self: SceneSwitcherScene, grid: SwitcherGrid): int =
  ## A row's height, roughly: its cells, and over a category's first row the
  ## strip its heading sits in where there are any.
  grid.tileH + grid.gap + (if self.headed: grid.headingH else: 0)

proc spots*(self: SceneSwitcherScene, grid: SwitcherGrid): seq[Spot] =
  ## Every cell's place in the list, row after row. Where the categories have
  ## headings each starts a row of its own, its heading in a strip above it
  ## (a file manager's sections); without them the scenes flow on in one.
  var col = 0
  var top = grid.y0 - grid.listY + (if self.headed: grid.headingH else: 0)
  for i in 0 ..< self.entries.len:
    if i > 0:
      if self.heads(i):
        col = 0
        top += grid.tileH + grid.gap + grid.headingH
      elif col + 1 >= grid.cols:
        col = 0
        top += grid.tileH + grid.gap
      else:
        inc col
    result.add (col, top)

# ------------------------------------------------------------------ the model

proc opener(self: SceneSwitcherScene): string =
  ## The scene it was opened from (event_loop.nim hands it over), or "".
  self.state{"from"}.getStr()

proc forget(self: SceneSwitcherScene) =
  ## Opened from nowhere it knows: Close goes to the list's first scene.
  self.state.put("from", newJString(""))

proc isHome(self: SceneSwitcherScene): bool =
  ## The frame's home (docs/scene-switcher.md "The frame's home"): what an
  ## ESP32 that takes taps starts on when nothing was picked on it and no
  ## scene is marked default. Nothing to go back to: no Close, no timeout,
  ## and the commands that would go back leave it where it is
  ## (event_loop.nim backFrom). Until a scene is picked from it.
  self.state{"home"}.getBool()

proc highlighted*(self: SceneSwitcherScene): int =
  ## The highlighted tile, the first when the highlight names no scene on the
  ## list; the tile count for the header's gear (after the last tile for the
  ## keys); -1 with nothing to highlight.
  let id = self.state{"highlight"}.getStr()
  if self.gear and (id == GearMark or self.entries.len == 0):
    return self.entries.len
  if self.entries.len == 0:
    return -1
  max(self.indexOf(id), 0)

proc touch*(self: FrameScene) =
  ## Somebody did something: the idle timeout starts over (a built-in
  ## scene's `drawUi`).
  self.state.put("touchedAt", newJFloat(epochTime()))

proc listScroll*(): float32 =
  ## How far down the list is scrolled, in the UI's pixels: by a finger, the
  ## wheel or the keys, kept with the UI's input like any box's.
  uiTarget(SceneSwitcherId, SwitcherNode).input.scrolled(ListKey)[1]

proc scrollList(y: float32) =
  ## The list scrolled to `y` (the next layout keeps it in range).
  uiTarget(SceneSwitcherId, SwitcherNode).input.scrollTo(ListKey, 0, max(y, 0))

proc reveal(self: SceneSwitcherScene, index: int, centred = false) =
  ## The list scrolled as little as it takes for the tile at `index` to
  ## show, with its heading where it starts a category: the keys walk a list
  ## longer than the screen, and e-paper has nothing else to follow them by.
  ## `centred`: one out of sight comes to the middle of the list instead, as
  ## the scene showing does when the list opens.
  let grid = self.grid()
  let spot = self.spots(grid)[index]
  let margin = grid.y0 - grid.listY
  var top = spot.top - margin
  if self.heads(index - spot.col):
    top -= grid.headingH
  let bottom = spot.top + grid.tileH + margin
  let y = listScroll()
  if centred and (top.float32 < y or bottom.float32 > y + grid.listH.float32):
    scrollList(float32(top - max(grid.listH - (bottom - top), 0) div 2))
  elif top.float32 < y:
    scrollList(top.float32)
  elif bottom.float32 > y + grid.listH.float32:
    scrollList(float32(bottom - grid.listH))

proc highlight(self: SceneSwitcherScene, index: int) =
  ## The tile at `index` (wrapping around, through the gear where there is
  ## one) highlighted, and scrolled into sight. The gear is in the header:
  ## the list stays.
  let count = self.entries.len + ord(self.gear)
  if count > 0:
    let i = ((index mod count) + count) mod count
    if i == self.entries.len:
      self.state.put("highlight", newJString(GearMark))
    else:
      self.state.put("highlight", newJString(self.entries[i].id))
      self.reveal(i)

proc screenful(self: SceneSwitcherScene, delta: int) =
  ## The highlight a screenful of tiles on (`delta` 1) or back (-1), and the
  ## list with it: the frame's `forward` and `back`, which a scene direction
  ## is here (event_loop.nim), and Page Down and Up. Past the last tile it
  ## goes to the first, and back from the first to the last.
  let n = self.entries.len
  if n > 0:
    let grid = self.grid()
    let step = max(grid.cols * max((grid.rows * (grid.tileH + grid.gap)) div self.rowH(grid), 1), 1)
    let lit = min(self.highlighted(), n) # n: the gear
    if delta > 0:
      self.highlight(if lit >= n - 1: 0 else: min(lit + step, n - 1))
    else:
      self.highlight(if lit == 0: n - 1 else: max(lit - step, 0))

var wentBack {.threadvar.}: bool
  ## It went back by itself (Close, its timeout, a scene picked where it is
  ## no window), not merely lost the focus to a window beside it: its "close"
  ## ends it (docs/scene-layouts.md "Windows").

proc choose(self: SceneSwitcherScene, index: int) =
  ## Show the scene at `index`, or at the tile count the frame page (the
  ## gear): the dispatcher opens it over the scene this was opened from, in
  ## its layout, so a layout that broke every scene can still be changed.
  let payload = newJObject()
  if index >= 0 and index < self.entries.len:
    payload.put("sceneId", newJString(self.entries[index].id))
    if self.state.hasKey("home"):
      self.state.delete("home")
    # On a desktop it is a launcher: the scene picked opens beside it and the
    # list stays open in its window until it is closed (2026-11-22).
    wentBack = not builtInScenesStay
    sendEvent(evSetCurrentScene, payload, eoScene)
  elif index == self.entries.len and self.gear:
    payload.put("page", newJString("frame"))
    sendEvent(evSceneSettings, payload, eoScene)

proc leave(self: SceneSwitcherScene) =
  ## Back to the scene it was opened from: the dispatcher knows which. The
  ## frame's home has none, and stays.
  if self.isHome():
    return
  wentBack = true
  sendEvent(evSceneSwitcher, newJObject(), eoScene)

proc framePageOffered(): bool =
  ## Whether the frame offers its own page here (frame_settings_hooks): not
  ## where no host has one (an editor's preview), and not while the frame's
  ## control plane turned the settings on the screen off. Then there is no
  ## gear: the page would not open.
  not frameSettingsRead.isNil and not frameSettingsRead().isNil

proc takesNoTaps*(frameConfig: FrameConfig, paper: bool): bool =
  ## Nothing on this frame takes a tap: e-paper whose event map binds its keys
  ## and nothing else. Every touch screen's preset binds the swipes in from
  ## its edges (fos_board.c's TOUCH_EDGE_SWIPES, device_event_map.nim, the
  ## SPA's table), so a map of keys alone is a board of keys alone: the
  ## reTerminal E1001, E1002 and E1004. A frame with no map, or any rule that
  ## is not a key's, may have a finger or a mouse, and keeps the buttons.
  if not paper or frameConfig.isNil or frameConfig.eventMap.isNil or
      frameConfig.eventMap.kind != JArray or frameConfig.eventMap.len == 0:
    return false
  for rule in frameConfig.eventMap:
    if rule{"event"}.getStr() != "button":
      return false
  true

proc opened(self: SceneSwitcherScene) =
  ## Shown: the scene it was opened from is the highlighted one, the list's
  ## first when there is none or it is gone (then Close goes to the first),
  ## and the list scrolled from its top to it: at the first render, which
  ## knows the room (`revealing`; a layout's hole is not the panel).
  self.list()
  self.keysOnly = takesNoTaps(self.frameConfig, panelLook(self.frameConfig).paper)
  self.gear = framePageOffered() and not self.keysOnly
  if self.state.hasKey("query"):
    # A search is for this time: opened again, every scene shows.
    self.state.delete("query")
    self.list()
  if self.opener().len > 0 and self.state.hasKey("home"):
    # Opened from a scene: the way back is there, home or not before.
    self.state.delete("home")
  let index = self.indexOf(self.opener())
  if index < 0:
    self.forget()
  scrollList(0)
  self.highlight(max(index, 0))
  self.revealing = true
  self.touch()

# ---------------------------------------------------------------- input

proc pressed(self: SceneSwitcherScene, payload: JsonNode) =
  ## A key, by its role (the input state gives every `button` one): next /
  ## down and prev / up walk the tiles, a press one step, a double press
  ## two and a triple press three, so every tap counts; primary (OK, the reTerminal's green REFRESH,
  ## BOOT) shows the highlighted scene (opens the frame page on the gear),
  ## back and menu go back. A long press is the frame's where its event map binds it (walk the
  ## scenes, talk); one it leaves free goes back from the key that opens or
  ## from back, so a board of keys alone (the E1004's REFRESH) has a way out.
  # One way out (no early `return`): each one repeats the clean-up of what
  # was read so far.
  let action = payload{"action"}.getStr()
  let steps = if action == "press": 1 elif action == "doublePress": 2 elif action == "triplePress": 3 else: 0
  if steps > 0:
    if self.entries.len == 0:
      self.list()
    var acted = true
    case payload{"role"}.getStr()
    of "next", "down": self.highlight(self.highlighted() + steps)
    of "prev", "up": self.highlight(self.highlighted() - steps)
    of "primary", "refresh": self.choose(self.highlighted())
    of "back", "menu": self.leave()
    else: acted = false
    if acted:
      self.touch()
  elif action == "longPress":
    case payload{"role"}.getStr()
    of "primary", "refresh", "menu", "back": self.leave()
    else: discard

when not defined(frameosEmbedded):
  proc row(self: SceneSwitcherScene, down: bool): int =
    ## The tile a row below (or above) the highlighted one, in its column or
    ## the last of a shorter row: a category starts a row of its own, so the
    ## rows are the tiles' places, not their numbers. Past the last row the
    ## tile count (the gear, or around to the first), above the first -1
    ## (the gear, or around to the last).
    let n = self.entries.len
    let lit = self.highlighted()
    if lit < 0 or lit >= n:
      return (if down: 0 else: -1)
    let spots = self.spots(self.grid())
    let (col, top) = spots[lit]
    result = if down: n else: -1
    var rowTop = -1
    var i = if down: lit + 1 else: lit - 1
    while i >= 0 and i < n and (rowTop < 0 or spots[i].top == rowTop or spots[i].top == top):
      if spots[i].top != top:
        rowTop = spots[i].top
        if spots[i].col <= col and (down or result < 0):
          result = i
      i += (if down: 1 else: -1)

  proc keyed(self: SceneSwitcherScene, payload: JsonNode) =
    ## A keyboard (Linux, the preview): the arrows walk the grid, Tab the
    ## tiles one by one (Shift+Tab back) through the gear, as the frame's
    ## buttons do, Page Down and Up a screenful, Enter shows, Escape goes
    ## back. The highlight is the switcher's one focus: Tab never rings a
    ## tile's icon and its name apart, nor the layout around it.
    if self.entries.len == 0:
      self.list()
    case payload{"code"}.getStr()
    of "Tab": self.highlight(self.highlighted() + (if payload{"shift"}.getBool(): -1 else: 1))
    of "ArrowRight": self.highlight(self.highlighted() + 1)
    of "ArrowLeft": self.highlight(self.highlighted() - 1)
    of "ArrowDown": self.highlight(self.row(true))
    of "ArrowUp": self.highlight(self.row(false))
    of "PageDown": self.screenful(1)
    of "PageUp": self.screenful(-1)
    of "Enter", "NumpadEnter", "Space": self.choose(self.highlighted())
    of "Escape", "Backspace": self.leave()
    else: return
    self.touch()

# --------------------------------------------------------------- the picture
#
# Class names are appended in place, one call per class, and a class that
# depends on something is appended in a branch of its own: every `&` of a few
# strings, and every `if` that yields a string, is its own temporary at each
# call site. Nodes are handed on (`sink`), never copied.

proc txt(text: sink string): SvgNode = SvgNode(text: text)

proc at(c: var string, x, y, w, h: int) =
  c.add "absolute"
  c.px("left", x)
  c.px("top", y)
  c.px("w", w)
  c.px("h", h)

proc square(c: var string, size: int) =
  c.px("w", size)
  c.px("h", size)

proc iconNode(icon: string, side: int, box = "0 0 24 24"): SvgNode =
  ## A scene's icon (docs/scene-icons.md), `side` px square: its one path in
  ## the 24 box, filled with the text color, so it reads on e-paper (black,
  ## white on the highlighted tile) as on an LCD. scene_icon.nim checked the
  ## path when the scene was read, so drawing it raises nothing. The gear's
  ## path is in a box of its own.
  var c = "shrink-0"
  c.square(side)
  SvgNode(tag: "svg", attrs: @[("class", c), ("viewBox", box)],
    children: @[SvgNode(tag: "path", attrs: @[("d", icon), ("fill", "currentColor")])])

proc onClick(node: sink SvgNode, handler: int): SvgNode =
  node.attrs.add(("on-click", $handler))
  node

proc gearButton(self: SceneSwitcherScene, size: int, paper, lit: bool, button: string,
    wide = false): SvgNode =
  ## The frame page's gear, round; `wide`, the header's: wider than tall, its
  ## gear larger, as the scene settings' is. Lit while the keys are on it:
  ## inverted on e-paper as a tile is, ringed on an LCD.
  var c = "shrink-0 flex items-center justify-center rounded-full"
  c.px("h", size)
  c.px("w", if wide: size * 8 div 5 else: size)
  if paper and lit: c.add " bg-black text-white"
  else:
    c.add button
    if lit: c.add " border-2 border-sky-400"
  result = el("div", c, iconNode(GearPath, if wide: size * 4 div 5 else: size * 2 div 3, "0 0 48 48"))
  result = result.role(if lit: "selected" else: "button").onClick(self.entries.len + 1)

type TileLook = object
  ## What every cell in the list shares, and the one at hand.
  paper, lit, showing: bool
  hue: int ## its category's place in the list: its color

const Hues = ["#2563eb", "#d97706", "#059669", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d"]
  ## A category's color for its icons, by its place in the list: icons in a
  ## folder are not all one color, and two categories side by side differ.

proc cellIcon(self: SceneSwitcherScene, look: TileLook, index: int, grid: SwitcherGrid): SvgNode =
  ## The icon of the cell: the scene's own (docs/scene-icons.md) in its
  ## category's color, else its first letter on a rounded square of that
  ## color; black on e-paper. Lit, a tint behind it, as a file manager's
  ## selected icon; a dot at its corner when it is the scene the list was
  ## opened from.
  let side = grid.icon + 2 * grid.inner
  var c = "relative shrink-0 flex items-center justify-center"
  c.square(side)
  c.px("rounded", grid.inner * 2)
  if look.lit and not look.paper: c.add " bg-sky-400/25"
  result = el("div", c)
  let hue = Hues[look.hue mod Hues.len]
  let icon = self.entries[index].icon
  if icon.len > 0:
    var g = "flex items-center justify-center"
    if not look.paper:
      g.add " text-["
      g.add hue
      g.add "]"
    let mark = el("div", g, iconNode(icon, grid.icon))
    result.children.add mark
  else:
    var name = self.entries[index].name
    if name.len == 0: name = self.entries[index].id
    var letter = 1 # the first letter, its UTF-8 continuation bytes too
    while letter < name.len and (ord(name[letter]) and 0xC0) == 0x80:
      inc letter
    var b = "flex items-center justify-center font-bold"
    b.square(grid.icon * 9 div 10)
    b.px("rounded", grid.icon div 5)
    b.px("text", grid.icon div 2)
    if not look.paper:
      b.add " text-white bg-["
      b.add hue
      b.add "]"
    elif look.lit: b.add " border-2 border-white"
    else: b.add " border-2 border-black"
    result.children.add el("div", b, txt(name[0 ..< letter]))
  if look.showing:
    var d = "absolute rounded-full"
    let dot = max(6, grid.text * 2 div 3)
    d.px("top", 0)
    d.px("left", side - dot)
    d.square(dot)
    if not look.paper: d.add " bg-sky-400"
    elif look.lit: d.add " bg-white"
    else: d.add " bg-black"
    result.children.add el("div", d).role("accent")

proc tile(self: SceneSwitcherScene, look: TileLook, index: int, spot: Spot, grid: SwitcherGrid): SvgNode =
  ## The scene at `index`, at its `spot`: a folder's icon, its name centred
  ## under it on two lines at most. No box around it: lit for the keys, the
  ## icon gets a tint and the name a filled label in the theme's `picked`
  ## (Explorer's blue label, Finder's pill); on e-paper the cell is inverted.
  var c: string
  c.at(grid.x0 - grid.listX + spot.col * (grid.tileW + grid.gap), spot.top, grid.tileW, grid.tileH)
  c.px("pt", grid.inner + grid.lift)
  c.px("gap", grid.inner)
  c.px("rounded", grid.inner * 2)
  c.add " flex flex-col items-center"
  if look.paper:
    if look.lit: c.add " bg-black text-white"
  else:
    c.add " active:bg-sky-400/15"
  result = el("div", c, self.cellIcon(look, index, grid)).onClick(index)
  var title = self.entries[index].name
  if title.len == 0:
    title = self.entries[index].id
  var n = "max-w-full text-center line-clamp-2 leading-tight"
  n.px("text", grid.text)
  n.px("px", grid.inner)
  n.px("rounded", grid.inner)
  if look.paper: n.add " font-bold"
  elif look.lit: n.add " bg-sky-600 text-white"
  let label = el("span", n, txt(title))
  result.children.add(if look.lit and not look.paper: label.role("picked") else: label)

proc header(self: SceneSwitcherScene, root: SvgNode, grid: SwitcherGrid, paper: bool,
    width, size, small: int, button: string) =
  ## A rectangular panel's header: the title, the frame page's gear, Close;
  ## on a frame that takes no taps the title alone.
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
  if not self.keysOnly:
    # The quick search: what is typed keeps the scenes that hold it.
    c = "shrink min-w-0 rounded-full"
    c.px("w", clamp(width * 2 div 5, 64, max(small * 16, 64)))
    c.px("h", clamp(grid.headerH * 6 div 10, 14, 40))
    c.px("px", max(6, small))
    c.px("text", small)
    if paper: c.add " border-2 border-black bg-white text-black"
    else: c.add " bg-zinc-800 focus:bg-zinc-700 placeholder:text-zinc-500"
    let search = el("input", move c)
    search.attrs.add(("value", self.state{"query"}.getStr()))
    search.attrs.add(("placeholder", "Search"))
    search.attrs.add(("on-change", $SearchHandler))
    header.children.add search.role("field")
  if self.gear:
    header.children.add self.gearButton(clamp(grid.headerH * 3 div 4, 14, 48), paper,
      self.highlighted() == self.entries.len, button, wide = true)
  if self.keysOnly or self.isHome():
    # Nothing to close to at the frame's home.
    root.children.add header.role("bar")
    return
  c = "shrink-0 rounded-full"
  c.px("px", max(6, small))
  c.px("py", max(2, small div 4))
  c.px("text", small)
  c.add button
  header.children.add el("div", c, txt("Close")).role("button").onClick(self.entries.len)
  root.children.add header.role("bar")

proc roundChrome(self: SceneSwitcherScene, root: SvgNode, grid: SwitcherGrid, paper: bool,
    size, small: int, button: string) =
  ## A round panel's: the list fills the square inside the circle, the
  ## title is in the arc above it (12 o'clock) and Close in the one below
  ## (6). Every box is cut to the chord it sits on, so no corner leaves the
  ## circle `RoundInset` in from the rim.
  let
    gap = grid.gap * 3 # the cells' gap is a file manager's, the chrome's three of it
    arc = grid.y0 - (grid.cy - grid.radius) # the top and bottom arcs' depth
    rowH = max(min(clamp(grid.headerH * 7 div 10, 16, 44), arc - gap), 8)
    top = grid.y0 - gap div 2 - rowH
    titleHalf = max(chordHalf(grid.radius, grid.cy - top) - 2, 4)
  var c: string
  c.at(grid.cx - titleHalf, top, 2 * titleHalf, rowH)
  c.add " flex items-center justify-center truncate font-bold"
  c.px("text", size)
  root.children.add el("div", c, txt("Scenes"))
  let
    closeTop = grid.y0 + grid.side + gap div 2
    closeHalf = max(chordHalf(grid.radius, closeTop + rowH - grid.cy) - 2, 4)
    # The gear left of Close, the two centred on the chord together.
    gearW = if self.gear: rowH + gap else: 0
    closeW = max(min(2 * closeHalf - gearW, max(small * 6, 72)), 8)
    left = grid.cx - (closeW + gearW) div 2
  c = ""
  c.at(left + gearW, closeTop, closeW, rowH)
  c.add " flex items-center justify-center rounded-full"
  c.px("text", small)
  c.add button
  if not self.isHome():
    root.children.add el("div", c, txt("Close")).role("button").onClick(self.entries.len)
  if self.gear:
    let gear = self.gearButton(rowH, paper, self.highlighted() == self.entries.len, button)
    gear.attrs[0][1].add " absolute"
    gear.attrs[0][1].px("left", left)
    gear.attrs[0][1].px("top", closeTop)
    root.children.add gear

proc heading(grid: SwitcherGrid, spot: Spot, span: int, title: string, paper: bool): SvgNode =
  ## A category's name over the row it starts, small, with a rule under it
  ## across the row: a file manager's sections.
  var c: string
  c.at(grid.x0 - grid.listX + spot.col * (grid.tileW + grid.gap), spot.top - grid.headingH,
    span * (grid.tileW + grid.gap) - grid.gap, grid.headingH - grid.gap)
  c.add " flex items-end"
  c.px("px", grid.inner)
  c.px("pb", grid.inner div 2)
  c.px("text", max(grid.text - 1, 10))
  c.add(if paper: " border-b-2 border-black" else: " border-b border-zinc-500/40")
  var t = "truncate font-bold"
  if not paper: t.add " text-zinc-400"
  result = el("div", c, el("span", t, txt(if title.len > 0: title else: "Other")).role("muted"))

proc tree*(self: SceneSwitcherScene, width, height: int, paper: bool, unit = 0): SvgNode =
  ## The switcher as a UI tree: the list of tiles that scrolls, each where
  ## `spots` put it, under a heading per category where the scenes have
  ## them, and the header (its title, the gear, Close), or on a round panel
  ## the same around the circle. The outermost element fills the canvas by
  ## itself (ui/layout.nim), its children placed on it. `unit`: what its
  ## sizes are a share of (uiRoom).
  self.roomW = width
  self.roomH = height
  self.unit = unit
  let
    grid = self.grid(width, height, unit)
    lit = self.highlighted()
    size = clamp(grid.headerH * 45 div 100, 12, 32)
    small = max(size * 3 div 4, 10)
    button = if paper: " border-2 border-black" else: " bg-zinc-800 active:bg-zinc-600"
  # E-paper's white and black are the canvas's own (the scene background, and
  # the layout's text color); an LCD's dark page covers every pixel, so a
  # press repaints only what it changed (utils/svg_frames.nim).
  result = el("div", if paper: "" else: "bg-zinc-950 text-white").role("page")
  # The list first: its place in the tree is what its scroll is kept by
  # (ListKey). Its tiles are placed on it, and it scrolls as far as the last
  # one and the padding under it.
  var c: string
  c.at(grid.listX, grid.listY, grid.listW, grid.listH)
  c.add " overflow-y-auto"
  if not grid.round:
    c.px("pb", grid.pad)
  let list = el("div", move c)
  result.children.add list
  if grid.round:
    self.roundChrome(result, grid, paper, size, small, button)
  else:
    self.header(result, grid, paper, width, size, small, button)
  if self.entries.len == 0:
    c = ""
    if grid.round: c.at(grid.x0, grid.y0, grid.side, grid.side)
    else: c.at(0, grid.y0, width, max(height - grid.y0, 1))
    c.add " flex items-center justify-center text-center"
    c.px("text", size)
    result.children.add el("div", c,
      txt(if self.state{"query"}.getStr().len > 0: "No scenes match." else: "No scenes installed yet."))
  # No `return` for that: the loop below ends at once, and one way out keeps
  # one clean-up.
  var look = TileLook(paper: paper)
  let opener = self.opener()
  let spots = self.spots(grid)
  let scroll = if grid.round: int(listScroll()) else: 0
  var group = -1
  for index in 0 ..< self.entries.len:
    if index == 0 or self.entries[index].category != self.entries[index - 1].category:
      inc group
    if self.heads(index):
      # Across its row: a category starts a row of its own.
      list.children.add heading(grid, spots[index], grid.cols, self.entries[index].category, paper)
    look.hue = group
    look.lit = index == lit
    look.showing = self.entries[index].id == opener
    list.children.add self.tile(look, index, spots[index],
      if grid.round: grid.lens(spots[index].top, scroll) else: grid)

const
  PaperWhite = color(1, 1, 1, 1)
  Zinc950 = color(0.035, 0.035, 0.043, 1)

proc background*(paper: bool): Color =
  if paper: PaperWhite else: Zinc950

proc drawUi*(self: FrameScene, sceneId: string, tree: SvgNode, image: Image, paper, slow: bool,
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
  target.input.slow = slow
  target.input.round = isRound(self.frameConfig)
  var regions: seq[UiRegion]
  let svg = layoutUiDocked(tree, roomW, roomH, target.input, regions, target.memo, sceneId,
    image.width.float32 / max(roomW, 1).float32, 0, 0)
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
  ## hit, for `pointer` to act on once the hit test is done; the search
  ## field's text with it.
  tapped = handler
  if handler == SearchHandler:
    searched = event{"value"}.getStr()

proc draw*(self: SceneSwitcherScene, image: Image) =
  ## One render: the list read again, laid out, drawn into `image`, and the
  ## tiles left behind for the pointer.
  self.list()
  if self.indexOf(self.opener()) < 0:
    # Gone from the list since it opened: Close goes to the list's first.
    self.forget()
  (self.paper, self.slow) = panelLook(self.frameConfig, image)
  # Keys alone: no button to tap, and no gear for the keys to walk to (its
  # page wants a finger).
  self.keysOnly = takesNoTaps(self.frameConfig, self.paper)
  self.gear = framePageOffered() and not self.keysOnly
  # A slow panel shows no press: a refresh to say a finger is down is seconds
  # of flashing for nothing. `pointer` hands it taps alone, which leave the
  # target's input (what is hovered, what is pressed) empty. Back by itself
  # once nobody has touched it for a while, but for the frame's home.
  let (roomW, roomH) = uiRoom(self.frameConfig, image.width, image.height)
  let unit = self.sizeUnit(image)
  if self.revealing:
    # Just opened: the scene it was opened from in sight, in the middle of
    # the list where it is further down, measured in the room this render
    # has (a layout's hole, a window), which the open did not know.
    self.revealing = false
    self.roomW = roomW
    self.roomH = roomH
    self.unit = unit
    scrollList(0)
    let lit = self.highlighted()
    if lit >= 0 and lit < self.entries.len:
      self.reveal(lit, centred = true)
  let tree = self.tree(roomW, roomH, self.paper, unit)
  let idle = if self.isHome(): HomeIdleSeconds else: idleSeconds(self.slow)
  if self.drawUi(SceneSwitcherId, tree, image, self.paper, self.slow, onTap, idle, roomW, roomH):
    self.leave()

# ------------------------------------------------------------ the scene

proc pointer(self: SceneSwitcherScene, event: string, payload: JsonNode) =
  ## A pointer event over the switcher: ui/events.nim hit-tests it, and
  ## scrolls the list under a finger or the wheel. A slow panel shows no
  ## press there, and a drag of the list only where it let go.
  tapped = -1
  let changed = dispatchUiEvent(SceneSwitcherId, event, payload)
  let count = self.entries.len
  if tapped == SearchHandler:
    # Typed into the search: the list again, from its top, the first match lit.
    self.state.put("query", newJString(searched))
    self.list()
    scrollList(0)
    if self.entries.len > 0:
      self.highlight(0)
    tapped = -1
    self.touch()
    sendEvent(evRender, newJObject(), eoScene)
  elif tapped >= 0:
    # A tile, Close or the gear: what it did is the next picture (a switch).
    # A tap on nothing is nothing.
    if tapped < count: self.choose(tapped)
    elif tapped == count: self.leave()
    else: self.choose(count)
    tapped = -1
    self.touch()
  elif changed:
    # What is pressed moved, the list scrolled, or a tap gave the search the
    # keyboard or took it away: the contract renders nothing after a pointer
    # event, so the picture is asked for here. (A tap on the search asked for
    # none, and an ESP32 focuses a field on the tap alone: the keyboard came
    # up only when something else drew, on the reTerminal Sticky 2026-11-25.)
    self.touch()
    sendEvent(evRender, newJObject(), eoScene)

proc switcherOwnRun(self: FrameScene, context: ExecutionContext) {.nimcall.} =
  ## What raises here is reported by the caller, as for any scene: the
  ## dispatcher's `event:error`, the render pass's own. The payload is read
  ## with `{}` alone, which answers a nil or a non-object payload with nil.
  let self = SceneSwitcherScene(self)
  let payload = context.payload
  case context.event
  of "setCurrentScene":
    # What the dispatcher says it was opened from (event_loop.nim), and
    # whether it is the frame's home (`isHome`).
    for key in ["from", "layout", "home"]:
      let value = payload{"state", key}
      if not value.isNil:
        self.state.put(key, value)
  of "open":
    wentBack = false
    builtInAway(self.id.string, false)
    if self.state{"away"}.getBool():
      # Brought forward from its window: where it was, scrolled and
      # highlighted as it was left, the host's scenes listed again.
      self.state.delete("away")
      self.list()
      self.touch()
    else:
      if self.state.hasKey("away"):
        self.state.delete("away")
      self.opened()
  of "close":
    # Sent back by the dispatcher (its command again from anyone, a layout's
    # close) is going back too.
    let sentBack = self.state{"goneBack"}.getBool()
    if self.state.hasKey("goneBack"):
      self.state.delete("goneBack")
    if wentBack or sentBack or not builtInScenesStay:
      # Done: opened again by name (a `setCurrentScene` to it), it knows no
      # scene to go back to.
      wentBack = false
      builtInAway(self.id.string, false)
      self.forget()
    else:
      # The focus went to a window beside it (docs/scene-layouts.md
      # "Windows"): it stays open there, Close still going back where it
      # was opened from, and does not go back by itself (drawUi).
      self.state.put("away", newJBool(true))
      builtInAway(self.id.string, true)
  of "render":
    if context.hasImage and not context.image.isNil:
      self.draw(context.image)
  of "button":
    self.pressed(payload)
  of evBack, evForward:
    # The frame's back and forward (a swipe in from the left or the right
    # edge, and a scene direction while it shows, event_loop.nim): a
    # screenful of tiles back or on, the list with it.
    self.screenful(if context.event == evForward: 1 else: -1)
    self.touch()
  else:
    when not defined(frameosEmbedded):
      if context.event == "keyDown" and uiTarget(SceneSwitcherId, SwitcherNode).input.focus == 0:
        self.keyed(payload)
        return
      if context.event == "keyDown" and payload{"code"}.getStr() in ["Enter", "NumpadEnter"] and
          self.entries.len > 0:
        # Enter in the search shows the scene it found (the first, or the one lit).
        self.choose(max(self.highlighted(), 0))
        self.touch()
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
  # The panel's, from the host: there is no canvas yet.
  let (paper, slow) = panelLook(frameConfig)
  SceneSwitcherScene(id: sceneId, frameConfig: frameConfig, logger: logger, state: newJObject(), ownRun: switcherOwnRun,
    shownName: "Scene switcher", refreshInterval: idleSeconds(slow), backgroundColor: background(paper), paper: paper,
    slow: slow)

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
