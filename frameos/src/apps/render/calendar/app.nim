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

    # new fields
    scale*: int                    # scale percentage (100 = default)
    palette*: string               # palette selector for all-day chips

  App* = ref object of AppRoot
    appConfig*: AppConfig

# Small record describing one visual line inside a day cell
type
  EventLine = object
    display*: string  # what we will draw on the line
    isAllDay*: bool   # if true we draw a colored chip behind it
    color*: ColorRGBA # base color for all-day chips

# quick-and-simple width-based truncation so each line stays on one row
proc truncateToWidth(text: string, fontSize, maxWidth: float32): string =
  # Average glyph width heuristic ~55% of font size
  let avgChar = max(1.0'f32, fontSize * 0.55)
  var maxChars = int(maxWidth / avgChar)
  if maxChars < 1: maxChars = 1
  if text.len <= maxChars: return text
  if maxChars <= 1: return "…"
  result = text[0 .. max(0, maxChars - 2)] & "…"

# --- Palettes for all-day pills ----------------------------------------------
# Default (Google-ish) palette
const paletteDefault: array[10, ColorRGBA] = [
  rgba(66, 133, 244, 255), # blue
  rgba(52, 168, 83, 255),  # green
  rgba(251, 188, 5, 255),  # yellow/amber
  rgba(234, 67, 53, 255),  # red
  rgba(142, 36, 170, 255), # purple
  rgba(0, 172, 193, 255),  # teal
  rgba(244, 180, 0, 255),  # amber 600
  rgba(171, 71, 188, 255), # purple 400
  rgba(3, 155, 229, 255),  # light blue
  rgba(255, 128, 171, 255) # pink
]

# a) Dark tones (muted/deep shades)
const paletteDarkTones: array[10, ColorRGBA] = [
  rgba(33, 47, 60, 255),  # dark blue-gray
  rgba(27, 79, 114, 255), # deep blue
  rgba(14, 98, 81, 255),  # deep teal
  rgba(74, 35, 90, 255),  # deep purple
  rgba(100, 30, 22, 255), # deep red
  rgba(20, 90, 50, 255),  # forest
  rgba(90, 66, 0, 255),   # dark amber
  rgba(55, 71, 79, 255),  # blue gray
  rgba(40, 55, 71, 255),  # steel
  rgba(0, 51, 51, 255)    # dark cyan
]

# b) Red/Black/White only (for tri-color displays)
const paletteRedBlackWhite: array[6, ColorRGBA] = [
  rgba(255, 0, 0, 255),     # red
  rgba(200, 0, 0, 255),     # dark red
  rgba(120, 0, 0, 255),     # deeper red
  rgba(0, 0, 0, 255),       # black
  rgba(255, 255, 255, 255), # white
  rgba(80, 80, 80, 255)     # gray (renders black on many tri-color panels)
]

# c) High contrast bright tones (saturated)
const paletteBrightHighContrast: array[10, ColorRGBA] = [
  rgba(0, 122, 255, 255),  # bright blue
  rgba(52, 199, 89, 255),  # bright green
  rgba(255, 149, 0, 255),  # orange
  rgba(255, 59, 48, 255),  # bright red
  rgba(175, 82, 222, 255), # violet
  rgba(90, 200, 250, 255), # sky
  rgba(255, 204, 0, 255),  # yellow
  rgba(64, 156, 255, 255), # azure
  rgba(255, 45, 85, 255),  # pink
  rgba(48, 209, 88, 255)   # green 2
]

# d) High contrast overall (including extremes)
const paletteHighContrast: array[8, ColorRGBA] = [
  rgba(0, 0, 0, 255),       # black
  rgba(255, 255, 255, 255), # white
  rgba(255, 0, 0, 255),     # red
  rgba(0, 255, 0, 255),     # green
  rgba(0, 0, 255, 255),     # blue
  rgba(255, 255, 0, 255),   # yellow
  rgba(255, 0, 255, 255),   # magenta
  rgba(0, 255, 255, 255)    # cyan
]

# e) Rainbow (ROYGBIV-ish)
const paletteRainbow: array[8, ColorRGBA] = [
  rgba(255, 0, 0, 255),   # red
  rgba(255, 127, 0, 255), # orange
  rgba(255, 255, 0, 255), # yellow
  rgba(0, 200, 0, 255),   # green
  rgba(0, 150, 255, 255), # blue
  rgba(75, 0, 130, 255),  # indigo-esque
  rgba(148, 0, 211, 255), # violet
  rgba(0, 0, 0, 255)      # black separator
]

proc getPalette(self: App): seq[ColorRGBA] =
  let key = self.appConfig.palette.toLowerAscii()
  case key
  of "darktones": @paletteDarkTones
  of "redblackwhite": @paletteRedBlackWhite
  of "brighthighcontrast": @paletteBrightHighContrast
  of "highcontrast": @paletteHighContrast
  of "rainbow": @paletteRainbow
  else: @paletteDefault

proc hashTitle(s: string): uint32 =
  var h: uint32 = 5381
  for ch in s:
    h = ((h shl 5) + h) + uint32(ord(ch)) # djb2
  h

proc pickColor(self: App, title: string): ColorRGBA =
  let pal = self.getPalette()
  pal[int(hashTitle(title) mod uint32(pal.len))]

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

# add these helpers (above `groupEvents`)
proc makeLine(self: App; summary, start: string; isAllDay: bool): EventLine =
  var display = summary
  if self.appConfig.showEventTimes and not isAllDay and start.len >= 16:
    let timeStr = start[11..15]
    if timeStr.len > 0: display = timeStr & " " & summary
  EventLine(display: display, isAllDay: isAllDay, color: pickColor(self, summary))

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
  let bw = max(self.appConfig.borderWidth, 0.0).float32 * s
  let gridStroke = max(self.appConfig.gridWidth, 1.0).float32 * s

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

  # Heights (use split sizes)
  let weekdayHeaderHeight = self.appConfig.weekdayFontSize.float32 * s * 1.5
  let titleShown = self.appConfig.showMonthYear and (self.appConfig.monthYearPosition.toLowerAscii() in ["top", "bottom"])
  let titleHeight = if titleShown: self.appConfig.titleFontSize.float32 * s * 1.8 else: 0f
  let topTitle = if titleShown and self.appConfig.monthYearPosition.toLowerAscii() == "top": titleHeight else: 0f
  let bottomTitle = if titleShown and self.appConfig.monthYearPosition.toLowerAscii() == "bottom": titleHeight else: 0f

  let gridHeight = regionH - weekdayHeaderHeight - topTitle - bottomTitle
  let cellWidth = regionW / 7.0
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
    let ty = if topTitle > 0: regionY else: regionY + regionH - bottomTitle
    var titleBg = newImage(regionW.int, titleHeight.int)
    titleBg.fill(self.appConfig.titleBackgroundColor)
    image.draw(titleBg, translate(vec2(regionX, ty)))

    let types = typeset(
      spans = [newSpan(titleText, titleFont)],
      bounds = vec2(regionW, titleHeight),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
    image.fillText(types, translate(vec2(regionX, ty)))

  # Weekday header background
  var headerImg = newImage(regionW.int, weekdayHeaderHeight.int)
  headerImg.fill(self.appConfig.weekdayBackgroundColor)
  image.draw(headerImg, translate(vec2(regionX, regionY + topTitle)))

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
          let y = regionY + topTitle + weekdayHeaderHeight + row.float32 * cellHeight
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
      image.draw(vLine, translate(vec2(x, regionY + topTitle + weekdayHeaderHeight)))
    for i in 0..rows:
      let y = regionY + topTitle + weekdayHeaderHeight + i.float32 * cellHeight
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
      let y = regionY + topTitle + weekdayHeaderHeight + row.float32 * cellHeight

      # Highlight "today" with a stroke rectangle
      if isCurrentMonth and day == todayDay:
        let stroke = max(2, (self.appConfig.gridWidth * s * 2).int)
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
            linesToDraw.add(EventLine(display: &"+{remaining} more", isAllDay: false, color: rgba(0, 0, 0, 0)))

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

