import pixie
import options
import strutils
import strformat
import math

import frameos/apps
import frameos/types
import frameos/utils/font

const
  dayOrder = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
  displayOrder = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

type
  AppConfig* = object
    data*: string
    startOfWeek*: string
    selectedIndexOffset*: int
    maxDisplayedWeeks*: int
    startDate*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc dayIndex(value: string): int =
  let lower = value.toLowerAscii()
  for i, name in dayOrder:
    if lower.startsWith(name):
      return i
  return 0

proc parseIsoDate(value: string; year, month, day: var int): bool =
  if value.len < 10:
    return false
  try:
    year = parseInt(value[0 .. 3])
    month = parseInt(value[5 .. 6])
    day = parseInt(value[8 .. 9])
    return true
  except CatchableError:
    return false

proc daysInMonth(year, month: int): int =
  case month
  of 1, 3, 5, 7, 8, 10, 12: 31
  of 4, 6, 9, 11: 30
  of 2:
    if (year mod 400 == 0) or ((year mod 4 == 0) and (year mod 100 != 0)):
      29
    else:
      28
  else:
    30

proc weekday(year, month, day: int): int =
  var m = month
  var y = year
  if m < 3:
    m += 12
    y -= 1
  let k = y mod 100
  let j = y div 100
  let h = (day + (13 * (m + 1)) div 5 + k + k div 4 + j div 4 + 5 * j) mod 7
  (h + 6) mod 7

proc incOneDay(year, month, day: var int) =
  day.inc
  if day > daysInMonth(year, month):
    day = 1
    month.inc
    if month > 12:
      month = 1
      year.inc

proc decOneDay(year, month, day: var int) =
  day.dec
  if day < 1:
    month.dec
    if month < 1:
      month = 12
      year.dec
    day = daysInMonth(year, month)

proc addDays(year, month, day, delta: int): tuple[year: int; month: int; day: int] =
  var y = year
  var m = month
  var d = day
  if delta >= 0:
    for _ in 0 ..< delta:
      incOneDay(y, m, d)
  else:
    for _ in 0 ..< (-delta):
      decOneDay(y, m, d)
  (year: y, month: m, day: d)

proc sanitizeData(data: string): string =
  result = newStringOfCap(data.len)
  for ch in data:
    if ch == 'x' or ch == 'X':
      result.add('x')
    elif ch == '.':
      result.add('.')

proc clampInt(value, low, high: int): int =
  if value < low:
    return low
  if value > high:
    return high
  value

proc renderGrid(self: App; context: ExecutionContext; image: Image) =
  let sanitized = sanitizeData(self.appConfig.data)
  let dataLen = sanitized.len
  let startWeekIdx = dayIndex(self.appConfig.startOfWeek)
  var initialOffset = 0
  var baseYear, baseMonth, baseDay: int
  var hasBaseDate = parseIsoDate(self.appConfig.startDate, baseYear, baseMonth, baseDay)
  if hasBaseDate:
    let entryWeekday = weekday(baseYear, baseMonth, baseDay)
    initialOffset = ((entryWeekday - startWeekIdx) + 7) mod 7
    for _ in 0 ..< initialOffset:
      decOneDay(baseYear, baseMonth, baseDay)
  else:
    let fallbackIdx = dayIndex(self.appConfig.startDate)
    initialOffset = ((fallbackIdx - startWeekIdx) + 7) mod 7
  let maxWeeksSetting = max(1, self.appConfig.maxDisplayedWeeks)

  var crosses = 0
  for ch in sanitized:
    if ch == 'x':
      inc crosses
  let misses = dataLen - crosses

  var firstWeek = 0
  var lastWeek = maxWeeksSetting - 1
  var selectedAbsolute = initialOffset

  if dataLen > 0:
    let lastAbsolute = initialOffset + dataLen - 1
    lastWeek = lastAbsolute div 7
    let firstDataWeek = initialOffset div 7
    firstWeek = max(firstDataWeek, lastWeek - maxWeeksSetting + 1)
    let clampedOffset = clampInt(self.appConfig.selectedIndexOffset, 0, dataLen - 1)
    selectedAbsolute = initialOffset + clampedOffset
  else:
    lastWeek = maxWeeksSetting - 1
    firstWeek = max(0, lastWeek - maxWeeksSetting + 1)

  let weekCount = if dataLen > 0: lastWeek - firstWeek + 1 else: maxWeeksSetting
  let weekCountClamped = max(1, weekCount)

  let width = image.width.float32
  let height = image.height.float32
  let padding = max(20'f32, min(width, height) * 0.06f)
  let availableWidth = max(16'f32, width - padding * 2)
  let availableHeight = max(16'f32, height - padding * 2)

  var headerHeight = max(28'f32, availableHeight * 0.18f)
  if headerHeight > availableHeight * 0.6f:
    headerHeight = availableHeight * 0.35f
  var statsHeight = min(48'f32, max(20'f32, availableHeight * 0.1f))
  var cellSize = min(availableWidth / 7'f32, (availableHeight - headerHeight - statsHeight) / weekCountClamped.float32)
  if cellSize < 10'f32:
    cellSize = min(availableWidth / 7'f32, (availableHeight - statsHeight) / (weekCountClamped.float32 + 0.5f))
    headerHeight = max(18'f32, availableHeight - statsHeight - cellSize * weekCountClamped.float32)
  headerHeight = max(18'f32, headerHeight)
  cellSize = max(8'f32, cellSize)

  let gridWidth = cellSize * 7'f32
  let totalHeight = headerHeight + cellSize * weekCountClamped.float32 + statsHeight
  let offsetX = max(padding, (width - gridWidth) / 2)
  let offsetY = max(padding, (height - totalHeight) / 2)

  image.fill(rgba(250, 252, 255, 255).to(Color))

  let typeface = getDefaultTypeface()
  let headerFont = newFont(typeface, min(headerHeight * 0.55f, 30'f32), rgb(60, 70, 96).to(Color))
  let markFont = newFont(typeface, min(cellSize * 0.65f, 42'f32), rgb(255, 255, 255).to(Color))
  let dotFont = newFont(typeface, min(cellSize * 0.45f, 30'f32), rgb(100, 108, 138).to(Color))
  let dotFontSelected = cloneFontWithColor(dotFont, rgb(40, 44, 70).to(Color))
  let dateFont = newFont(typeface, min(cellSize * 0.32f, 22'f32), rgb(94, 104, 138).to(Color))
  let dateFontMuted = cloneFontWithColor(dateFont, rgb(170, 178, 200).to(Color))
  let dateFontSelected = cloneFontWithColor(dateFont, rgb(40, 44, 70).to(Color))
  let statsFont =
    if statsHeight > 0'f32:
      some(newFont(typeface, min(statsHeight * 0.5f, 26'f32), rgb(62, 72, 100).to(Color)))
    else:
      none(Font)

  var headerBg = newImage(max(1, int(round(gridWidth))), max(1, headerHeight.int))
  headerBg.fill(rgba(236, 240, 252, 255).to(Color))
  image.draw(headerBg, translate(vec2(offsetX, offsetY)))

  for i in 0..6:
    let label = displayOrder[(startWeekIdx + i) mod 7]
    let layout = typeset(
      spans = [newSpan(label, headerFont)],
      bounds = vec2(cellSize, headerHeight),
      hAlign = CenterAlign,
      vAlign = MiddleAlign
    )
    image.fillText(layout, translate(vec2(offsetX + i.float32 * cellSize, offsetY)))

  let gridHeight = cellSize * weekCountClamped.float32
  let lineThickness = max(1, (cellSize * 0.08f).int)
  let gridColor = rgba(210, 216, 236, 255).to(Color)

  for i in 0..7:
    let x = offsetX + i.float32 * cellSize
    var vLine = newImage(lineThickness, max(1, gridHeight.int))
    vLine.fill(gridColor)
    image.draw(vLine, translate(vec2(x - lineThickness.float32 / 2, offsetY + headerHeight)))

  for i in 0..weekCountClamped:
    let y = offsetY + headerHeight + i.float32 * cellSize
    var hLine = newImage(max(1, gridWidth.int), lineThickness)
    hLine.fill(gridColor)
    image.draw(hLine, translate(vec2(offsetX, y - lineThickness.float32 / 2)))

  let emptyColor = rgba(245, 247, 255, 255).to(Color)
  let markColor = rgba(79, 120, 212, 255).to(Color)
  let neutralColor = rgba(248, 250, 255, 255).to(Color)
  let selectedBorder = rgba(40, 70, 160, 255).to(Color)
  let selectedOverlay = rgba(255, 255, 255, 60).to(Color)

  let highlightEnabled = dataLen > 0
  let maxIndex = dataLen - 1

  let statsText = &"Crosses: {crosses}   Misses: {misses}   Total: {dataLen}"

  for row in 0..<weekCountClamped:
    let weekIndex = firstWeek + row
    for col in 0..6:
      let absoluteIndex = weekIndex * 7 + col
      let cellX = offsetX + col.float32 * cellSize
      let cellY = offsetY + headerHeight + row.float32 * cellSize
      var cellImage = newImage(max(1, cellSize.int), max(1, cellSize.int))
      var baseColor = emptyColor
      var text = ""
      var useMarkFont = false
      let inTrackedRange = dataLen > 0 and absoluteIndex >= initialOffset and absoluteIndex < initialOffset + dataLen

      if inTrackedRange:
        let idx = absoluteIndex - initialOffset
        if idx >= 0 and idx <= maxIndex:
          if sanitized[idx] == 'x':
            baseColor = markColor
            text = "X"
            useMarkFont = true
          else:
            baseColor = neutralColor
            text = "·"
      cellImage.fill(baseColor)

      let selected = highlightEnabled and absoluteIndex == selectedAbsolute
      if selected:
        let stroke = max(2, (cellSize * 0.12f).int)
        var edge = newImage(cellImage.width, stroke)
        edge.fill(selectedBorder)
        cellImage.draw(edge, translate(vec2(0, 0)))
        cellImage.draw(edge, translate(vec2(0, cellSize - stroke.float32)))
        var edgeVert = newImage(stroke, cellImage.height)
        edgeVert.fill(selectedBorder)
        cellImage.draw(edgeVert, translate(vec2(0, 0)))
        cellImage.draw(edgeVert, translate(vec2(cellSize - stroke.float32, 0)))
        var overlay = newImage(cellImage.width, cellImage.height)
        overlay.fill(selectedOverlay)
        cellImage.draw(overlay, translate(vec2(0, 0)))

      if hasBaseDate:
        let current = addDays(baseYear, baseMonth, baseDay, absoluteIndex)
        let fontToUse =
          if selected:
            dateFontSelected
          elif inTrackedRange:
            dateFont
          else:
            dateFontMuted
        let label = $current.day
        let layout = typeset(
          spans = [newSpan(label, fontToUse)],
          bounds = vec2(cellSize, cellSize),
          hAlign = LeftAlign,
          vAlign = TopAlign
        )
        let paddingX = max(1'f32, cellSize * 0.12f)
        let paddingY = max(1'f32, cellSize * 0.08f)
        cellImage.fillText(layout, translate(vec2(paddingX, paddingY)))

      if text.len > 0:
        let font = if useMarkFont: markFont else: (if selected: dotFontSelected else: dotFont)
        let layout = typeset(
          spans = [newSpan(text, font)],
          bounds = vec2(cellSize, cellSize),
          hAlign = CenterAlign,
          vAlign = MiddleAlign
        )
        cellImage.fillText(layout)

      image.draw(cellImage, translate(vec2(cellX, cellY)))

  if statsHeight > 0'f32 and statsFont.isSome:
    var statsBg = newImage(max(1, gridWidth.int), max(1, statsHeight.int))
    statsBg.fill(rgba(236, 240, 252, 255).to(Color))
    image.draw(statsBg, translate(vec2(offsetX, offsetY + headerHeight + gridHeight)))
    let layout = typeset(
      spans = [newSpan(statsText, statsFont.get)],
      bounds = vec2(gridWidth, statsHeight),
      hAlign = CenterAlign,
      vAlign = MiddleAlign
    )
    image.fillText(layout, translate(vec2(offsetX, offsetY + headerHeight + gridHeight)))

proc run*(self: App; context: ExecutionContext) =
  renderGrid(self, context, context.image)

proc get*(self: App; context: ExecutionContext): Image =
  result = if context.hasImage:
    newImage(context.image.width, context.image.height)
  else:
    newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  renderGrid(self, context, result)
