import pixie
import times
import strutils
import chrono
import options
import std/algorithm
import std/lists
import system
import tables

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

  FieldsTable* = Table[string, DoublyLinkedList[string]]

  VEvent* = object
    timeZone*: string
    startTs*: Timestamp
    endTs*: Timestamp
    fullDay*: bool
    rrules*: seq[RRule]
    recurrenceId*: string
    summary*: string
    description*: string
    location*: string
    url*: string

  ParsedCalendar* = object
    events*: seq[VEvent]
    timeZone*: string
    currentFields*: FieldsTable
    inVEvent*: bool
    inVCalendar*: bool

proc `<`(a, b: VEvent): bool =
  a.startTs < b.startTs

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
      of 'N': result.add('\n')
      of 't': result.add('\t') # ?
      of 'T': result.add('\t') # ?
      of 'r': result.add('\r') # ?
      of 'R': result.add('\r') # ?
      of ',': result.add(',')
      of ';': result.add(';')
      else: result.add(line[i])
    else:
      result.add(line[i])
    inc i
  return result

proc extractTimeZone*(self: ParsedCalendar, dateTimeStr: string): string =
  if dateTimeStr.startsWith("TZID="):
    let parts = dateTimeStr.split(":")
    parts[0].split("=")[1]
  elif dateTimeStr.endsWith("Z") or self.timeZone == "":
    "UTC"
  else:
    ""

proc processCurrentFields*(self: var ParsedCalendar) =
  let fields = self.currentFields
  var event = VEvent()

  template getFirstValue(key: string): string =
    fields[key].head.value

  # of "UID":
  #   assert(false, "UID is not supported")

  if fields.hasKey("TZID"):
    event.timeZone = fields["TZID"].head.value
  else:
    event.timeZone = self.timeZone

  if fields.hasKey("DTSTART"):
    let value = getFirstValue("DTSTART")
    if value.contains("VALUE=DATE"):
      let parts = value.split(":")
      let date = parts[len(parts) - 1]
      event.fullDay = true
      event.startTs = parseICalDateTime(date, self.timeZone)
    elif len(value) == 8:
      event.fullDay = true
      event.startTs = parseICalDateTime(value, self.timeZone)
    else:
      let tzInfo = self.extractTimeZone(value)
      if tzInfo != "":
        event.timeZone = tzInfo
      let timestamp = parseICalDateTime(value, self.timeZone)
      event.fullDay = false
      event.startTs = timestamp

  if fields.hasKey("DTEND"):
    let value = getFirstValue("DTEND")
    if value.contains("VALUE=DATE"):
      let parts = value.split(":")
      let date = parts[len(parts) - 1]
      event.fullDay = true
      event.endTs = parseICalDateTime(date, self.timeZone)
    elif len(value) == 8:
      event.fullDay = true
      event.endTs = parseICalDateTime(value, self.timeZone)
    else:
      let tzInfo = self.extractTimeZone(value)
      if tzInfo != "":
        event.timeZone = tzInfo
      let timestamp = parseICalDateTime(value, self.timeZone)
      event.fullDay = false
      event.endTs = timestamp

  if fields.hasKey("DURATION"):
    assert(false, "DURATION is not supported")

  # if fields.hasKey("DTSTAMP"): # When the event was created
  #   assert(false, "DTSTAMP is not supported")

  if fields.hasKey("RECURRENCE-ID"):
    event.recurrenceId = getFirstValue("RECURRENCE-ID")

  if fields.hasKey("RRULE"):
    var rrule = RRule(weekStart: RRuleDay.none, byDay: @[], byMonth: @[], byMonthDay: @[])
    let value = getFirstValue("RRULE")
    for split in value.split(';'):
      let keyValue = split.split('=', 2)
      if keyValue.len != 2:
        continue
      case keyValue[0]:
      of "FREQ":
        case keyValue[1]
        of "DAILY":
          rrule.freq = RRuleFreq.daily
          rrule.timeInterval = TimeInterval(days: rrule.interval or 1)
        of "WEEKLY":
          rrule.freq = RRuleFreq.weekly
          rrule.timeInterval = TimeInterval(weeks: rrule.interval or 1)
        of "MONTHLY":
          rrule.freq = RRuleFreq.monthly
          rrule.timeInterval = TimeInterval(months: rrule.interval or 1)
        of "YEARLY":
          rrule.freq = RRuleFreq.yearly
          rrule.timeInterval = TimeInterval(years: rrule.interval or 1)
      of "INTERVAL":
        rrule.interval = keyValue[1].parseInt()
      of "COUNT":
        rrule.count = keyValue[1].parseInt()
      of "UNTIL":
        rrule.until = parseICalDateTime(keyValue[1], self.timeZone)
      of "BYSECOND":
        assert(false, "BYSECOND is not supported")
      of "BYMINUTE":
        assert(false, "BYMINUTE is not supported")
      of "BYHOUR":
        assert(false, "BYHOUR is not supported")
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
      of "BYMONTHDAY":
        for monthDay in keyValue[1].split(','):
          rrule.byMonthDay.add(monthDay.parseInt())
      of "BYYEARDAY":
        assert(false, "BYYEARDAY is not supported")
      of "BYWEEKNO":
        assert(false, "BYWEEKNO is not supported")
      of "BYMONTH":
        for month in keyValue[1].split(','):
          rrule.byMonth.add(month.parseInt())
      of "BYSETPOS":
        assert(false, "BYSETPOS is not supported")
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
    event.rrules.add(rrule)
  # if fields.hasKey("RDATE"):
  #   assert(false, "RDATE is not supported")
  # if fields.hasKey("EXDATE"):
  #   assert(false, "EXDATE is not supported")

  # Text fields
  if fields.hasKey("SUMMARY"):
    event.summary = unescape(getFirstValue("SUMMARY"))
  if fields.hasKey("DESCRIPTION"):
    event.description = unescape(getFirstValue("DESCRIPTION"))
  if fields.hasKey("LOCATION"):
    event.location = unescape(getFirstValue("LOCATION"))
  if fields.hasKey("URL"):
    event.url = unescape(getFirstValue("URL"))
  # if fields.hasKey("COMMENT"):
  #   return # Ignore comments
  # if fields.hasKey("ORGANIZER"):
  #   assert(false, "ORGANIZER is not supported")
  # if fields.hasKey("GEO"):
  #   assert(false, "GEO is not supported")
  # if fields.hasKey("CATEGORIES"):
  #   assert(false, "CATEGORIES is not supported")
  # if fields.hasKey("STATUS"):
  #   assert(false, "STATUS is not supported")

  # Attendee and Alarm Properties
  # if fields.hasKey("ATTENDEE"):
  #   assert(false, "ATTENDEE is not supported")
  # if fields.hasKey("CONTACT"):
  #   assert(false, "CONTACT is not supported")
  # if fields.hasKey("RELATED-TO"):
  #   assert(false, "RELATED-TO is not supported")
  # if fields.hasKey("RESOURCES"):
  #   assert(false, "RESOURCES is not supported")
  # if fields.hasKey("VALARM"):
  #   assert(false, "VALARM is not supported")
  # if fields.hasKey("CLASS"):
  #   assert(false, "CLASS is not supported")
  # if fields.hasKey("CREATED"):
  #   assert(false, "CREATED is not supported")
  # if fields.hasKey("LAST-MODIFIED"):
  #   assert(false, "LAST-MODIFIED is not supported")
  # if fields.hasKey("SEQUENCE"):
  #   assert(false, "SEQUENCE is not supported")
  # if fields.hasKey("TRANSP"):
  #   assert(false, "TRANSP is not supported")
  # if fields.hasKey("PRIORITY"):
  #   assert(false, "PRIORITY is not supported")
  self.events.add(event)


proc processLine*(self: var ParsedCalendar, line: string) =
  if line.startsWith("BEGIN:VEVENT"):
    self.inVEvent = true
    self.currentFields = initTable[string, DoublyLinkedList[string]]()
  elif line.startsWith("END:VEVENT"):
    self.inVEvent = false
    try:
      self.processCurrentFields()
    except CatchableError as e:
      echo "Error processing event: " & e.msg
      echo self.currentFields
      raise
  elif line.startsWith("BEGIN:VCALENDAR"):
    self.inVCalendar = true
  elif line.startsWith("END:VCALENDAR"):
    self.inVCalendar = false
  elif self.inVEvent or self.inVCalendar:
    echo "Processline: " & line
    let splitPos = line.find(':')
    if splitPos == -1:
      return
    let arr = line.split({';', ':'}, 1)
    if arr.len > 1:
      let key = arr[0]
      let value = arr[1]
      if self.inVEvent:
        if not self.currentFields.hasKey(key):
          self.currentFields[key] = initDoublyLinkedList[string]()
        self.currentFields[key].add(value)
      else:
        if key == "X-WR-TIMEZONE":
          self.timeZone = unescape(value)

proc parseICalendar*(content: string, timeZone = "UTC"): ParsedCalendar =
  result = ParsedCalendar(timeZone: timeZone)
  result.timeZone = timeZone # Default. Will be overridden by X-WR-TIMEZONE if given
  var accumulator = ""
  for line in content.splitLines():
    if line.len > 0 and (line[0] == ' ' or line[0] == '\t'):
      accumulator.add(line[1..^1])
      continue
    if accumulator != "":
      processLine(result, accumulator.strip())
      accumulator = ""
    accumulator = line
  if accumulator != "":
    processLine(result, accumulator.strip())

  result.events.sort(proc (a: VEvent, b: VEvent): int = cmp(a.startTs, b.startTs))

####################################################################################################

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
