import pixie
import options
import strutils
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
    startDay*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc dayIndex(value: string): int =
  let lower = value.toLowerAscii()
  for i, name in dayOrder:
    if lower.startsWith(name):
      return i
  return 0

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

proc renderGrid(self: App, context: ExecutionContext, image: Image) =
  let sanitized = sanitizeData(self.appConfig.data)
  let dataLen = sanitized.len
  let startWeekIdx = dayIndex(self.appConfig.startOfWeek)
  let startDayIdx = dayIndex(self.appConfig.startDay)
  let initialOffset = ((startDayIdx - startWeekIdx) + 7) mod 7
  let maxWeeksSetting = max(1, self.appConfig.maxDisplayedWeeks)

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
  var cellSize = min(availableWidth / 7'f32, (availableHeight - headerHeight) / weekCountClamped.float32)
  if cellSize < 10'f32:
    cellSize = min(availableWidth / 7'f32, availableHeight / (weekCountClamped.float32 + 0.5f))
    headerHeight = max(18'f32, availableHeight - cellSize * weekCountClamped.float32)
  headerHeight = max(18'f32, headerHeight)
  cellSize = max(8'f32, cellSize)

  let gridWidth = cellSize * 7'f32
  let totalHeight = headerHeight + cellSize * weekCountClamped.float32
  let offsetX = max(padding, (width - gridWidth) / 2)
  let offsetY = max(padding, (height - totalHeight) / 2)

  image.fill(rgba(250, 252, 255, 255).to(Color))

  let typeface = getDefaultTypeface()
  let headerFont = newFont(typeface, min(headerHeight * 0.55f, 30'f32), rgb(60, 70, 96).to(Color))
  let markFont = newFont(typeface, min(cellSize * 0.65f, 42'f32), rgb(255, 255, 255).to(Color))
  let dotFont = newFont(typeface, min(cellSize * 0.45f, 30'f32), rgb(100, 108, 138).to(Color))
  let dotFontSelected = cloneFontWithColor(dotFont, rgb(40, 44, 70).to(Color))

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

      if dataLen > 0 and absoluteIndex >= initialOffset and absoluteIndex < initialOffset + dataLen:
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

proc run*(self: App, context: ExecutionContext) =
  renderGrid(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  result = if context.hasImage:
    newImage(context.image.width, context.image.height)
  else:
    newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  renderGrid(self, context, result)
