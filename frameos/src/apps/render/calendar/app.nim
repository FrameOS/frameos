import pixie
import json, options, strformat, strutils, tables
import times, chroma
import algorithm

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
    lastTheme*: string
    theme*: string
    transparentBackground*: bool
    backgroundColor*: Color
    weekendBackgroundColor*: Color # NEW: background color for Saturday/Sunday day cells
    gridColor*: Color
    dateTextColor*: Color
    eventTimeColor*: Color
    eventTitleColor*: Color
    weekdayFont*: string
    weekdayFontSize*: float
    weekdayBackgroundColor*: Color
    weekdayTextColor*: Color
    titleFont*: string
    titleFontSize*: float
    titleBackgroundColor*: Color
    titleTextColor*: Color
    dateFont*: string
    dateFontSize*: float
    eventTimeFont*: string
    eventTitleFont*: string
    eventFontSize*: float
    eventColorCount*: int
    eventColorForeground*: seq[Color]
    eventColorBackground*: seq[Color]

    # layout / decoration
    padding*: int                  # outer padding (px)
    showMonthYear*: bool           # show month + year
    monthYearPosition*: string     # "top", "bottom", or "none"
    showGrid*: bool                # toggle grid on/off
    gridWidth*: float              # grid stroke width (px)
    todayStrokeColor*: Color       # outline color for today's cell
    todayBackgroundColor*: Color   # NEW: background fill for today's cell
    todayStrokeWidth*: float       # NEW: outline thickness (px, before scaling)
    showEventTimes*: bool          # show times next to non all-day events
    scale*: int                    # scale percentage (100 = default)

  App* = ref object of AppRoot
    appConfig*: AppConfig

# Small record describing one visual line inside a day cell
type
  EventLine = object
    display*: string  # what we will draw on the line
    isAllDay*: bool   # if true we draw a colored chip behind it
    color*: ColorRGBA # base color for all-day chips
    sortKey*: int     # minutes since midnight; all-day uses -1

proc setCommonThemeFonts*(self: App) =
  self.appConfig.weekdayFont = "Ubuntu-Medium.ttf"
  self.appConfig.titleFont = "Ubuntu-Bold.ttf"
  self.appConfig.dateFont = "Ubuntu-Medium.ttf"
  self.appConfig.eventTimeFont = "Ubuntu-Light.ttf"
  self.appConfig.eventTitleFont = "Ubuntu-Medium.ttf"
  self.appConfig.weekdayFontSize = 16
  self.appConfig.titleFontSize = 28
  self.appConfig.dateFontSize = 18
  self.appConfig.eventFontSize = 14

proc setTheme*(self: App) =
  if self.appConfig.theme == "light" and self.appConfig.lastTheme != "light":
    self.appConfig.lastTheme = "light"
    self.setCommonThemeFonts()
    self.appConfig.backgroundColor = rgb(255, 255, 255).to(Color)
    self.appConfig.weekendBackgroundColor = rgba(174, 190, 229, 1).to(Color)
    self.appConfig.todayStrokeColor = rgb(255, 0, 0).to(Color)
    self.appConfig.todayBackgroundColor = rgba(239, 189, 189, 1).to(Color)
    self.appConfig.dateTextColor = rgb(0, 0, 0).to(Color)
    self.appConfig.eventTimeColor = rgb(51, 51, 51).to(Color)
    self.appConfig.eventTitleColor = rgb(51, 51, 51).to(Color)
    self.appConfig.titleTextColor = rgb(0, 0, 0).to(Color)
    self.appConfig.titleBackgroundColor = rgb(255, 255, 255).to(Color)
    self.appConfig.weekdayTextColor = rgb(0, 0, 0).to(Color)
    self.appConfig.weekdayBackgroundColor = rgb(240, 240, 240).to(Color)
    self.appConfig.gridColor = rgb(220, 220, 220).to(Color)
    self.appConfig.eventColorCount = 7
    self.appConfig.eventColorForeground = @[
      rgb(0, 0, 0).to(Color),
      rgb(0, 0, 0).to(Color),
      rgb(0, 0, 0).to(Color),
      rgb(0, 0, 0).to(Color),
      rgb(0, 0, 0).to(Color),
      rgb(0, 0, 0).to(Color),
      rgb(0, 0, 0).to(Color)
    ]
    self.appConfig.eventColorBackground = @[
      rgb(0, 122, 255).to(Color), # bright blue
      rgb(52, 199, 89).to(Color), # bright green
      rgb(255, 149, 0).to(Color), # orange
      rgb(255, 59, 48).to(Color), # bright red
      rgb(175, 82, 222).to(Color), # violet
      rgb(90, 200, 250).to(Color), # sky
      rgb(255, 204, 0).to(Color), # yellow
    ]
  elif self.appConfig.theme == "dark" and self.appConfig.lastTheme != "dark":
    self.appConfig.lastTheme = "dark"
    self.setCommonThemeFonts()
    self.appConfig.backgroundColor = rgb(34, 34, 34).to(Color)
    self.appConfig.weekendBackgroundColor = rgb(34, 26, 51).to(Color)
    self.appConfig.todayStrokeColor = rgb(255, 0, 0).to(Color)
    self.appConfig.todayBackgroundColor = rgb(47, 1, 1).to(Color)
    self.appConfig.dateTextColor = rgb(255, 255, 255).to(Color)
    self.appConfig.eventTimeColor = rgb(255, 255, 255).to(Color)
    self.appConfig.eventTitleColor = rgb(255, 255, 255).to(Color)
    self.appConfig.titleTextColor = rgb(255, 255, 255).to(Color)
    self.appConfig.titleBackgroundColor = rgb(34, 34, 34).to(Color)
    self.appConfig.weekdayTextColor = rgb(255, 255, 255).to(Color)
    self.appConfig.weekdayBackgroundColor = rgb(30, 30, 30).to(Color)
    self.appConfig.gridColor = rgb(40, 40, 40).to(Color)
    self.appConfig.eventColorCount = 7
    self.appConfig.eventColorForeground = @[
      rgb(255, 255, 255).to(Color),
      rgb(255, 255, 255).to(Color),
      rgb(255, 255, 255).to(Color),
      rgb(255, 255, 255).to(Color),
      rgb(255, 255, 255).to(Color),
      rgb(255, 255, 255).to(Color),
      rgb(255, 255, 255).to(Color),
    ]
    self.appConfig.eventColorBackground = @[
      rgb(36, 89, 175).to(Color),
      rgb(15, 105, 39).to(Color),
      rgb(148, 101, 15).to(Color),
      rgb(136, 28, 18).to(Color),
      rgb(127, 18, 158).to(Color),
      rgb(15, 106, 149).to(Color),
      rgb(116, 128, 24).to(Color),
    ]

# quick-and-simple width-based truncation so each line stays on one row
proc truncateToWidth(text: string, fontSize, maxWidth: float32): string =
  # Average glyph width heuristic ~55% of font size
  let avgChar = max(1.0'f32, fontSize * 0.55)
  var maxChars = int(maxWidth / avgChar)
  if maxChars < 1: maxChars = 1
  if text.len <= maxChars: return text
  if maxChars <= 1: return "…"
  result = text[0 .. max(0, maxChars - 2)] & "…"

proc hashTitle(s: string): uint32 =
  var h: uint32 = 5381
  for ch in s:
    h = ((h shl 5) + h) + uint32(ord(ch)) # djb2
  h

proc pickColor(self: App, title: string): ColorRGBA =
  let colorIndex = int(hashTitle(title) mod uint32(self.appConfig.eventColorCount))
  return self.appConfig.eventColorBackground[colorIndex].to(ColorRGBA)

# Create a translucent fill for the chip
proc withAlpha(c: ColorRGBA, a: float32): ColorRGBA = rgba(c.r, c.g, c.b, (a * 255).uint8)

# --- Helpers for robust all-day detection ------------------------------------

proc getBoolLoose(n: JsonNode; defaultVal = false): bool =
  ## Returns a boolean even if the JSON value is a string/int like "true"/1.
  if n.isNil: return defaultVal
  case n.kind
  of JBool: n.getBool()
  of JString:
    let s = n.getStr().toLowerAscii()
    (s in ["true", "1", "yes", "y"])
  of JInt: n.getInt() != 0
  of JFloat: n.getFloat() != 0.0
  else: defaultVal

proc looksLikeAllDay(startStr: string): bool =
  ## Consider YYYY-MM-DD (length 10) as all-day.
  ## Many feeds encode all-day starts without a time.
  if startStr.len == 10: return true
  # If we have a time part, treat "00:00" as possibly all-day
  if startStr.len >= 16:
    let hhmm = startStr[11..15]
    if hhmm == "00:00": return true
  false

# Date utils for expanding multi-day events (no timezone assumptions needed)
proc parseYMD(s: string; y, m, d: var int): bool =
  if s.len < 10: return false
  try:
    y = parseInt(s[0..3])
    m = parseInt(s[5..6])
    d = parseInt(s[8..9])
    return true
  except CatchableError:
    return false

proc cmpYMD(aY, aM, aD, bY, bM, bD: int): int =
  ## -1 if a<b, 0 if a=b, 1 if a>b
  if aY != bY: return (if aY < bY: -1 else: 1)
  if aM != bM: return (if aM < bM: -1 else: 1)
  if aD != bD: return (if aD < bD: -1 else: 1)
  0

proc incOneDay(y, m, d: var int) =
  var dd = d + 1
  var mm = m
  var yy = y
  let dim = daysInMonth(yy, mm)
  if dd > dim:
    dd = 1
    mm.inc
    if mm > 12:
      mm = 1
      yy.inc
  y = yy; m = mm; d = dd

# -----------------------------------------------------------------------------

proc timeToMinutes(start: string): int =
  ## Parse "YYYY-MM-DD[ T]HH:MM..." -> minutes since midnight.
  ## Returns a large sentinel if parsing fails.
  if start.len >= 16:
    try:
      let hh = parseInt(start[11..12])
      let mm = parseInt(start[14..15])
      return max(0, min(23, hh)) * 60 + max(0, min(59, mm))
    except CatchableError:
      discard
  # Put unknown/invalid times after normal timed events
  result = high(int) div 2

proc dateOrdinalFromStart(start: string): int =
  var y, m, d: int
  if parseYMD(start, y, m, d):
    return y * 10000 + m * 100 + d
  0

proc makeLine(self: App; summary, start: string; isAllDay: bool): EventLine =
  var display = summary
  if self.appConfig.showEventTimes and not isAllDay and start.len >= 16:
    let timeStr = start[11..15]
    if timeStr.len > 0: display = timeStr & " " & summary
  let key =
    if isAllDay:
      dateOrdinalFromStart(start)        # earlier start date => smaller key
    else:
      100_000_000 + timeToMinutes(start) # ensure timed events come after all-day
  EventLine(display: display, isAllDay: isAllDay, color: pickColor(self, summary), sortKey: key)

proc addEventLine(t: var Table[string, seq[EventLine]], key: string, line: EventLine) =
  if not t.hasKey(key): t[key] = @[]
  t[key].add(line)

proc groupEvents*(self: App): Table[string, seq[EventLine]] =
  result = initTable[string, seq[EventLine]]()
  let events = self.appConfig.events
  if events == nil or events.kind != JArray:
    return
  for ev in events.items():
    let summary = ev{"summary"}.getStr()
    let start = ev{"startTime"}.getStr()
    let endStr = ev{"endTime"}.getStr("")

    # Robustly detect all-day across different payload styles.
    var isAllDay =
      getBoolLoose(ev{"allDay"}) or
      getBoolLoose(ev{"all_day"}) or
      getBoolLoose(ev{"isAllDay"}) or
      getBoolLoose(ev{"allday"}) or
      looksLikeAllDay(start)

    # If we have an endTime and the event is (or looks) all-day/date-only, expand across each day (inclusive)
    var sy, sm, sd, ey, em, ed: int
    if endStr.len >= 10 and parseYMD(start, sy, sm, sd) and parseYMD(endStr, ey, em, ed) and (isAllDay or start.len == 10):
      # Ensure start <= end; if not, clamp to start
      var y = sy; var m = sm; var d = sd
      if cmpYMD(sy, sm, sd, ey, em, ed) > 0:
        addEventLine(result, &"{y:04}-{m:02}-{d:02}", self.makeLine(summary, start, isAllDay))
      else:
        var guard = 0
        while cmpYMD(y, m, d, ey, em, ed) <= 0 and guard < 1000:
          addEventLine(result, &"{y:04}-{m:02}-{d:02}", self.makeLine(summary, start, isAllDay))
          incOneDay(y, m, d)
          inc guard
    else:
      if start.len >= 10:
        addEventLine(result, start[0..9], self.makeLine(summary, start, isAllDay))

proc render*(self: App, context: ExecutionContext, image: Image) =
  self.setTheme()
  # Current date/time (use LOCAL time zone; FrameOS sets TZ to the user's zone, e.g., Europe/Brussels)
  let nowLocal = times.now()
  let defaultYear = nowLocal.year
  let defaultMonth = nowLocal.month.ord
  let todayDay = nowLocal.monthday
  let year = if self.appConfig.year == 0: defaultYear else: self.appConfig.year
  let month = if self.appConfig.month == 0: defaultMonth else: self.appConfig.month
  let isCurrentMonth = (year == defaultYear) and (month == defaultMonth)

  # Scale (percentage -> factor)
  let s = max(0.01'f32, self.appConfig.scale.float32 / 100.0'f32)

  # Calendar structure
  let startMonday = self.appConfig.startWeekOnMonday
  let days = daysInMonth(year, month)
  let firstWeekday = weekday(year, month, 1)
  let firstCol = if startMonday: (firstWeekday + 6) mod 7 else: firstWeekday
  let totalCells = firstCol + days
  let rows = (totalCells + 6) div 7

  # Layout areas
  let p = max(self.appConfig.padding, 0).float32 * s
  let gridStroke = round(max(self.appConfig.gridWidth, 1.0).float32 * s)

  if not self.appConfig.transparentBackground:
    image.fill(self.appConfig.backgroundColor)

  # Content region (inside padding)
  let contentX = p
  let contentY = p
  let contentW = image.width.float32 - 2f*p
  let contentH = image.height.float32 - 2f*p

  # Heights (use split sizes)
  let weekdayHeaderHeight = self.appConfig.weekdayFontSize.float32 * s * 1.5
  let titleShown = self.appConfig.showMonthYear and (self.appConfig.monthYearPosition.toLowerAscii() in ["top", "bottom"])
  let titleHeight = if titleShown: self.appConfig.titleFontSize.float32 * s * 1.8 else: 0f
  let topTitle = if titleShown and self.appConfig.monthYearPosition.toLowerAscii() == "top": titleHeight else: 0f
  let bottomTitle = if titleShown and self.appConfig.monthYearPosition.toLowerAscii() == "bottom": titleHeight else: 0f

  let gridHeight = contentH - weekdayHeaderHeight - topTitle - bottomTitle
  let cellWidth = contentW / 7.0
  let cellHeight = gridHeight / rows.float32

  # Fonts (apply scaling)
  let titleTypeface = getTypeface(self.appConfig.titleFont, self.frameConfig.assetsPath)
  let titleFont = newFont(titleTypeface, self.appConfig.titleFontSize * s, self.appConfig.titleTextColor)
  let weekdayTypeface = getTypeface(self.appConfig.weekdayFont, self.frameConfig.assetsPath)
  let weekdayFont = newFont(weekdayTypeface, self.appConfig.weekdayFontSize * s, self.appConfig.weekdayTextColor)
  let dateTypeface = getTypeface(self.appConfig.dateFont, self.frameConfig.assetsPath)
  let dateFont = newFont(dateTypeface, self.appConfig.dateFontSize * s, self.appConfig.dateTextColor)
  let eventTimeTypeface = getTypeface(self.appConfig.eventTimeFont, self.frameConfig.assetsPath)
  let eventTimeFont = newFont(eventTimeTypeface, self.appConfig.eventFontSize * s, self.appConfig.eventTimeColor)
  let eventTitleTypeface = getTypeface(self.appConfig.eventTitleFont, self.frameConfig.assetsPath)
  let eventTitleFont = newFont(eventTitleTypeface, self.appConfig.eventFontSize * s, self.appConfig.eventTitleColor)

  # Title (Month Year) at top or bottom
  if titleShown:
    let monthNames = @["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
        "November", "December"]
    let titleText = &"{monthNames[month-1]} {year}"

    # Draw a background for the title
    let ty = if topTitle > 0: contentY else: contentY + contentH - bottomTitle
    var titleBg = newImage(contentW.int, titleHeight.int)
    titleBg.fill(self.appConfig.titleBackgroundColor)
    image.draw(titleBg, translate(vec2(contentX, ty)))

    let types = typeset(
      spans = [newSpan(titleText, titleFont)],
      bounds = vec2(contentW, titleHeight),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
    image.fillText(types, translate(vec2(contentX, ty)))

  # Weekday header background
  var headerImg = newImage(contentW.int, weekdayHeaderHeight.int)
  headerImg.fill(self.appConfig.weekdayBackgroundColor)
  image.draw(headerImg, translate(vec2(contentX, contentY + topTitle)))

  # Weekday labels
  let weekdays = if startMonday:
    @["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  else:
    @["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

  for i, dayName in weekdays:
    let types = typeset(
      spans = [newSpan(dayName, weekdayFont)],
      bounds = vec2(cellWidth, weekdayHeaderHeight),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
    image.fillText(types, translate(vec2(contentX + i.float32 * cellWidth, contentY + topTitle)))

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
          let x = contentX + col.float32 * cellWidth
          let y = contentY + topTitle + weekdayHeaderHeight + row.float32 * cellHeight
          var bg = newImage(cellWidth.int, cellHeight.int)
          bg.fill(self.appConfig.weekendBackgroundColor)
          image.draw(bg, translate(vec2(x, y)))
        d += 1
      if d > days:
        break

  # Today's background (also BEFORE grid so lines remain visible)
  block shadeToday:
    if isCurrentMonth:
      let d = todayDay
      let idx = firstCol + (d - 1)
      let row = idx div 7
      let col = idx mod 7
      let x = contentX + col.float32 * cellWidth
      let y = contentY + topTitle + weekdayHeaderHeight + row.float32 * cellHeight
      var bg = newImage(cellWidth.int, cellHeight.int)
      bg.fill(self.appConfig.todayBackgroundColor)
      image.draw(bg, translate(vec2(x, y)))

  # Grid
  if self.appConfig.showGrid:
    for i in 0..7:
      let x = contentX + i.float32 * cellWidth
      var vLine = newImage(max(1, gridStroke.int), gridHeight.int)
      vLine.fill(self.appConfig.gridColor)
      image.draw(vLine, translate(vec2(x, contentY + topTitle + weekdayHeaderHeight)))
    for i in 0..rows:
      let y = contentY + topTitle + weekdayHeaderHeight + i.float32 * cellHeight
      var hLine = newImage(contentW.int, max(1, gridStroke.int))
      hLine.fill(self.appConfig.gridColor)
      image.draw(hLine, translate(vec2(contentX, y)))

  # Events and dates
  var eventsByDay = self.groupEvents()

  # Ensure events within each day are sorted (all-day first, then by start time)
  for _, daySeq in eventsByDay.mpairs:
    sort(daySeq, proc (a, b: EventLine): int =
      let c = system.cmp(a.sortKey, b.sortKey)
      if c != 0: c else: system.cmp(a.display, b.display)
    )

  var day = 1
  for row in 0..<rows:
    for col in 0..6:
      if row == 0 and col < firstCol:
        continue
      if day > days:
        break
      let x = contentX + col.float32 * cellWidth
      let y = contentY + topTitle + weekdayHeaderHeight + row.float32 * cellHeight

      # Highlight "today" with a configurable stroke rectangle
      if isCurrentMonth and day == todayDay:
        let strokeF = max(0.0'f32, self.appConfig.todayStrokeWidth.float32 * s)
        let stroke = max(0, strokeF.int)
        if stroke > 0:
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
      let datePadX = 4f * s
      let datePadY = 3f * s
      let dateBoundsH = self.appConfig.dateFontSize.float32 * s + 6f * s
      let dateTypes = typeset(
        spans = [newSpan(dateText, dateFont)],
        bounds = vec2(cellWidth - (datePadX + 2f*s), dateBoundsH),
        hAlign = LeftAlign,
        vAlign = TopAlign,
      )
      image.fillText(dateTypes, translate(vec2(x + datePadX, y + datePadY)))

      # Events
      let key = &"{year:04}-{month:02}-{day:02}"
      if eventsByDay.hasKey(key):
        # Determine how many lines fit and truncate each line to stay on one row.
        let availableH = cellHeight - (self.appConfig.dateFontSize.float32 * s) - 9f*s
        let lineH = (self.appConfig.eventFontSize.float32 * s) + 2f*s
        var maxLines = int(availableH / lineH)
        if maxLines < 0: maxLines = 0

        var visibleCount = 0
        var needMoreLine = false
        let total = eventsByDay[key].len

        if total > maxLines and maxLines > 0:
          visibleCount = max(0, maxLines - 1) # reserve last line for "+N more"
          needMoreLine = true
        else:
          visibleCount = min(total, maxLines)

        # Build the actual lines (possibly trimmed) we will draw
        var linesToDraw: seq[EventLine] = @[]
        for i in 0 ..< visibleCount:
          var ev = eventsByDay[key][i]
          let trimW = if ev.isAllDay: (cellWidth - 12f*s) else: (cellWidth - 6f*s)
          ev.display = truncateToWidth(ev.display, (self.appConfig.eventFontSize.float32 * s), trimW)
          linesToDraw.add(ev)

        if needMoreLine and maxLines > 0:
          let remaining = total - visibleCount
          if remaining > 0:
            linesToDraw.add(EventLine(display: &"+{remaining} more", isAllDay: false, color: rgba(0, 0, 0, 0),
                sortKey: high(int)))

        # Draw each line individually so we can paint chips for all-day events
        let baseY = y + (self.appConfig.dateFontSize.float32 * s) + 6f*s
        for li, line in linesToDraw:
          let yLine = baseY + li.float32 * lineH

          if line.isAllDay and not line.display.startsWith("+"):
            # Chip background (fill + subtle border) similar to Google Calendar
            let padX = 4f * s
            let padY = 1f * s
            let chipW = cellWidth - (padX * 2)
            let chipH = lineH - (padY * 2)
            let chipX = x + padX
            let chipY = yLine + padY
            var chip = newImage(chipW.int, chipH.int)
            chip.fill(withAlpha(line.color, 0.18))
            image.draw(chip, translate(vec2(chipX, chipY)))
            # simple 1px inner border
            var topB = newImage(chipW.int, 1)
            topB.fill(withAlpha(line.color, 0.55))
            image.draw(topB, translate(vec2(chipX, chipY)))
            image.draw(topB, translate(vec2(chipX, chipY + chipH - 1)))
            var sideB = newImage(1, chipH.int)
            sideB.fill(withAlpha(line.color, 0.55))
            image.draw(sideB, translate(vec2(chipX, chipY)))
            image.draw(sideB, translate(vec2(chipX + chipW - 1, chipY)))

          # Build text for the line (time part + bold title for timed events)
          var spans: seq[Span] = @[]
          if line.display.len >= 6 and line.display[2] == ':' and line.display[5] == ' ':
            let timePart = line.display[0..4] & " "
            let namePart = line.display[6..^1]
            spans.add(newSpan(timePart, eventTimeFont))
            spans.add(newSpan(namePart, eventTitleFont))
          else:
            # Either an all-day event line or the "+N more" line
            if line.display.startsWith("+"):
              spans.add(newSpan(line.display, eventTimeFont))
            else:
              spans.add(newSpan(line.display, eventTitleFont))

          let bx = x + (if line.isAllDay and not line.display.startsWith("+"): 8f*s else: 4f*s)
          let bw = cellWidth - (if line.isAllDay and not line.display.startsWith("+"): 12f*s else: 6f*s)
          let bH = if line.isAllDay and not line.display.startsWith("+"): (lineH - 2f*s) else: lineH

          let types = typeset(
            spans = spans,
            bounds = vec2(bw, bH),
            hAlign = LeftAlign,
            vAlign = if line.isAllDay and not line.display.startsWith("+"): MiddleAlign else: TopAlign,
          )
          image.fillText(types, translate(vec2(bx, yLine + (if line.isAllDay and not line.display.startsWith(
              "+"): 1f*s else: 0f))))
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
