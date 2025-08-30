import pixie
import json, options, strformat, strutils, tables
import times, chrono
import math

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

    # colors / fonts
    backgroundColor*: Color
    weekendBackgroundColor*: Color # NEW: background color for Saturday/Sunday day cells
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
    eventBoldFont*: string
    eventFontSize*: float

    # layout / decoration
    padding*: int                  # outer padding (px)
    borderColor*: Color            # border color around the calendar
    borderWidth*: float            # border width (px)
    showMonthYear*: bool           # show month + year
    monthYearPosition*: string     # "top", "bottom", or "none"
    showGrid*: bool                # toggle grid on/off
    gridWidth*: float              # grid stroke width (px)
    todayStrokeColor*: Color       # outline color for today's cell
                                   # (fill is intentionally omitted to avoid covering text)
    showEventTimes*: bool          # show times next to non all-day events

  App* = ref object of AppRoot
    appConfig*: AppConfig

# quick-and-simple width-based truncation so each line stays on one row
proc truncateToWidth(text: string, fontSize, maxWidth: float32): string =
  # Average glyph width heuristic ~55% of font size
  let avgChar = max(1.0'f32, fontSize * 0.55)
  var maxChars = int(maxWidth / avgChar)
  if maxChars < 1: maxChars = 1
  if text.len <= maxChars: return text
  if maxChars <= 1: return "…"
  result = text[0 .. max(0, maxChars - 2)] & "…"

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

      # Build display text, optionally prefixing time(s).
      # Default: show ONLY the start time; ensure a space before the title.
      var display = summary
      let isAllDay = ev{"allDay"}.getBool(false)
      if self.appConfig.showEventTimes and not isAllDay:
        var timeStr = ""
        if start.len >= 16:
          timeStr = start[11..15] # HH:MM from ISO string
        if timeStr.len > 0:
          display = timeStr & " " & summary # <-- add a space between time and event name

      result[key].add(display)

proc render*(self: App, context: ExecutionContext, image: Image) =
  # Current date/time (use LOCAL time zone; FrameOS sets TZ to the user's zone, e.g., Europe/Brussels)
  let nowLocal = times.now()
  let defaultYear = nowLocal.year
  let defaultMonth = nowLocal.month.ord
  let todayDay = nowLocal.monthday
  let year = if self.appConfig.year == 0: defaultYear else: self.appConfig.year
  let month = if self.appConfig.month == 0: defaultMonth else: self.appConfig.month
  let isCurrentMonth = (year == defaultYear) and (month == defaultMonth)

  # Calendar structure
  let startMonday = self.appConfig.startWeekOnMonday
  let days = daysInMonth(year, month)
  let firstWeekday = weekday(year, month, 1)
  let firstCol = if startMonday: (firstWeekday + 6) mod 7 else: firstWeekday
  let totalCells = firstCol + days
  let rows = (totalCells + 6) div 7

  # Layout areas
  let p = max(self.appConfig.padding, 0).float32
  let bw = max(self.appConfig.borderWidth, 0.0).float32
  let gridStroke = max(self.appConfig.gridWidth, 1.0).float32

  image.fill(self.appConfig.backgroundColor)

  # Content region (inside padding)
  let contentX = p
  let contentY = p
  let contentW = image.width.float32 - 2f*p
  let contentH = image.height.float32 - 2f*p

  # Border (drawn at the content edge)
  if bw > 0:
    let w = max(1, bw.int)
    # top
    var line = newImage(contentW.int, w)
    line.fill(self.appConfig.borderColor)
    image.draw(line, translate(vec2(contentX, contentY)))
    # bottom
    image.draw(line, translate(vec2(contentX, contentY + contentH - bw)))
    # left
    var vline = newImage(w, contentH.int)
    vline.fill(self.appConfig.borderColor)
    image.draw(vline, translate(vec2(contentX, contentY)))
    # right
    image.draw(vline, translate(vec2(contentX + contentW - bw, contentY)))

  # Inner region (inside border)
  let regionX = contentX + bw
  let regionY = contentY + bw
  let regionW = contentW - 2f*bw
  let regionH = contentH - 2f*bw

  # Heights
  let headerHeight = self.appConfig.headerFontSize.float32 * 1.8
  let titleShown = self.appConfig.showMonthYear and (self.appConfig.monthYearPosition.toLowerAscii() in ["top", "bottom"])
  let titleHeight = if titleShown: self.appConfig.headerFontSize.float32 * 1.6 else: 0f
  let topTitle = if titleShown and self.appConfig.monthYearPosition.toLowerAscii() == "top": titleHeight else: 0f
  let bottomTitle = if titleShown and self.appConfig.monthYearPosition.toLowerAscii() == "bottom": titleHeight else: 0f

  let gridHeight = regionH - headerHeight - topTitle - bottomTitle
  let cellWidth = regionW / 7.0
  let cellHeight = gridHeight / rows.float32

  # Fonts
  let headerTypeface = getTypeface(self.appConfig.headerFont, self.frameConfig.assetsPath)
  let headerFont = newFont(headerTypeface, self.appConfig.headerFontSize, self.appConfig.headerTextColor)
  let dateTypeface = getTypeface(self.appConfig.dateFont, self.frameConfig.assetsPath)
  let dateFont = newFont(dateTypeface, self.appConfig.dateFontSize, self.appConfig.dateTextColor)
  let eventTypeface = getTypeface(self.appConfig.eventFont, self.frameConfig.assetsPath)
  let eventFont = newFont(eventTypeface, self.appConfig.eventFontSize, self.appConfig.eventTextColor)
  let eventBoldTypeface = getTypeface(self.appConfig.eventBoldFont, self.frameConfig.assetsPath)
  let eventBoldFont = newFont(eventBoldTypeface, self.appConfig.eventFontSize, self.appConfig.eventTextColor)

  # Title (Month Year) at top or bottom
  if titleShown:
    let monthNames = @["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
        "November", "December"]
    let titleText = &"{monthNames[month-1]} {year}"

    # Draw a background for the title
    let ty = if topTitle > 0: regionY else: regionY + regionH - bottomTitle
    var titleBg = newImage(regionW.int, titleHeight.int)
    titleBg.fill(self.appConfig.headerBackgroundColor)
    image.draw(titleBg, translate(vec2(regionX, ty)))

    let types = typeset(
      spans = [newSpan(titleText, headerFont)],
      bounds = vec2(regionW, titleHeight),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
    image.fillText(types, translate(vec2(regionX, ty)))

  # Weekday header background
  var headerImg = newImage(regionW.int, headerHeight.int)
  headerImg.fill(self.appConfig.headerBackgroundColor)
  image.draw(headerImg, translate(vec2(regionX, regionY + topTitle)))

  # Weekday labels
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
    image.fillText(types, translate(vec2(regionX + i.float32 * cellWidth, regionY + topTitle)))

  # Weekend backgrounds (draw BEFORE grid so grid stays visible)
  block shadeWeekends:
    var d = 1
    for row in 0..<rows:
      for col in 0..6:
        if row == 0 and col < firstCol:
          continue
        if d > days:
          break
        let wd = weekday(year, month, d) # 0=Sun .. 6=Sat
        if wd == 0 or wd == 6:
          let x = regionX + col.float32 * cellWidth
          let y = regionY + topTitle + headerHeight + row.float32 * cellHeight
          var bg = newImage(cellWidth.int, cellHeight.int)
          bg.fill(self.appConfig.weekendBackgroundColor)
          image.draw(bg, translate(vec2(x, y)))
        d += 1
      if d > days:
        break

  # Grid
  if self.appConfig.showGrid:
    for i in 0..7:
      let x = regionX + i.float32 * cellWidth
      var vLine = newImage(max(1, gridStroke.int), gridHeight.int)
      vLine.fill(self.appConfig.gridColor)
      image.draw(vLine, translate(vec2(x, regionY + topTitle + headerHeight)))
    for i in 0..rows:
      let y = regionY + topTitle + headerHeight + i.float32 * cellHeight
      var hLine = newImage(regionW.int, max(1, gridStroke.int))
      hLine.fill(self.appConfig.gridColor)
      image.draw(hLine, translate(vec2(regionX, y)))

  # Events and dates
  let eventsByDay = self.groupEvents()
  var day = 1
  for row in 0..<rows:
    for col in 0..6:
      if row == 0 and col < firstCol:
        continue
      if day > days:
        break
      let x = regionX + col.float32 * cellWidth
      let y = regionY + topTitle + headerHeight + row.float32 * cellHeight

      # Highlight "today" with a stroke rectangle
      if isCurrentMonth and day == todayDay:
        let stroke = max(2, (self.appConfig.gridWidth * 2).int)
        # top
        var t = newImage(cellWidth.int, stroke)
        t.fill(self.appConfig.todayStrokeColor)
        image.draw(t, translate(vec2(x, y)))
        # bottom
        image.draw(t, translate(vec2(x, y + cellHeight - stroke.float32)))
        # left
        var l = newImage(stroke, cellHeight.int)
        l.fill(self.appConfig.todayStrokeColor)
        image.draw(l, translate(vec2(x, y)))
        # right
        image.draw(l, translate(vec2(x + cellWidth - stroke.float32, y)))

      # Date number
      let dateText = $day
      let dateTypes = typeset(
        spans = [newSpan(dateText, dateFont)],
        bounds = vec2(cellWidth - 6f, self.appConfig.dateFontSize.float32 + 6f),
        hAlign = LeftAlign,
        vAlign = TopAlign,
      )
      image.fillText(dateTypes, translate(vec2(x + 4f, y + 3f)))

      # Events
      let key = &"{year:04}-{month:02}-{day:02}"
      if eventsByDay.hasKey(key):
        # Determine how many lines fit and truncate each line to stay on one row.
        let availableH = cellHeight - self.appConfig.dateFontSize.float32 - 9f
        let lineH = self.appConfig.eventFontSize.float32 + 2f
        var maxLines = int(availableH / lineH)
        if maxLines < 0: maxLines = 0

        var visibleCount = 0
        var needMoreLine = false
        let total = eventsByDay[key].len
        var linesToDraw: seq[string] = @[]

        if total > maxLines and maxLines > 0:
          visibleCount = max(0, maxLines - 1) # reserve last line for "+N more"
          needMoreLine = true
        else:
          visibleCount = min(total, maxLines)

        for i in 0 ..< visibleCount:
          let raw = eventsByDay[key][i]
          let trimmed = truncateToWidth(raw, self.appConfig.eventFontSize.float32, cellWidth - 6f)
          linesToDraw.add(trimmed)

        if needMoreLine and maxLines > 0:
          let remaining = total - visibleCount
          if remaining > 0:
            let moreText = &"+{remaining} more"
            # Truncate just in case (very narrow cells)
            linesToDraw.add(truncateToWidth(moreText, self.appConfig.eventFontSize.float32, cellWidth - 6f))

        if linesToDraw.len > 0:
          # Build spans so that event NAMES are bold. Timed events look like "HH:MM Title".
          var spans: seq[Span] = @[]
          for li, line in linesToDraw:
            if needMoreLine and (li == linesToDraw.high) and line.startsWith("+"):
              # The "+N more" line should not be bolded.
              spans.add(newSpan(line, eventFont))
            else:
              # If the line starts with "HH:MM ", split time and name. Otherwise, the whole line is the name.
              var timePart = ""
              var namePart = line
              if line.len >= 6 and line[2] == ':' and line[5] == ' ':
                timePart = line[0..4] & " "
                namePart = line[6..^1]
              if timePart.len > 0:
                spans.add(newSpan(timePart, eventFont))
              spans.add(newSpan(namePart, eventBoldFont))
            # Add newline between lines (except after the last)
            if li < linesToDraw.high:
              spans.add(newSpan("\n", eventFont))

          let eventsTypes = typeset(
            spans = spans,
            bounds = vec2(cellWidth - 6f, min(availableH, lineH * linesToDraw.len.float32)),
            hAlign = LeftAlign,
            vAlign = TopAlign,
          )
          image.fillText(eventsTypes, translate(vec2(x + 4f, y + self.appConfig.dateFontSize.float32 + 6f)))
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

