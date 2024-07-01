import pixie
import times
import strutils
import chrono
import options
import std/algorithm
import std/lists

type
  RRuleFreq* = enum
    daily, weekly, monthly, yearly

  RRuleDay* = enum
    none = -1
    su = 0, mo, tu, we, th, fr, sa

  RRule* = object
    freq*: RRuleFreq
    interval*: int
    timeInterval*: TimeInterval
    byDay*: seq[(RRuleDay, int)]
    byMonth*: seq[int]
    byMonthDay*: seq[int]
    until*: Timestamp
    count*: int
    weekStart*: RRuleDay

  VEvent* = ref object
    summary*: string
    description*: string
    startTs*: Timestamp
    endTs*: Timestamp
    fullDay*: bool
    location*: string
    rrules*: seq[RRule]
    recurrenceId*: string

  ParsedCalendar* = ref object
    events*: seq[VEvent]
    timeZone*: string
    currentVEvent*: VEvent
    inVEvent*: bool
    inVCalendar*: bool

proc extractTimeZone*(dateTimeStr: string): string =
  if dateTimeStr.startsWith("TZID="):
    let parts = dateTimeStr.split(":")
    parts[0].split("=")[1]
  else:
    "UTC"

proc parseICalDateTime*(dateTimeStr: string, timezone: string): Timestamp =
  let dateTime = if dateTimeStr.contains(";"): dateTimeStr.split(";")[1]
                 elif dateTimeStr.contains(":"): dateTimeStr.split(":")[1]
                 else: dateTimeStr
  let format = if 'T' in dateTime:
                 "{year/4}{month/2}{day/2}T{hour/2}{minute/2}{second/2}" & (if dateTimeStr.endsWith("Z"): "Z" else: "")
               else:
                 "{year/4}{month/2}{day/2}"
  try:
    var cal = parseTs(format, dateTime).calendar()
    if 'T' in dateTime and dateTimeStr.endsWith("Z"):
      cal.applyTimezone(timeZone) # Treat UTC timestamps as the real deal
    else:
      cal.shiftTimezone(timeZone) # Otherwise the date/time was in the local zone
    return cal.ts
  except ValueError as e:
    raise newException(TimeParseError, "Failed to parse datetime string: " & dateTimeStr & ". Error: " & e.msg)

proc unescape*(line: string): string =
  result = ""
  var i = 0
  while i < line.len:
    if line[i] == '\\':
      inc i
      if i >= line.len:
        result.add('\\')
        break
      case line[i]
      of 'n': result.add('\n')
      of 't': result.add('\t')
      of 'r': result.add('\r')
      of ',': result.add(',')
      of ';': result.add(';')
      else: result.add(line[i])
    else:
      result.add(line[i])
    inc i
  return result

proc processLine*(self: ParsedCalendar, line: string) =
  try:
    if line.startsWith("BEGIN:VEVENT"):
      self.inVEvent = true
      self.currentVEvent = VEvent()
      if self.timeZone == "":
        self.timeZone = now().timezone().name
    elif line.startsWith("END:VEVENT"):
      self.inVEvent = false
      self.events.add(self.currentVEvent)
    elif line.startsWith("BEGIN:VCALENDAR"):
      self.inVCalendar = true
    elif line.startsWith("END:VCALENDAR"):
      self.inVCalendar = false
    elif self.inVEvent or self.inVCalendar:
      let splitPos = line.find(':')
      if splitPos == -1:
        return
      let arr = line.split({';', ':'}, 1)
      if arr.len > 1:
        let key = arr[0]
        let value = arr[1]
        if self.inVEvent:
          case key
          of "DTSTART", "DTEND":
            if value.contains("VALUE=DATE"):
              let parts = value.split(":")
              let date = parts[len(parts) - 1]
              self.currentVEvent.fullDay = true
              let timestamp = parseICalDateTime(date, self.timeZone)
              if key == "DTSTART":
                self.currentVEvent.startTs = timestamp
              else:
                self.currentVEvent.endTs = timestamp
            else:
              let tzInfo = extractTimeZone(value)
              let timestamp = parseICalDateTime(value, tzInfo)
              self.currentVEvent.fullDay = false
              if key == "DTSTART":
                self.currentVEvent.startTs = timestamp
              else:
                self.currentVEvent.endTs = timestamp
          of "LOCATION":
            self.currentVEvent.location = unescape(value)
          of "SUMMARY":
            self.currentVEvent.summary = unescape(value)
          of "RECURRENCE-ID":
            self.currentVEvent.recurrenceId = unescape(value)
          of "RRULE":
            var rrule = RRule(weekStart: RRuleDay.none, byDay: @[], byMonth: @[], byMonthDay: @[])
            for split in arr[1].split(';'):
              let keyValue = split.split('=', 2)
              if keyValue.len != 2:
                continue
              case keyValue[0]:
              of "FREQ":
                case keyValue[1]
                of "DAILY":
                  rrule.freq = RRuleFreq.daily
                of "WEEKLY":
                  rrule.freq = RRuleFreq.weekly
                of "MONTHLY":
                  rrule.freq = RRuleFreq.monthly
                of "YEARLY":
                  rrule.freq = RRuleFreq.yearly
              of "INTERVAL":
                rrule.interval = keyValue[1].parseInt()
              of "COUNT":
                rrule.count = keyValue[1].parseInt()
              of "UNTIL":
                rrule.until = parseICalDateTime(keyValue[1], self.timeZone)
              of "BYDAY":
                # "1SU"
                for day in keyValue[1].split(','):
                  let weekDay = day[^2..^1]
                  let dayNum = if day.len > 2: day[0..(day.len - weekDay.len - 1)].parseInt() else: 0
                  case weekDay.toUpper():
                  of "SU": rrule.byDay.add((RRuleDay.su, dayNum))
                  of "MO": rrule.byDay.add((RRuleDay.mo, dayNum))
                  of "TU": rrule.byDay.add((RRuleDay.tu, dayNum))
                  of "WE": rrule.byDay.add((RRuleDay.we, dayNum))
                  of "TH": rrule.byDay.add((RRuleDay.th, dayNum))
                  of "FR": rrule.byDay.add((RRuleDay.fr, dayNum))
                  of "SA": rrule.byDay.add((RRuleDay.sa, dayNum))
              of "BYMONTH":
                for month in keyValue[1].split(','):
                  rrule.byMonth.add(month.parseInt())
              of "BYMONTHDAY":
                for monthDay in keyValue[1].split(','):
                  rrule.byMonthDay.add(monthDay.parseInt())
              of "WKST":
                case keyValue[1].toUpper()
                of "SU": rrule.weekStart = RRuleDay.su
                of "MO": rrule.weekStart = RRuleDay.mo
                of "TU": rrule.weekStart = RRuleDay.tu
                of "WE": rrule.weekStart = RRuleDay.we
                of "TH": rrule.weekStart = RRuleDay.th
                of "FR": rrule.weekStart = RRuleDay.fr
                of "SA": rrule.weekStart = RRuleDay.sa
              else:
                echo "!! Unknown RRULE rule: " & split
            if rrule.interval == 0:
              rrule.interval = 1
            if rrule.freq == RRuleFreq.daily:
              rrule.timeInterval = TimeInterval(days: rrule.interval or 1)
            elif rrule.freq == RRuleFreq.weekly:
              rrule.timeInterval = TimeInterval(weeks: rrule.interval or 1)
            elif rrule.freq == RRuleFreq.monthly:
              rrule.timeInterval = TimeInterval(months: rrule.interval or 1)
            elif rrule.freq == RRuleFreq.yearly:
              rrule.timeInterval = TimeInterval(years: rrule.interval or 1)
            self.currentVEvent.rrules.add(rrule)
          of "DESCRIPTION":
            self.currentVEvent.description = unescape(value)
          else:
            return
        elif self.inVCalendar:
          case key
          of "X-WR-TIMEZONE":
            self.timeZone = value
          else:
            return

  except CatchableError as e:
    echo "Failed to parse calendar line \"" & line & "\". Error: " & e.msg

proc parseICalendar*(content: string, timeZone = ""): ParsedCalendar =
  let lines = content.splitLines()
  var accumulator = ""
  var parser = ParsedCalendar(events: @[],
                              timeZone: timeZone,
                              currentVEvent: nil,
                              inVEvent: false,
                              inVCalendar: false)

  for i, line in lines:
    if line.len > 0 and (line[0] == ' ' or line[0] == '\t'):
      accumulator.add(line[1..^1])
      continue
    if accumulator != "":
      parser.processLine(accumulator.strip())
      accumulator = ""
    accumulator = line
  if accumulator != "":
    parser.processLine(accumulator.strip())
  parser.events.sort(proc (a: VEvent, b: VEvent): int = cmp(a.startTs, b.startTs))
  return parser


proc applyRRule(parsedCalendar: ParsedCalendar, startTs: Timestamp, endTs: Timestamp, event: VEvent, rrule: RRule): seq[
    (Timestamp, VEvent)] =
  var
    currentTs = event.startTs
    newEndTs = event.endTs
    currentCal = currentTs.calendar(parsedCalendar.timeZone)
    count = 0

  while (rrule.until == 0.Timestamp or currentTs <= rrule.until) and (rrule.count == 0 or count < rrule.count) and
      currentTs <= endTs:

    if currentTs <= endTs and newEndTs >= startTs:
      result.add((currentTs, event))

    case rrule.freq
    of RRuleFreq.daily:
      currentCal.add(TimeScale.Day, rrule.interval)
    of RRuleFreq.weekly:
      currentCal.add(TimeScale.Day, 7 * rrule.interval)
    of RRuleFreq.monthly:
      currentCal.add(TimeScale.Month, rrule.interval)
    of RRuleFreq.yearly:
      currentCal.add(TimeScale.Year, rrule.interval)

    # Apply BYDAY, BYMONTH, BYMONTHDAY adjustments
    # (Simplified for clarity. Implement specific logic based on iCalendar specifications)

    currentTs = currentCal.ts
    newEndTs = (currentTs.float + (event.endTs.float - event.startTs.float)).Timestamp
    inc(count)
    if count > 100000:
      break

proc getEvents*(parsedCalendar: ParsedCalendar, startTs: Timestamp, endTs: Timestamp, search: string = "",
    maxCount: int = 1000): seq[(Timestamp, VEvent)] =
  for event in parsedCalendar.events:
    if search != "" and not event.summary.contains(search):
      continue

    for rrule in event.rrules:
      let newRules = applyRRule(parsedCalendar, startTs, endTs, event, rrule)
      for rule in newRules:
        result.add(rule)

    if event.rrules.len == 0 and event.startTs <= endTs and event.endTs >= startTs:
      result.add((event.startTs, event))

  result.sort(cmp) # Sort events based on start time
  if maxCount > 0 and result.len > maxCount:
    result = result[0..<maxCount]
