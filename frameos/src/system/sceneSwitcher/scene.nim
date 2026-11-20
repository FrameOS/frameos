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
## ui/events.nim's, as for a JS app's UI. A fast panel gets a dark grid with
## each scene's last picture where the host keeps one
## (`sceneSwitcherThumbnail`: the Linux runner's scene snapshots); e-paper
## gets black on white with the highlighted tile inverted, so it reads on a
## one-bit panel and follows the keys, and the list scrolls to the tile they
## are on. The scene list is the host's (`sceneSwitcherListing`): the order
## `setCurrentScene {direction}` walks, with each scene's name and category,
## grouped as the desktops group them (`grouped`). A gear in the header opens
## the frame page (`sceneSettings {page: "frame"}`), where the frame offers
## one: the way back to the layout's choice when the switcher is all a layout
## left reachable.
##
## Flash is the budget on an ESP32 (AGENTS.md): the firmware gets the names
## only layout, no keyboard, no pictures and no round panel (none of its
## boards has one), integer arithmetic, and no Nim checks in this module.
## Every index here is guarded by the loop or the test that reaches it.

import std/[json, options, tables, times]
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
    listX*, listY*, listW*, listH*: int
    ## A round panel (frameos/panel_shape): the list is the square inside
    ## the circle `radius` px around (cx, cy) (`RoundInset` in from the rim),
    ## and the title and Close sit in the arcs above and below it.
    round*: bool
    cx*, cy*, radius*, side*: int

  SceneSwitcherScene* = ref object of FrameScene
    entries*: seq[SwitcherEntry] ## what the last render or key listed
    paper*: bool ## drawn in e-paper's look last time (panelLook)
    slow*: bool ## a press cost a refresh last time (panelLook): taps alone
    gear*: bool ## the frame offers its page (frameSettingsRead): the header's gear, after the tiles for the keys
    roomW, roomH, unit: int ## what the last render laid out in (tree): 0 before one

const
  SwitcherNode = 1 ## the ui/events target its tiles live in
  ListKey = 1
    ## The list's place in the tree (ui/layout.nim keys a child `key * 31 + i
    ## + 1`): the root's first child. Its scroll is kept by that key.
  IdleSecondsFast* = 60.0
  IdleSecondsSlow* = 300.0
  MaxCols = 6
  MaxRows = 6
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
  # gear (count + 1), or -1. Read by runEvent once the hit test is done, so
  # the handler holds nothing of the scene's.
  tapped {.threadvar.}: int

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
  ## "Windows"): `{id, name}`, and its window size, icon and category where
  ## it has them. One builder for every host, so their listings stay alike.
  result = newJObject()
  result.putText("id", entry.id, always = true)
  result.putText("name", entry.name, always = true)
  result.putText("windowSize", entry.windowSize)
  result.putText("icon", entry.icon)
  result.putText("category", entry.category)

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

const DesktopUnit = 400
  ## A built-in scene's unit in a desktop's window: its letters a size from
  ## the desktops' apps (16 px in the settings).

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
  ## The tile grid on a `width` x `height` canvas: the densest one whose
  ## tiles stay big enough to read, whatever the number of scenes, so a tile
  ## is the same size with three scenes as with thirty (the owner's rule,
  ## 2026-11-10: tiles that grew to fill the screen looked odd, and on an
  ## ESP32 each picture's pixels are what the switcher's render costs). Among
  ## grids as dense, the one whose pictures (at the canvas's own aspect) or
  ## name cards come out largest. More rows than fit scroll.
  ## On a round panel the list is the square inscribed in the circle that
  ## stays `RoundInset` in from the rim, so no tile shows a corner off the
  ## glass.
  ## `unit`: what the sizes are a share of (the panel's shorter edge, for a
  ## UI laid out at its render scale); the canvas's shorter edge without it.
  let unit = if unit > 0: unit else: min(width, height)
  result.pad = clamp(permille(unit, 35), 4, 24)
  result.gap = clamp(permille(unit, 25), 3, 16)
  result.headerH = clamp(permille(unit, 110), 18, 64)
  result.headingH = clamp(permille(unit, 70), 16, 48)
  result.x0 = result.pad
  result.y0 = result.headerH + result.gap
  # Under the header to the bottom edge, the whole width, so a finger
  # anywhere below the header scrolls it.
  result.listY = result.headerH
  result.listW = width
  result.listH = max(height - result.headerH, 1)
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
      result.listX = result.x0
      result.listY = result.y0
      result.listW = result.side
      result.listH = result.side
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

proc isRound*(frameConfig: FrameConfig): bool =
  ## Whether the frame's panel shows only the circle inside it
  ## (frameos/panel_shape.nim); never on an ESP32.
  when defined(frameosEmbedded): false
  else: not frameConfig.isNil and panelIsRound(frameConfig.device)

proc grid(self: SceneSwitcherScene, width, height: int, unit = 0): SwitcherGrid =
  when defined(frameosEmbedded):
    switcherGrid(width, height, false, unit = unit)
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

proc before(a, b: string): bool =
  ## Whether the category `a` goes before `b`, as `grouped` sorts them: by
  ## the names with case aside, and by the names themselves when that ties.
  var i = 0
  var decided = false
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
  ## under it, the categories by name with case aside, then the scenes with
  ## none (or "Other"); in the list's order within each, and the list as it
  ## is where no scene has one. Each one's `category` becomes its group's
  ## name, "" for Other: the first one has a category when any does.
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

proc list(self: SceneSwitcherScene) =
  ## The host's scenes, in the order they are drawn and numbered.
  self.entries = grouped(listEntries())

proc heads*(self: SceneSwitcherScene, index: int): bool =
  ## Whether the tile at `index` starts a category, a heading above it: never
  ## where no scene has one.
  self.entries.len > 0 and self.entries[0].category.len > 0 and
    (index == 0 or self.entries[index].category != self.entries[index - 1].category)

type Spot* = tuple[col, top: int]
  ## Where a tile goes in the list: its column, and its top from the list's.

proc spots*(self: SceneSwitcherScene, grid: SwitcherGrid): seq[Spot] =
  ## Every tile's place in the list, row after row, a category's tiles from
  ## a row of their own under its heading.
  var col = 0
  var top = grid.y0 - grid.listY
  for i in 0 ..< self.entries.len:
    if self.heads(i):
      if col > 0:
        top += grid.tileH + grid.gap
        col = 0
      top += grid.headingH
    result.add (col, top)
    inc col
    if col == grid.cols:
      col = 0
      top += grid.tileH + grid.gap

# ------------------------------------------------------------------ the model

proc opener(self: SceneSwitcherScene): string =
  ## The scene it was opened from (event_loop.nim hands it over), or "".
  self.state{"from"}.getStr()

proc forget(self: SceneSwitcherScene) =
  ## Opened from nowhere it knows: Close goes to the list's first scene.
  self.state.put("from", newJString(""))

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

proc reveal(self: SceneSwitcherScene, index: int) =
  ## The list scrolled as little as it takes for the tile at `index` to
  ## show, with its heading where it starts a category: the keys walk a list
  ## longer than the screen, and e-paper has nothing else to follow them by.
  let grid = self.grid()
  let spot = self.spots(grid)[index]
  let margin = grid.y0 - grid.listY
  var top = spot.top - margin
  if self.heads(index):
    top -= grid.headingH
  let bottom = spot.top + grid.tileH + margin
  let y = listScroll()
  if top.float32 < y:
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
    let step = max(grid.cols * grid.rows, 1)
    let lit = min(self.highlighted(), n) # n: the gear
    if delta > 0:
      self.highlight(if lit >= n - 1: 0 else: min(lit + step, n - 1))
    else:
      self.highlight(if lit == 0: n - 1 else: max(lit - step, 0))

var wentBack {.threadvar.}: bool
  ## It went back by itself (a scene picked, Close, its timeout), not merely
  ## lost the focus to a window beside it: its "close" ends it
  ## (docs/scene-layouts.md "Windows").

proc choose(self: SceneSwitcherScene, index: int) =
  ## Show the scene at `index`, or at the tile count the frame page (the
  ## gear): the dispatcher opens it over the scene this was opened from, in
  ## its layout, so a layout that broke every scene can still be changed.
  let payload = newJObject()
  if index >= 0 and index < self.entries.len:
    payload.put("sceneId", newJString(self.entries[index].id))
    wentBack = true
    sendEvent(evSetCurrentScene, payload, eoScene)
  elif index == self.entries.len and self.gear:
    payload.put("page", newJString("frame"))
    sendEvent(evSceneSettings, payload, eoScene)

proc leave() =
  ## Back to the scene it was opened from: the dispatcher knows which.
  wentBack = true
  sendEvent(evSceneSwitcher, newJObject(), eoScene)

proc framePageOffered(): bool =
  ## Whether the frame offers its own page here (frame_settings_hooks): not
  ## where no host has one (an editor's preview), and not while the frame's
  ## control plane turned the settings on the screen off. Then there is no
  ## gear: the page would not open.
  not frameSettingsRead.isNil and not frameSettingsRead().isNil

proc opened(self: SceneSwitcherScene) =
  ## Shown: the scene it was opened from is the highlighted one, the list's
  ## first when there is none or it is gone (then Close goes to the first),
  ## and the list scrolled from its top to it.
  self.list()
  self.gear = framePageOffered()
  let index = self.indexOf(self.opener())
  if index < 0:
    self.forget()
  scrollList(0)
  self.highlight(max(index, 0))
  self.touch()

# ---------------------------------------------------------------- input

proc pressed(self: SceneSwitcherScene, payload: JsonNode) =
  ## A key, by its role (the input state gives every `button` one): next /
  ## down and prev / up walk the tiles, a press one step and a double press
  ## two, so every tap counts; primary, refresh and menu (OK, REFRESH, BOOT)
  ## show the highlighted scene (open the frame page on the gear), back goes
  ## back. A long press is the frame's (its event map walks the scenes) or
  ## nothing.
  # One way out (no early `return`): each one repeats the clean-up of what
  # was read so far.
  let action = payload{"action"}.getStr()
  let steps = if action == "press": 1 elif action == "doublePress": 2 else: 0
  if steps > 0:
    if self.entries.len == 0:
      self.list()
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
    ## A keyboard (Linux, the preview): the arrows walk the grid, Page Down
    ## and Up a screenful, Enter shows, Escape goes back.
    if self.entries.len == 0:
      self.list()
    case payload{"code"}.getStr()
    of "ArrowRight": self.highlight(self.highlighted() + 1)
    of "ArrowLeft": self.highlight(self.highlighted() - 1)
    of "ArrowDown": self.highlight(self.row(true))
    of "ArrowUp": self.highlight(self.row(false))
    of "PageDown": self.screenful(1)
    of "PageUp": self.screenful(-1)
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

proc gearButton(self: SceneSwitcherScene, size: int, paper, lit: bool, button: string): SvgNode =
  ## The frame page's gear, round. Lit while the keys are on it: inverted on
  ## e-paper as a tile is, ringed on an LCD.
  var c = "shrink-0 flex items-center justify-center rounded-full"
  c.square(size)
  if paper and lit: c.add " bg-black text-white"
  else:
    c.add button
    if lit: c.add " border-2 border-sky-400"
  result = el("div", c, iconNode(GearPath, size * 2 div 3, "0 0 48 48"))
  result = result.role(if lit: "selected" else: "button").onClick(self.entries.len + 1)

type TileLook = object
  ## What every tile in the list shares, and the one at hand.
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
    # No picture yet (a scene not shown since the card was made): its icon,
    # else its number.
    c.add " flex items-center justify-center font-bold"
    c.add(if not look.paper: " bg-zinc-700" elif look.lit: " border-2 border-white" else: " border-2 border-black")
    c.px("text", clamp(ph div 3, 12, 64))
    c.mute(look)
    let icon = self.entries[index].icon
    let mark = if icon.len > 0: iconNode(icon, clamp(min(pw, ph) * 45 div 100, 12, 160)) else: txt($(index + 1))
    tile.children.add el("div", c, mark).role("field")
  let row = look.titleRow(index, size, titleH)
  row.children.add el("span", if look.paper: "truncate font-bold" else: "truncate", txt(title))
  tile.children.add row
  true

proc tile(self: SceneSwitcherScene, look: TileLook, index: int, spot: Spot, grid: SwitcherGrid,
    button: string): SvgNode =
  ## The scene at `index`, at its `spot` in the list.
  var c: string
  c.at(grid.x0 - grid.listX + spot.col * (grid.tileW + grid.gap), spot.top, grid.tileW, grid.tileH)
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
  # Its icon above the name where the card has room for both (the number
  # row, the name's lines, the gap), up to three letters tall. The name
  # takes two lines when it looks too long for one (a letter is about half
  # as wide as it is tall), and is cut to what it was given.
  let
    icon = self.entries[index].icon
    inner = 2 * look.border + 2 * look.inner
    gap = max(2, size div 4)
    lines = if title.len * size * 11 div 20 > grid.tileW - inner: 2 else: 1
    side = if icon.len == 0: 0
      else: min(min(grid.tileH - inner - size - lines * (size * 6 div 5) - gap, (grid.tileW - inner) * 2 div 3),
        size * 3)
  var name = "grow flex items-center justify-center text-center font-bold"
  name.px("text", size)
  if side >= 12:
    name.add " flex-col"
    name.px("gap", gap)
    let column = el("div", name, iconNode(icon, side))
    column.children.add el("div", if lines == 1: "text-center line-clamp-1" else: "text-center line-clamp-2",
      txt(title))
    result.children.add column
  else:
    name.add " line-clamp-3"
    result.children.add el("div", name, txt(title))
  result = result.role(if look.lit: "tileLit" else: "tile")

proc header(self: SceneSwitcherScene, root: SvgNode, grid: SwitcherGrid, paper: bool,
    width, size, small: int, button: string) =
  ## A rectangular panel's header: the title, the frame page's gear, Close.
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
  if self.gear:
    header.children.add self.gearButton(clamp(grid.headerH * 6 div 10, 14, 40), paper,
      self.highlighted() == self.entries.len, button)
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
  proc roundChrome(self: SceneSwitcherScene, root: SvgNode, grid: SwitcherGrid, paper: bool,
      size, small: int, button: string) =
    ## A round panel's: the list fills the square inside the circle, the
    ## title is in the arc above it (12 o'clock) and Close in the one below
    ## (6). Every box is cut to the chord it sits on, so no corner leaves the
    ## circle `RoundInset` in from the rim.
    let
      arc = grid.y0 - (grid.cy - grid.radius) # the top and bottom arcs' depth
      rowH = max(min(clamp(grid.headerH * 7 div 10, 16, 44), arc - grid.gap), 8)
      top = grid.y0 - grid.gap div 2 - rowH
      titleHalf = max(chordHalf(grid.radius, grid.cy - top) - 2, 4)
    var c: string
    c.at(grid.cx - titleHalf, top, 2 * titleHalf, rowH)
    c.add " flex items-center justify-center truncate font-bold"
    c.px("text", size)
    root.children.add el("div", c, txt("Scenes"))
    let
      closeTop = grid.y0 + grid.side + grid.gap div 2
      closeHalf = max(chordHalf(grid.radius, closeTop + rowH - grid.cy) - 2, 4)
      # The gear left of Close, the two centred on the chord together.
      gearW = if self.gear: rowH + grid.gap else: 0
      closeW = max(min(2 * closeHalf - gearW, max(small * 6, 72)), 8)
      left = grid.cx - (closeW + gearW) div 2
    c = ""
    c.at(left + gearW, closeTop, closeW, rowH)
    c.add " flex items-center justify-center rounded-full"
    c.px("text", small)
    c.add button
    root.children.add el("div", c, txt("Close")).role("button").onClick(self.entries.len)
    if self.gear:
      let gear = self.gearButton(rowH, paper, self.highlighted() == self.entries.len, button)
      gear.attrs[0][1].add " absolute"
      gear.attrs[0][1].px("left", left)
      gear.attrs[0][1].px("top", closeTop)
      root.children.add gear

proc heading(grid: SwitcherGrid, top: int, title: string, paper: bool, small: int): SvgNode =
  ## A category's name over its tiles, across the list.
  var c: string
  c.at(grid.x0 - grid.listX, top - grid.headingH, grid.cols * (grid.tileW + grid.gap) - grid.gap,
    grid.headingH)
  c.add " flex items-center"
  c.px("text", small)
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
  let list = el("div", c)
  result.children.add list
  when defined(frameosEmbedded):
    self.header(result, grid, paper, width, size, small, button)
  else:
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
    result.children.add el("div", c, txt("No scenes installed yet."))
  # No `return` for that: the loop below ends at once, and one way out keeps
  # one clean-up.
  var look = TileLook(paper: paper, unit: min(grid.tileW, grid.tileH))
  look.border = max(2, look.unit div (if paper: 40 else: 45))
  look.inner = max(3, look.unit div 22)
  look.radius = clamp(look.unit div 12, 3, 16)
  let opener = self.opener()
  let spots = self.spots(grid)
  for index in 0 ..< self.entries.len:
    if self.heads(index):
      list.children.add heading(grid, spots[index].top, self.entries[index].category, paper, small)
    look.lit = index == lit
    look.showing = self.entries[index].id == opener
    list.children.add self.tile(look, index, spots[index], grid, button)

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
  self.list()
  self.gear = framePageOffered()
  if self.indexOf(self.opener()) < 0:
    # Gone from the list since it opened: Close goes to the list's first.
    self.forget()
  (self.paper, self.slow) = panelLook(self.frameConfig, image)
  # A slow panel shows no press: a refresh to say a finger is down is seconds
  # of flashing for nothing. `pointer` hands it taps alone, which leave the
  # target's input (what is hovered, what is pressed) empty. Back by itself
  # once nobody has touched it for a while.
  var more = false
  when not defined(frameosEmbedded):
    # Pictures that would have kept the panel waiting come in the next
    # render (the Linux host's decode budget, scene_switcher_linux.nim). Not
    # on a slow panel, where each render is a refresh: it waits for all of them.
    let pass = if self.slow: nil else: sceneSwitcherThumbnailPass
    if not pass.isNil:
      try: discard pass(true) except Exception: discard
  let (roomW, roomH) = uiRoom(self.frameConfig, image.width, image.height)
  let tree = self.tree(roomW, roomH, self.paper, self.sizeUnit(image))
  when not defined(frameosEmbedded):
    if not pass.isNil:
      try: more = pass(false) except Exception: more = false
  if self.drawUi(SceneSwitcherId, tree, image, self.paper, self.slow, onTap, idleSeconds(self.slow), roomW, roomH):
    leave()
  elif more:
    rhythmMarkDue(self)
    sendEvent(evRender, newJObject(), eoScene)

# ------------------------------------------------------------ the scene

proc pointer(self: SceneSwitcherScene, event: string, payload: JsonNode) =
  ## A pointer event over the switcher: ui/events.nim hit-tests it, and
  ## scrolls the list under a finger or the wheel. A slow panel shows no
  ## press there, and a drag of the list only where it let go.
  let tap = event == "tap"
  tapped = -1
  let changed = dispatchUiEvent(SceneSwitcherId, event, payload)
  let count = self.entries.len
  if tapped >= 0:
    # A tile, Close or the gear: what it did is the next picture (a switch).
    # A tap on nothing is nothing.
    if tapped < count: self.choose(tapped)
    elif tapped == count: leave()
    else: self.choose(count)
    tapped = -1
    self.touch()
  elif changed and not tap:
    # What is pressed moved, or the list scrolled: the contract renders
    # nothing after a pointer event, so the picture is asked for here.
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
    # What the dispatcher says it was opened from (event_loop.nim).
    for key in ["from", "layout"]:
      let value = payload{"state", key}
      if not value.isNil:
        self.state.put(key, value)
  of "open":
    wentBack = false
    builtInAway(self.id.string, false)
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
