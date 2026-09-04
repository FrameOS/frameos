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
##
##   Last button: Next (GPIO 5) 14:32:05  v2026.8.33 ← `bar` (left) + `footer`
##
## The bottom band holds `bar` on the left and `footer` on the right; on dark
## panels it is a grey strip, on light ones just the text. `markPhase` ≥ 0
## cycles the brand colours through the mark's three squares — the "alive"
## signal an HDMI frame shows while booting and while it has no scenes.
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
  StatusAside* = object
    ## Something to read off the panel and type or scan elsewhere — the
    ## FrameOS Cloud link code. On a landscape panel it takes a column on
    ## the right, beside the rows; on a portrait one it follows the notes.
    title*: string         ## "Connect to FrameOS Cloud"
    code*: string          ## The code itself, drawn large.
    hint*: string          ## Where to enter it, small.
    qr*: Image             ## Optional QR of the same, drawn at its own pixel size or smaller.
  StatusScreen* = object
    status*: string        ## The line under the wordmark: what the frame is doing.
    rows*: seq[StatusRow]  ## Label / value facts, drawn in two columns.
    notes*: seq[string]    ## Free lines after the rows (scene list, hints).
    footer*: string        ## Bottom-right, small (version).
    bar*: string           ## Bottom-left, in the same band as the footer (last button press).
    dark*: bool            ## White on black (true) or black on white.
    markPhase*: float      ## 0 (the default): static brand colours; 0..1: animation phase (markSquareColorsAt).
    aside*: StatusAside    ## A code + QR beside the rows; empty when there is none.

proc hasAside*(screen: StatusScreen): bool =
  screen.aside.code.len > 0 or screen.aside.qr != nil

const
  frameosMarkSvg = staticRead("status_screen/frameos_mark.svg")
  markAspect = 464.0 / 544.0 # width / height of the mark's viewBox
  wordmark = "FrameOS"
  # The three squares' fills in frameos_mark.svg (same as logo-white-colors.svg).
  markSquareColors = ["#1c7c66", "#8baa3a", "#c8a247"]
  # Animation frames per colour cycle. The phase is quantized to this many
  # steps so the rasterized-mark cache below stays bounded (one entry per
  # step per size) instead of growing with every distinct timestamp.
  markPhaseSteps* = 36

proc markSquareColorsAt*(phase: float): array[3, string] =
  ## The three squares' colours at animation `phase` (0..1, wrapping): the
  ## brand colours walk one square along per third of the cycle, blending
  ## between neighbours on the way, so the colours flow diagonally through
  ## the mark and every full cycle lands back on the static logo. Phase 0
  ## (and any negative phase) is the static logo itself.
  if phase <= 0:
    return markSquareColors
  let p = phase - floor(phase)
  let quantized = floor(p * markPhaseSteps.float) / markPhaseSteps.float
  let travel = quantized * 3.0
  let step = int(floor(travel)) mod 3
  let blend = (travel - floor(travel)).float32
  for i in 0 ..< 3:
    let fromColor = parseHtmlColor(markSquareColors[(i + step) mod 3])
    let toColor = parseHtmlColor(markSquareColors[(i + step + 1) mod 3])
    result[i] = mix(fromColor, toColor, blend).toHtmlHex().toLowerAscii()

var markLock: Lock
initLock(markLock)
# One rasterized mark per (height, colour). Tiny images — the tallest mark on
# a 4K panel is 160 px — so the table never matters for memory, and it saves
# re-parsing the SVG on every render of a scene that refreshes every minute.
var markCache: Table[string, Image] = initTable[string, Image]()

proc frameosMark*(height: int, color: Color, coloredSquares = true, phase = -1.0): Image =
  ## The FrameOS mark rasterized to `height` pixels: the frame filled with
  ## `color`, the three squares in the brand colours — or, with
  ## `coloredSquares = false` (1-bit e-ink, where colour would dither into
  ## noise), also in `color`. `phase` ≥ 0 picks the animation frame
  ## (markSquareColorsAt); the raster is cached per (size, colour, frame).
  let h = max(height, 8)
  let w = max(int(round(h.float * markAspect)), 8)
  let squares = if coloredSquares: markSquareColorsAt(phase) else: markSquareColors
  let key = $w & "x" & $h & "/" & color.toHtmlHex() &
    (if coloredSquares: "/c" & squares.join(",") else: "/m")
  withLock markLock:
    if markCache.hasKey(key):
      return markCache[key]
  var svg = frameosMarkSvg.replace("fill=\"#ffffff\"", "fill=\"" & color.toHtmlHex() & "\"")
  if not coloredSquares:
    for brand in markSquareColors:
      svg = svg.replace("fill=\"" & brand & "\"", "fill=\"" & color.toHtmlHex() & "\"")
  elif phase > 0:
    # Each square's fill is a distinct string, so an ordered replace recolours
    # them one by one without touching the frame.
    for i, brand in markSquareColors:
      svg = svg.replace("fill=\"" & brand & "\"", "fill=\"" & squares[i] & "\"")
  let image = newImage(pixie_svg.parseSvg(svg, w, h))
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
  if screen.hasAside():
    lines.add("")
    if screen.aside.title.len > 0:
      lines.add(screen.aside.title)
    if screen.aside.code.len > 0:
      lines.add(screen.aside.code)
    if screen.aside.hint.len > 0:
      lines.add(screen.aside.hint)
  if screen.bar.len > 0 or screen.footer.len > 0:
    lines.add("")
  if screen.bar.len > 0:
    lines.add(screen.bar)
  if screen.footer.len > 0:
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
  let band = color(0.14, 0.14, 0.14, 1)
  image.fill(bg)

  let typeface = fontUtils.getDefaultTypeface()
  let unit = min(width, height).float32
  let padding = max(16.0'f32, unit * 0.06)
  let innerWidth = width.float32 - 2 * padding
  let innerHeight = height.float32 - 2 * padding
  # The aside takes a right-hand column on a landscape panel; a portrait
  # panel has no width to spare, so there it follows the notes instead.
  let asideColumn = screen.hasAside() and width.float32 >= height.float32 * 1.15
  let asideWidth = if asideColumn: max(innerWidth * 0.32, 96.0'f32) else: 0.0'f32
  let contentWidth = if asideColumn: innerWidth - asideWidth - padding else: innerWidth

  # Everything hangs off the mark's height; `shrink` pulls the whole block
  # down when a long scene list would run past the bottom.
  var markHeight = clamp(unit * 0.16, 32.0'f32, 400.0'f32)
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
    let valueWidth = max(contentWidth - labelColumn, 10.0'f32)
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
    if screen.hasAside() and not asideColumn:
      # Title, code and hint as lines, plus a QR no wider than a third of the panel.
      result += gap + statusFontSize * 1.5 + headlineFontSize * 1.3 + footerFontSize * 1.4
      if screen.aside.qr != nil:
        result += gap * 0.5 + min(screen.aside.qr.width.float32, innerWidth * 0.34)
    if screen.footer.len > 0 or screen.bar.len > 0:
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
  let mark = frameosMark(int(round(mh)), fg, coloredSquares = screen.dark, phase = screen.markPhase)
  let headlineFont = makeFont(typeface, headlineFontSize, fg)
  let statusFont = makeFont(typeface, statusFontSize, muted)
  let textX = padding + mark.width.float32 + mh * 0.3
  let textWidth = max(contentWidth - mark.width.float32 - mh * 0.3, 10.0'f32)
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
  let contentTop = y

  # Rows and notes stop above the bottom band rather than running under it.
  let hasBand = screen.footer.len > 0 or screen.bar.len > 0
  let footerHeight = if hasBand: footerFontSize * 1.4 else: 0.0'f32
  # On dark panels the band is a grey strip flush with the bottom edge, tall
  # enough to breathe; on light panels the same text sits inside the padding.
  let bandHeight = if hasBand and screen.dark: footerHeight * 1.7 else: footerHeight
  let bandTop = if screen.dark: height.float32 - bandHeight else: height.float32 - padding - footerHeight
  let bottomLimit = if screen.dark and hasBand: bandTop - gap * 0.5 else: height.float32 - padding - footerHeight

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
      image.fillText(noteFont.typeset(note, bounds = vec2(contentWidth, noteLineHeight),
        vAlign = MiddleAlign), translate(vec2(padding, y)))
      y += noteLineHeight
  if screen.hasAside():
    # Title (muted), the code large, the QR, the hint small — top-aligned
    # with the rows in its column, or under the notes when there is no column.
    let asideX = if asideColumn: width.float32 - padding - asideWidth else: padding
    let asideW = if asideColumn: asideWidth else: innerWidth
    var ay = if asideColumn: contentTop else: y + gap
    let titleFont = makeFont(typeface, statusFontSize, muted)
    let codeFont = makeFont(typeface, headlineFontSize, fg)
    let hintFont = makeFont(typeface, footerFontSize, muted)
    # Title and hint wrap on a narrow column ("Connect to FrameOS / Cloud");
    # measure them so nothing lands on the line below.
    var titleArrangement, hintArrangement: Arrangement
    var titleHeight, hintHeight = 0.0'f32
    if screen.aside.title.len > 0:
      titleArrangement = titleFont.typeset(screen.aside.title, bounds = vec2(asideW, 0))
      titleHeight = max(titleArrangement.layoutBounds().y, statusFontSize * 1.3) + statusFontSize * 0.2
    if screen.aside.hint.len > 0:
      hintArrangement = hintFont.typeset(screen.aside.hint, bounds = vec2(asideW, 0))
      hintHeight = max(hintArrangement.layoutBounds().y, footerFontSize * 1.2) + footerFontSize * 0.2
    if titleHeight > 0 and ay + titleHeight <= bottomLimit:
      image.fillText(titleArrangement, translate(vec2(asideX, ay)))
      ay += titleHeight
    if screen.aside.code.len > 0 and ay + headlineFontSize * 1.3 <= bottomLimit:
      image.fillText(codeFont.typeset(screen.aside.code, bounds = vec2(asideW, headlineFontSize * 1.3),
        vAlign = MiddleAlign), translate(vec2(asideX, ay)))
      ay += headlineFontSize * 1.3
    if screen.aside.qr != nil:
      # The QR takes what is left above the hint. On a small panel the two
      # compete; a code you can scan beats a line telling you where to type
      # it, so the hint goes first when the QR would end up under ~100 px.
      let qrMax = if asideColumn: asideW else: innerWidth * 0.34
      var room = bottomLimit - ay - gap * 0.5 - hintHeight - (if hintHeight > 0: gap * 0.25 else: 0.0'f32)
      if hintHeight > 0 and min(screen.aside.qr.width.float32, qrMax) > room and room < 100:
        hintHeight = 0
        room = bottomLimit - ay - gap * 0.5
      let qrSize = min(min(screen.aside.qr.width.float32, qrMax), room)
      if qrSize >= 24:
        ay += gap * 0.5
        let qr = if int(qrSize) == screen.aside.qr.width: screen.aside.qr
                 else: screen.aside.qr.resize(int(qrSize), int(qrSize))
        image.draw(qr, translate(vec2(asideX, ay)))
        ay += qrSize + gap * 0.25
    if hintHeight > 0 and ay + hintHeight <= bottomLimit + 1:
      image.fillText(hintArrangement, translate(vec2(asideX, ay)))
  if hasBand:
    if screen.dark:
      var bandPath = newPath()
      bandPath.rect(0, bandTop, width.float32, bandHeight)
      image.fillPath(bandPath, band)
    let footerFont = makeFont(typeface, footerFontSize, muted)
    var footerWidth = 0.0'f32
    if screen.footer.len > 0:
      footerWidth = footerFont.layoutBounds(screen.footer).x
      image.fillText(footerFont.typeset(screen.footer, bounds = vec2(innerWidth, bandHeight),
        hAlign = RightAlign, vAlign = MiddleAlign), translate(vec2(padding, bandTop)))
    if screen.bar.len > 0:
      # The bar text is a fact (which button, when), so it reads in the
      # foreground colour; the version stays muted. One line, clipped by
      # the space left of the footer.
      let barFont = makeFont(typeface, footerFontSize, fg)
      let barWidth = max(innerWidth - footerWidth - footerFontSize, 10.0'f32)
      image.fillText(barFont.typeset(screen.bar, bounds = vec2(barWidth, bandHeight),
        vAlign = MiddleAlign), translate(vec2(padding, bandTop)))
