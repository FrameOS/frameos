import json
import math
import options
import strformat
import strutils
import pixie
import chroma
import frameos/apps
import frameos/types
import frameos/utils/font
import frameos/utils/image

const seriesPalette* = [
  "#2a78d6", "#1baf7a", "#eda100", "#008300",
  "#4a3aa7", "#e34948", "#e87ba4", "#eb6834",
]

type
  ChartSeries* = object
    name*: string
    color*: string
    values*: seq[float]

  ChartData* = object
    series*: seq[ChartSeries]
    labels*: seq[string]

  AppConfig* = object
    inputImage*: Option[Image]
    data*: JsonNode
    chartType*: string
    title*: string
    color*: Color
    transparentBackground*: bool
    backgroundColor*: Color
    axisColor*: Color
    showGrid*: bool
    showLabels*: bool
    minY*: string
    maxY*: string
    lineWidth*: float
    fontSize*: float
    padding*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc isFiniteValue*(v: float): bool {.inline.} =
  v == v and v != Inf and v != NegInf

proc formatValue*(v: float): string =
  if not isFiniteValue(v):
    return ""
  if abs(v - round(v)) < 1e-9 and abs(v) < 1e12:
    return $round(v).int
  result = formatFloat(v, ffDecimal, 2)
  result.trimZeros()

proc toChartValue*(node: JsonNode): float =
  if node.isNil:
    return NaN
  case node.kind
  of JInt: node.getInt().float
  of JFloat: node.getFloat()
  of JBool: (if node.getBool(): 1.0 else: 0.0)
  of JString:
    try:
      parseFloat(node.getStr().strip())
    except ValueError:
      NaN
  else: NaN

proc parseValues(node: JsonNode): seq[float] =
  result = @[]
  if node.isNil or node.kind != JArray:
    return
  for item in node.items:
    result.add(toChartValue(item))

proc parseLabels(node: JsonNode): seq[string] =
  result = @[]
  if node.isNil or node.kind != JArray:
    return
  for item in node.items:
    case item.kind
    of JString: result.add(item.getStr())
    of JInt: result.add($item.getInt())
    of JFloat: result.add(formatValue(item.getFloat()))
    else: result.add("")

proc parseSeriesEntry(node: JsonNode): ChartSeries =
  result = ChartSeries()
  if node.isNil:
    return
  case node.kind
  of JArray:
    result.values = parseValues(node)
  of JObject:
    result.name = node{"name"}.getStr(node{"label"}.getStr(""))
    result.color = node{"color"}.getStr("")
    if node.hasKey("values"):
      result.values = parseValues(node{"values"})
    elif node.hasKey("data"):
      result.values = parseValues(node{"data"})
  else:
    result.values = @[toChartValue(node)]

proc parseChartData*(node: JsonNode): ChartData =
  result = ChartData()
  if node.isNil:
    return
  # State fields and control forms often deliver json values as strings
  if node.kind == JString:
    let text = node.getStr().strip()
    if text.len == 0:
      return
    try:
      return parseChartData(parseJson(text))
    except CatchableError:
      return
  case node.kind
  of JArray:
    if node.len == 0:
      return
    var values: seq[float] = @[]
    var labels: seq[string] = @[]
    var hasLabels = false
    for item in node.items:
      if item.kind == JObject:
        let label = item{"label"}.getStr(item{"name"}.getStr(""))
        if label.len > 0:
          hasLabels = true
        labels.add(label)
        if item.hasKey("value"):
          values.add(toChartValue(item{"value"}))
        elif item.hasKey("y"):
          values.add(toChartValue(item{"y"}))
        else:
          values.add(NaN)
      else:
        labels.add("")
        values.add(toChartValue(item))
    result.series = @[ChartSeries(values: values)]
    if hasLabels:
      result.labels = labels
  of JObject:
    result.labels = parseLabels(node{"labels"})
    let seriesNode = node{"series"}
    if not seriesNode.isNil and seriesNode.kind == JArray:
      for item in seriesNode.items:
        let entry = parseSeriesEntry(item)
        if entry.values.len > 0:
          result.series.add(entry)
    elif node.hasKey("values"):
      let entry = parseSeriesEntry(node)
      if entry.values.len > 0:
        result.series.add(entry)
  else:
    discard

proc maxPoints*(data: ChartData): int =
  for series in data.series:
    if series.values.len > result:
      result = series.values.len

proc hasFiniteValues*(data: ChartData): bool =
  for series in data.series:
    for v in series.values:
      if isFiniteValue(v):
        return true

proc computeYRange*(data: ChartData, minYStr, maxYStr: string, includeZero: bool): tuple[lo, hi: float] =
  var lo = Inf
  var hi = NegInf
  for series in data.series:
    for v in series.values:
      if isFiniteValue(v):
        if v < lo: lo = v
        if v > hi: hi = v
  if lo > hi:
    lo = 0.0
    hi = 1.0
  if includeZero:
    lo = min(lo, 0.0)
    hi = max(hi, 0.0)
  if minYStr.strip().len > 0:
    try:
      let parsed = parseFloat(minYStr.strip())
      if isFiniteValue(parsed):
        lo = parsed
    except ValueError:
      discard
  if maxYStr.strip().len > 0:
    try:
      let parsed = parseFloat(maxYStr.strip())
      if isFiniteValue(parsed):
        hi = parsed
    except ValueError:
      discard
  if lo > hi:
    swap(lo, hi)
  if hi - lo < 1e-9:
    let pad = max(abs(lo) * 0.1, 1.0)
    lo -= pad
    hi += pad
  (lo, hi)

proc valueToY*(v, lo, hi, plotY, plotH: float): float =
  if hi <= lo:
    return plotY + plotH
  plotY + plotH - (v - lo) / (hi - lo) * plotH

proc pointX*(index, count: int, plotX, plotW: float, chartType: string): float =
  if count <= 0:
    return plotX + plotW / 2.0
  if chartType == "bar":
    plotX + (index.float + 0.5) * plotW / count.float
  elif count == 1:
    plotX + plotW / 2.0
  else:
    plotX + plotW * index.float / (count - 1).float

proc barSlot*(groupIndex, groupCount, seriesIndex, seriesCount: int, plotW: float): tuple[x, w: float] =
  if groupCount <= 0 or seriesCount <= 0:
    return (0.0, 0.0)
  let groupW = plotW / groupCount.float
  let innerW = groupW * 0.8
  let gap = min(2.0, innerW / (seriesCount.float * 4.0))
  let barW = max(1.0, (innerW - gap * (seriesCount - 1).float) / seriesCount.float)
  let x0 = groupIndex.float * groupW + (groupW - innerW) / 2.0
  (x0 + seriesIndex.float * (barW + gap), barW)

proc labelStep*(count: int, plotW, labelWidth: float): int =
  if count <= 1 or labelWidth <= 0 or plotW <= 0:
    return 1
  max(1, ceil(count.float * labelWidth / plotW).int)

proc seriesColor*(baseColor: Color, series: ChartSeries, index: int): Color =
  if series.color.len > 0:
    try:
      return parseHtmlColor(series.color)
    except CatchableError:
      discard
  if index == 0:
    return baseColor
  parseHtmlColor(seriesPalette[index mod seriesPalette.len])

proc init*(self: App) =
  if self.appConfig.chartType notin ["line", "bar", "area"]:
    self.appConfig.chartType = "line"
  if self.appConfig.fontSize <= 0:
    self.appConfig.fontSize = 16.0
  if self.appConfig.lineWidth <= 0:
    self.appConfig.lineWidth = 2.0
  if self.appConfig.padding < 0:
    self.appConfig.padding = 0.0
  self.appConfig.minY = self.appConfig.minY.strip()
  self.appConfig.maxY = self.appConfig.maxY.strip()

proc canvasIsDark(image: Image): bool =
  ## Sample a few canvas pixels to tell dark backgrounds from light ones
  if image.isNil or image.width <= 0 or image.height <= 0:
    return false
  var luminance = 0.0
  var samples = 0
  for (fx, fy) in [(0.5, 0.5), (0.2, 0.2), (0.8, 0.2), (0.2, 0.8), (0.8, 0.8)]:
    let px = image.unsafe[int(fx * float(image.width - 1)), int(fy * float(image.height - 1))]
    luminance += 0.21 * px.r.float + 0.72 * px.g.float + 0.07 * px.b.float
    inc samples
  luminance / samples.float < 100.0

proc inkColor(self: App, image: Image): Color =
  if self.appConfig.axisColor.a > 0:
    self.appConfig.axisColor
  elif canvasIsDark(image):
    color(0.9, 0.9, 0.9, 1)
  else:
    color(0, 0, 0, 1)

proc drawTextBox(self: App, image: Image, text: string, font: Font,
    x, y, w, h: float, hAlign: HorizontalAlignment, vAlign: VerticalAlignment) =
  let types = typeset(
    spans = [newSpan(text, font)],
    bounds = vec2(w.float32, h.float32),
    hAlign = hAlign,
    vAlign = vAlign,
  )
  image.fillText(types, translate(vec2(x.float32, y.float32)))

proc drawMessage(self: App, image: Image, message: string) =
  let size = clamp(min(image.width, image.height).float / 8.0, 8.0, 32.0)
  let font = newFont(getDefaultTypeface(), size, self.inkColor(image))
  self.drawTextBox(image, message, font, 0.0, 0.0, image.width.float, image.height.float,
      CenterAlign, MiddleAlign)

proc drawLineSeries(self: App, image: Image, values: seq[float], count: int,
    plotX, plotY, plotW, plotH, lo, hi: float, col: Color, lineWidth: float,
    fillArea: bool, baselineY: float) =
  var i = 0
  while i < values.len:
    if not isFiniteValue(values[i]):
      inc i
      continue
    var runEnd = i
    while runEnd + 1 < values.len and isFiniteValue(values[runEnd + 1]):
      inc runEnd
    if runEnd == i:
      let x = pointX(i, count, plotX, plotW, "line")
      let y = valueToY(values[i], lo, hi, plotY, plotH)
      let dot = newPath()
      dot.circle(x.float32, y.float32, max(lineWidth, 2.0).float32)
      image.fillPath(dot, col)
    else:
      if fillArea:
        let fill = newPath()
        fill.moveTo(pointX(i, count, plotX, plotW, "line").float32, baselineY.float32)
        for j in i .. runEnd:
          fill.lineTo(pointX(j, count, plotX, plotW, "line").float32,
              valueToY(values[j], lo, hi, plotY, plotH).float32)
        fill.lineTo(pointX(runEnd, count, plotX, plotW, "line").float32, baselineY.float32)
        fill.closePath()
        image.fillPath(fill, color(col.r, col.g, col.b, col.a * 0.35))
      let stroke = newPath()
      stroke.moveTo(pointX(i, count, plotX, plotW, "line").float32,
          valueToY(values[i], lo, hi, plotY, plotH).float32)
      for j in (i + 1) .. runEnd:
        stroke.lineTo(pointX(j, count, plotX, plotW, "line").float32,
            valueToY(values[j], lo, hi, plotY, plotH).float32)
      image.strokePath(stroke, col, strokeWidth = lineWidth.float32,
          lineCap = RoundCap, lineJoin = RoundJoin)
    i = runEnd + 1

proc render*(self: App, context: ExecutionContext, image: Image) =
  try:
    if not self.appConfig.transparentBackground and self.appConfig.backgroundColor.a > 0:
      image.fill(self.appConfig.backgroundColor)

    let data = parseChartData(self.appConfig.data)
    if data.series.len == 0 or not hasFiniteValues(data):
      self.drawMessage(image, "No chart data")
      return

    let chartType = if self.appConfig.chartType in ["line", "bar", "area"]: self.appConfig.chartType else: "line"
    let fontSize = max(self.appConfig.fontSize, 1.0)
    let padding = max(self.appConfig.padding, 0.0)
    let lineWidth = max(self.appConfig.lineWidth, 0.5)
    let ink = self.inkColor(image)
    let typeface = getDefaultTypeface()

    let includeZero = chartType in ["bar", "area"]
    let (lo, hi) = computeYRange(data, self.appConfig.minY, self.appConfig.maxY, includeZero)
    let points = maxPoints(data)

    var plotX = padding
    var plotY = padding
    let plotRight = image.width.float - padding
    var plotBottom = image.height.float - padding

    if self.appConfig.title.len > 0:
      let titleFont = newFont(typeface, fontSize * 1.25, ink)
      let titleHeight = fontSize * 1.75
      self.drawTextBox(image, self.appConfig.title, titleFont, plotX, plotY,
          max(plotRight - plotX, 1.0), titleHeight, CenterAlign, MiddleAlign)
      plotY += titleHeight

    let showLabels = self.appConfig.showLabels
    let labelFont = newFont(typeface, fontSize, ink)
    let loText = formatValue(lo)
    let hiText = formatValue(hi)
    var gutter = 0.0
    if showLabels:
      gutter = max(loText.len, hiText.len).float * fontSize * 0.6 + 6.0
      plotX += gutter
      if data.labels.len > 0:
        plotBottom -= fontSize * 1.5

    let plotW = plotRight - plotX
    let plotH = plotBottom - plotY
    if plotW < 8.0 or plotH < 8.0:
      self.drawMessage(image, "Not enough space")
      return

    if self.appConfig.showGrid:
      let gridColor = color(ink.r, ink.g, ink.b, ink.a * 0.25)
      for i in 0 .. 4:
        let y = plotY + plotH * i.float / 4.0
        let line = newPath()
        line.rect(plotX.float32, y.float32, plotW.float32, 1)
        image.fillPath(line, gridColor)

    let baselineValue = clamp(0.0, lo, hi)
    let baselineY = valueToY(baselineValue, lo, hi, plotY, plotH)

    for si, series in data.series:
      let col = seriesColor(self.appConfig.color, series, si)
      if chartType == "bar":
        let bars = newPath()
        if points > plotW.int:
          # More bars than pixels: bucket to one 1px column per pixel so the
          # path stays O(plot width) instead of O(points)
          let columns = max(plotW.int, 1)
          var topByCol = newSeq[float](columns)
          var bottomByCol = newSeq[float](columns)
          for c in 0 ..< columns:
            topByCol[c] = Inf
            bottomByCol[c] = NegInf
          for i in 0 ..< min(points, series.values.len):
            let v = series.values[i]
            if not isFiniteValue(v):
              continue
            let c = clamp(int(i.float * columns.float / points.float), 0, columns - 1)
            let y = valueToY(v, lo, hi, plotY, plotH)
            topByCol[c] = min(topByCol[c], min(y, baselineY))
            bottomByCol[c] = max(bottomByCol[c], max(y, baselineY))
          for c in 0 ..< columns:
            if topByCol[c] <= bottomByCol[c]:
              bars.rect((plotX + c.float).float32, topByCol[c].float32, 1,
                  max(bottomByCol[c] - topByCol[c], 1.0).float32)
        else:
          for i in 0 ..< min(points, series.values.len):
            let v = series.values[i]
            if not isFiniteValue(v):
              continue
            let (slotX, slotW) = barSlot(i, points, si, data.series.len, plotW)
            let y = valueToY(v, lo, hi, plotY, plotH)
            let top = min(y, baselineY)
            let barH = max(abs(baselineY - y), 1.0)
            bars.rect((plotX + slotX).float32, top.float32, slotW.float32, barH.float32)
        image.fillPath(bars, col)
      else:
        self.drawLineSeries(image, series.values, points, plotX, plotY, plotW, plotH,
            lo, hi, col, lineWidth, chartType == "area", baselineY)

    block drawAxes:
      let yAxis = newPath()
      yAxis.rect(plotX.float32, plotY.float32, 1, plotH.float32)
      image.fillPath(yAxis, ink)
      let xAxis = newPath()
      xAxis.rect(plotX.float32, (plotBottom - 1.0).float32, plotW.float32, 1)
      image.fillPath(xAxis, ink)

    if showLabels:
      let labelH = fontSize * 1.3
      self.drawTextBox(image, hiText, labelFont, plotX - gutter,
          max(plotY - labelH / 2.0, 0.0), max(gutter - 4.0, 1.0), labelH, RightAlign, MiddleAlign)
      self.drawTextBox(image, loText, labelFont, plotX - gutter,
          min(plotBottom - labelH / 2.0, image.height.float - labelH), max(gutter - 4.0, 1.0),
          labelH, RightAlign, MiddleAlign)

      if data.labels.len > 0:
        var maxLen = 0
        for label in data.labels:
          if label.len > maxLen:
            maxLen = label.len
        let labelWidth = maxLen.float * fontSize * 0.6 + 8.0
        let step = labelStep(points, plotW, labelWidth)
        let boxW = max(labelWidth, plotW / max(points, 1).float)
        var i = 0
        while i < points:
          if i < data.labels.len and data.labels[i].len > 0:
            let x = pointX(i, points, plotX, plotW, chartType)
            let boxX = max(0.0, min(x - boxW / 2.0, image.width.float - boxW))
            self.drawTextBox(image, data.labels[i], labelFont, boxX,
                plotBottom + 2.0, boxW, fontSize * 1.4, CenterAlign, TopAlign)
          i += step
  except Exception as e:
    let message = &"Error rendering chart: {e.msg}"
    self.logError(message)
    renderErrorInto(image, image.width, image.height, message)

proc run*(self: App, context: ExecutionContext) =
  render(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  result = if self.appConfig.inputImage.isSome:
    self.appConfig.inputImage.get()
  elif context.hasImage:
    newImage(context.image.width, context.image.height)
  else:
    newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  render(self, context, result)
