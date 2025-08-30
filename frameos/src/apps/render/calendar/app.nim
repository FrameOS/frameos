import pixie
import json, options, strformat, strutils, tables
import times, chrono

import frameos/apps
import frameos/types
import frameos/utils/font

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
  result = (h + 6) mod 7 # 0=Sunday

type
  AppConfig* = object
    inputImage*: Option[Image]
    events*: JsonNode
    year*: int
    month*: int
    startWeekOnMonday*: bool
    backgroundColor*: Color
    gridColor*: Color
    headerBackgroundColor*: Color
    headerTextColor*: Color
    dateTextColor*: Color
    eventTextColor*: Color
    headerFont*: string
    headerFontSize*: float
    dateFont*: string
    dateFontSize*: float
    eventFont*: string
    eventFontSize*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc groupEvents*(self: App): Table[string, seq[string]] =
  result = initTable[string, seq[string]]()
  let events = self.appConfig.events
  if events == nil or events.kind != JArray:
    return
  for ev in events.items():
    let summary = ev{"summary"}.getStr()
    let start = ev{"startTime"}.getStr()
    if start.len >= 10:
      let key = start[0..9]
      if not result.hasKey(key):
        result[key] = @[]
      result[key].add(summary)

proc render*(self: App, context: ExecutionContext, image: Image) =
  let nowTs = epochTime().Timestamp
  let defaultYear = parseInt(format(nowTs, "{year/4}"))
  let defaultMonth = parseInt(format(nowTs, "{month/2}"))
  let year = if self.appConfig.year == 0: defaultYear else: self.appConfig.year
  let month = if self.appConfig.month == 0: defaultMonth else: self.appConfig.month
  let startMonday = self.appConfig.startWeekOnMonday
  let days = daysInMonth(year, month)
  let firstWeekday = weekday(year, month, 1)
  let firstCol = if startMonday: (firstWeekday + 6) mod 7 else: firstWeekday
  let totalCells = firstCol + days
  let rows = (totalCells + 6) div 7
  let headerHeight = self.appConfig.headerFontSize.float32 * 1.8
  let gridHeight = image.height.float32 - headerHeight
  let cellWidth = image.width.float32 / 7.0
  let cellHeight = gridHeight / rows.float32

  image.fill(self.appConfig.backgroundColor)
  var headerImg = newImage(image.width, headerHeight.int)
  headerImg.fill(self.appConfig.headerBackgroundColor)
  image.draw(headerImg)

  let headerTypeface = getTypeface(self.appConfig.headerFont, self.frameConfig.assetsPath)
  let headerFont = newFont(headerTypeface, self.appConfig.headerFontSize, self.appConfig.headerTextColor)
  let dateTypeface = getTypeface(self.appConfig.dateFont, self.frameConfig.assetsPath)
  let dateFont = newFont(dateTypeface, self.appConfig.dateFontSize, self.appConfig.dateTextColor)
  let eventTypeface = getTypeface(self.appConfig.eventFont, self.frameConfig.assetsPath)
  let eventFont = newFont(eventTypeface, self.appConfig.eventFontSize, self.appConfig.eventTextColor)

  let weekdays = if startMonday:
    @["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  else:
    @["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

  for i, dayName in weekdays:
    let types = typeset(
      spans = [newSpan(dayName, headerFont)],
      bounds = vec2(cellWidth, headerHeight),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
    image.fillText(types, translate(vec2(i.float32 * cellWidth, 0f)))

  for i in 0..7:
    let x = i.float32 * cellWidth
    var vLine = newImage(1, gridHeight.int)
    vLine.fill(self.appConfig.gridColor)
    image.draw(vLine, translate(vec2(x, headerHeight)))
  for i in 0..rows:
    let y = headerHeight + i.float32 * cellHeight
    var hLine = newImage(image.width, 1)
    hLine.fill(self.appConfig.gridColor)
    image.draw(hLine, translate(vec2(0f, y)))

  let eventsByDay = self.groupEvents()
  var day = 1
  for row in 0..<rows:
    for col in 0..6:
      if row == 0 and col < firstCol:
        continue
      if day > days:
        break
      let x = col.float32 * cellWidth
      let y = headerHeight + row.float32 * cellHeight
      let dateText = $day
      let dateTypes = typeset(
        spans = [newSpan(dateText, dateFont)],
        bounds = vec2(cellWidth - 4f, self.appConfig.dateFontSize.float32 + 4f),
        hAlign = LeftAlign,
        vAlign = TopAlign,
      )
      image.fillText(dateTypes, translate(vec2(x + 2f, y + 2f)))

      let key = &"{year:04}-{month:02}-{day:02}"
      if eventsByDay.hasKey(key):
        let eventsText = eventsByDay[key].join("\n")
        let eventsTypes = typeset(
          spans = [newSpan(eventsText, eventFont)],
          bounds = vec2(cellWidth - 4f, cellHeight - self.appConfig.dateFontSize.float32 - 6f),
          hAlign = LeftAlign,
          vAlign = TopAlign,
        )
        image.fillText(eventsTypes, translate(vec2(x + 2f, y + self.appConfig.dateFontSize.float32 + 4f)))
      day += 1
    if day > days:
      break

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
