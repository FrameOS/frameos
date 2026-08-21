## The one FrameOS status screen: what a frame shows when it has nothing
## else to show. The Pi runtime draws it while booting (frameos.nim, HDMI
## only), as the `system/index` scene (no scenes installed), and the ESP32
## runtime draws it as its built-in fallback scene (embedded/embedded_scene.nim)
## — same layout, same rows, so a frame looks like a FrameOS frame on every
## board and at every stage.
##
##   [mark]  FrameOS
##           Checking network…                ← `status`
##
##   Name        uus2w                        ← `rows`
##   Device      framebuffer · 1920×1080
##   Network     10.8.0.62 (wlan0)
##   Managed via FrameOS Cloud (cloud.frameos.net, connected)
##
##   Installed scenes                         ← `notes`
##   1. Default Scene
##                                     v2026.8.33 ← `footer`
##
## Colours: `dark` (white on black) is the HDMI / LCD look; `light` (black
## on white) is the e-ink look. The mark is drawn from the embedded SVG so it
## scales with the panel instead of shipping one bitmap per resolution. Every
## size is derived from the shorter panel edge and, when the rows would not
## fit, the whole block shrinks — the screen never clips mid-row.

import std/[math, strutils, locks, tables]
import pixie
import pixie/fileformats/svg as pixie_svg
import frameos/utils/font as fontUtils

type
  StatusRow* = tuple[label: string, value: string]
  StatusScreen* = object
    status*: string        ## The line under the wordmark: what the frame is doing.
    rows*: seq[StatusRow]  ## Label / value facts, drawn in two columns.
    notes*: seq[string]    ## Free lines after the rows (scene list, hints).
    footer*: string        ## Bottom-right, small (version).
    dark*: bool            ## White on black (true) or black on white.

const
  frameosMarkSvg = staticRead("status_screen/frameos_mark.svg")
  markAspect = 464.0 / 544.0 # width / height of the mark's viewBox
  wordmark = "FrameOS"

var markLock: Lock
initLock(markLock)
# One rasterized mark per (height, colour). Tiny images — the tallest mark on
# a 4K panel is 160 px — so the table never matters for memory, and it saves
# re-parsing the SVG on every render of a scene that refreshes every minute.
var markCache: Table[string, Image] = initTable[string, Image]()

proc frameosMark*(height: int, color: Color): Image =
  ## The FrameOS mark rasterized to `height` pixels, filled with `color`.
  let h = max(height, 8)
  let w = max(int(round(h.float * markAspect)), 8)
  let key = $w & "x" & $h & "/" & color.toHtmlHex()
  withLock markLock:
    if markCache.hasKey(key):
      return markCache[key]
  let recolored = frameosMarkSvg.replace("fill=\"#ffffff\"", "fill=\"" & color.toHtmlHex() & "\"")
  let image = newImage(pixie_svg.parseSvg(recolored, w, h))
  withLock markLock:
    markCache[key] = image
  image

proc statusScreenText*(screen: StatusScreen): string =
  ## The same screen as plain text — for logs, the admin API and tests.
  var lines: seq[string] = @[wordmark]
  if screen.status.len > 0:
    lines.add(screen.status)
  lines.add("")
  for (label, value) in screen.rows:
    lines.add(label & ": " & value)
  if screen.notes.len > 0:
    lines.add("")
    for note in screen.notes:
      lines.add(note)
  if screen.footer.len > 0:
    lines.add("")
    lines.add(screen.footer)
  lines.join("\n")

proc makeFont(typeface: Typeface, size: float32, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint = newPaint(SolidPaint)
  result.paint.color = color

proc drawStatusScreen*(image: Image, screen: StatusScreen) =
  ## Paints `screen` over the whole of `image`.
  let width = image.width
  let height = image.height
  if width <= 0 or height <= 0:
    return
  let fg = if screen.dark: color(1, 1, 1, 1) else: color(0, 0, 0, 1)
  let bg = if screen.dark: color(0, 0, 0, 1) else: color(1, 1, 1, 1)
  # Labels step back on dark panels; on light (e-ink, often 1-bit) a grey
  # would just dither into noise, so everything stays black there.
  let muted = if screen.dark: color(0.66, 0.66, 0.66, 1) else: fg
  image.fill(bg)

  let typeface = fontUtils.getDefaultTypeface()
  let unit = min(width, height).float32
  let padding = max(16.0'f32, unit * 0.06)
  let innerWidth = width.float32 - 2 * padding
  let innerHeight = height.float32 - 2 * padding

  # Everything hangs off the mark's height; `shrink` pulls the whole block
  # down when a long scene list would run past the bottom.
  var markHeight = clamp(unit * 0.16, 32.0'f32, 160.0'f32)
  var shrink = 1.0'f32
  var rowFontSize, statusFontSize, headlineFontSize, noteFontSize, footerFontSize: float32
  var rowLineHeight, noteLineHeight, gap: float32
  var labelColumn: float32
  var labelFont, valueFont, noteFont: Font
  var valueArrangements: seq[Arrangement]
  var rowHeights: seq[float32]

  proc measure() =
    let mh = markHeight * shrink
    headlineFontSize = max(mh * 0.62, 12.0'f32)
    statusFontSize = max(mh * 0.30, 10.0'f32)
    rowFontSize = max(mh * 0.26, 9.0'f32)
    noteFontSize = rowFontSize
    footerFontSize = max(rowFontSize * 0.8, 8.0'f32)
    rowLineHeight = rowFontSize * 1.5
    noteLineHeight = noteFontSize * 1.4
    gap = rowFontSize * 1.2
    labelFont = makeFont(typeface, rowFontSize, muted)
    valueFont = makeFont(typeface, rowFontSize, fg)
    noteFont = makeFont(typeface, noteFontSize, fg)
    labelColumn = 0
    for (label, _) in screen.rows:
      labelColumn = max(labelColumn, labelFont.layoutBounds(label).x)
    if labelColumn > 0:
      labelColumn += rowFontSize * 1.2
    # A value wider than its column wraps (portrait panels, long cloud
    # hosts); the row grows with it instead of the next row painting over it.
    let valueWidth = max(innerWidth - labelColumn, 10.0'f32)
    valueArrangements = @[]
    rowHeights = @[]
    for (_, value) in screen.rows:
      let arrangement = valueFont.typeset(value, bounds = vec2(valueWidth, 0))
      valueArrangements.add(arrangement)
      rowHeights.add(max(rowLineHeight, arrangement.layoutBounds().y + rowFontSize * 0.5))

  proc totalHeight(): float32 =
    result = max(markHeight * shrink, headlineFontSize * 1.25 + statusFontSize * 1.5) + gap
    for rowHeight in rowHeights:
      result += rowHeight
    if screen.notes.len > 0:
      result += gap + screen.notes.len.float32 * noteLineHeight
    if screen.footer.len > 0:
      result += gap + footerFontSize * 1.4

  measure()
  var attempts = 0
  while totalHeight() > innerHeight and shrink > 0.3 and attempts < 12:
    shrink *= 0.85
    measure()
    inc attempts

  let mh = markHeight * shrink
  var y = padding

  # Header: mark, wordmark beside it, status line under the wordmark. The
  # status may wrap (a long cloud hint on a portrait panel); the rows start
  # below whichever is taller, the mark or the text block.
  let mark = frameosMark(int(round(mh)), fg)
  let headlineFont = makeFont(typeface, headlineFontSize, fg)
  let statusFont = makeFont(typeface, statusFontSize, muted)
  let textX = padding + mark.width.float32 + mh * 0.3
  let textWidth = max(innerWidth - mark.width.float32 - mh * 0.3, 10.0'f32)
  let headlineHeight = headlineFontSize * 1.25
  var statusHeight = 0.0'f32
  var statusArrangement: Arrangement
  if screen.status.len > 0:
    statusArrangement = statusFont.typeset(screen.status, bounds = vec2(textWidth, 0))
    statusHeight = max(statusArrangement.layoutBounds().y, statusFontSize * 1.3) + statusFontSize * 0.2
  let textBlockHeight = headlineHeight + statusHeight
  let headerHeight = max(mh, textBlockHeight)
  image.draw(mark, translate(vec2(padding, y + (headerHeight - mh) / 2)))
  let headerTextY = y + (headerHeight - textBlockHeight) / 2
  image.fillText(headlineFont.typeset(wordmark, bounds = vec2(textWidth, headlineHeight),
    vAlign = MiddleAlign), translate(vec2(textX, headerTextY)))
  if screen.status.len > 0:
    image.fillText(statusArrangement, translate(vec2(textX, headerTextY + headlineHeight)))
  y += headerHeight + gap

  # Rows and notes stop above the footer rather than running under it.
  let footerHeight = if screen.footer.len > 0: footerFontSize * 1.4 else: 0.0'f32
  let bottomLimit = height.float32 - padding - footerHeight

  # Rows: label column, value column. Label and the value's first line share
  # a baseline; a wrapped value continues below it.
  for idx, (label, _) in screen.rows:
    let rowHeight = rowHeights[idx]
    if y + rowHeight > bottomLimit:
      break
    image.fillText(labelFont.typeset(label, bounds = vec2(labelColumn, rowLineHeight),
      vAlign = MiddleAlign), translate(vec2(padding, y)))
    image.fillText(valueArrangements[idx], translate(vec2(padding + labelColumn, y + rowFontSize * 0.25)))
    y += rowHeight

  if screen.notes.len > 0:
    y += gap
    for note in screen.notes:
      if y + noteLineHeight > bottomLimit:
        break
      image.fillText(noteFont.typeset(note, bounds = vec2(innerWidth, noteLineHeight),
        vAlign = MiddleAlign), translate(vec2(padding, y)))
      y += noteLineHeight

  if screen.footer.len > 0:
    let footerFont = makeFont(typeface, footerFontSize, muted)
    image.fillText(footerFont.typeset(screen.footer, bounds = vec2(innerWidth, footerHeight),
      hAlign = RightAlign, vAlign = MiddleAlign),
      translate(vec2(padding, height.float32 - padding - footerHeight)))
