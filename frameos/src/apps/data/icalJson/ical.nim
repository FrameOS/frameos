import pixie
import times
import strutils
import chrono
import options
import std/algorithm
import std/lists
import system
import tables

# Key missing event features (none used by Google/Apple calendar):
# - HOURLY, MINUTELY, SECONDLY frequencies
# - BYHOUR, BYMINUTE, BYSECOND
# - BYSETPOS
# - DURATION
# - RDATE

# Missing metadata fields:
# - ORGANIZER, ATTENDEE, CONTACT, RELATED-TO, RESOURCES, VALARM, CLASS, CREATED, LAST-MODIFIED,
# - SEQUENCE, TRANSP, PRIORITY, STATUS, GEO, CATEGORIES

type
  RRuleFreq* = enum
    daily, weekly, monthly, yearly

  RRuleDay* = enum
    none = -1
    mo = 0, tu, we, th, fr, sa, su # match order in chrono

  RRule* = object
    freq*: RRuleFreq
    interval*: int
    byDay*: seq[(RRuleDay, int)]
    byMonth*: seq[int]
    byMonthDay*: seq[int]
    byYearDay*: seq[int]
    byWeekNo*: seq[int]
    until*: Timestamp
    count*: int
    weekStart*: RRuleDay

  FieldsTable* = Table[string, DoublyLinkedList[string]]
  EventsSeq* = seq[(Timestamp, VEvent)]

  VEvent* = object
    uid*: string
    timeZone*: string
    startTs*: Timestamp
    endTs*: Timestamp
    fullDay*: bool
    rrules*: seq[RRule]
    exDates*: seq[Timestamp]
    recurrenceId*: string
    summary*: string
    description*: string
    location*: string
    url*: string

  ParsedCalendar* = object
    events*: seq[VEvent]
    timeZone*: string
    currentFields*: FieldsTable
    inVAlarm*: bool
    inVEvent*: bool
    inVCalendar*: bool
    rRuleProvided*: Table[string, (Timestamp, VEvent)]
    rRuleGenerated*: Table[string, (Timestamp, VEvent)]
    result*: EventsSeq

const MAX_RESULT_COUNT = 100000

####################################################################################################
# Parsing

proc `<`(a, b: VEvent): bool =
  a.startTs < b.startTs

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

proc parseICalDateTime*(dateTimeStr: string, timeZone: string): Timestamp =
  let dateTime = if dateTimeStr.contains(";"): dateTimeStr.split(";")[1]
                 elif dateTimeStr.contains(":"): dateTimeStr.split(":")[1]
                 else: dateTimeStr
  let format = if 'T' in dateTime:
                 "{year/4}{month/2}{day/2}T{hour/2}{minute/2}{second/2}" & (if dateTime.endsWith("Z"): "Z" else: "")
               else:
                 "{year/4}{month/2}{day/2}"
  try:
    let ts = parseTs(format, dateTime)

    # Treat UTC timestamps as the real deal
    if 'T' in dateTime and dateTime.endsWith("Z"):
      return ts

    # Otherwise the date/time was in the local zone
    var cal = ts.calendar()
    cal.shiftTimezone(timeZone)
    return cal.ts
  except ValueError as e:
    raise newException(TimeParseError, "Failed to parse datetime string: " & dateTimeStr & ". Error: " & e.msg)

proc parseDateString(self: var ParsedCalendar, event: var VEvent, value: string): Timestamp =
  let timeZone = if event.timeZone == "": self.timeZone else: event.timeZone
  if value.contains("VALUE=DATE"):
    let parts = value.split(":")
    let date = parts[len(parts) - 1]
    return parseICalDateTime(date, timeZone)
  elif len(value) == 8: # 20181231
    return parseICalDateTime(value, timeZone)
  else:
    return parseICalDateTime(value, timeZone)

proc processCurrentFields*(self: var ParsedCalendar) =
  let fields = self.currentFields
  var event = VEvent()

  template getFirstValue(key: string): string =
    fields[key].head.value

  if fields.hasKey("UID"):
    event.uid = getFirstValue("UID")

  if fields.hasKey("TZID"):
    event.timeZone = fields["TZID"].head.value
  else:
    event.timeZone = self.timeZone

  if fields.hasKey("DTSTART"):
    let value = getFirstValue("DTSTART")
    if value.startsWith("TZID="):
      event.timeZone = value.split(":")[0].split("=")[1]
    event.startTs = self.parseDateString(event, value)
    event.fullDay = value.contains("VALUE=DATE") or len(value) == 8

  if fields.hasKey("DTEND"):
    let value = getFirstValue("DTEND")
    if value.startsWith("TZID="):
      event.timeZone = value.split(":")[0].split("=")[1]
    event.endTs = self.parseDateString(event, value)
    event.fullDay = value.contains("VALUE=DATE") or len(value) == 8

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
          rrule.freq = daily
        of "WEEKLY":
          rrule.freq = weekly
        of "MONTHLY":
          rrule.freq = monthly
        of "YEARLY":
          rrule.freq = yearly
        else:
          assert(false, "Unknown RRULE freq: " & keyValue[1])
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
        for yearDay in keyValue[1].split(','):
          rrule.byYearDay.add(yearDay.parseInt())
      of "BYWEEKNO":
        for weekNo in keyValue[1].split(','):
          rrule.byWeekNo.add(weekNo.parseInt())
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

    # Since none of the BYDAY, BYMONTHDAY, or BYYEARDAY components are specified, the day is gotten from "DTSTART".
    # RRULE:FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3
    if (rrule.freq == monthly or rrule.freq == yearly) and rrule.byMonth.len > 0 and rrule.byDay.len == 0 and
        rrule.byMonthDay.len == 0 and rrule.byYearDay.len == 0:
      rrule.byMonthDay.add(event.startTs.calendar(event.timeZone).day)

    event.rrules.add(rrule)
  # if fields.hasKey("RDATE"):
  #   assert(false, "RDATE is not supported")
  if fields.hasKey("EXDATE"):
    for value in fields["EXDATE"].items():
      event.exDates.add(parseICalDateTime(value, event.timeZone))

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
  elif line.startsWith("BEGIN:VALARM"):
    self.inVAlarm = true
  elif line.startsWith("END:VALARM"):
    self.inVAlarm = false
  elif not self.inVAlarm and (self.inVEvent or self.inVCalendar):
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

proc parseICalendar*(content: string, timeZone = ""): ParsedCalendar =
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
# Querying

proc fixDST(self: var Calendar, timeZone: string) =
  self.tzOffset = 0
  self.tzName = ""
  self.dstName = ""
  self.shiftTimezone(timeZone)

proc trimDay(self: var Calendar) =
  self.secondFraction = 0.0
  self.second = 0
  self.minute = 0
  self.hour = 0

proc dayOfYear*(cal: Calendar): int =
  # TODO: upstream all of this
  proc leapYear(year: int): bool =
    if year mod 4 == 0:
      if year mod 100 == 0:
        if year mod 400 == 0:
          return true
        else:
          return false
      else:
        return true
    else:
      return false
  proc daysInMonth(m: int, year: int): int =
    if m == 1 or m == 3 or m == 5 or m == 7 or m == 8 or m == 10 or m == 12:
      return 31
    elif m == 4 or m == 6 or m == 9 or m == 11:
      return 30
    elif m == 2:
      if leapYear(year):
        return 29
      else:
        return 28
  var r = cal.day
  for i in 1 ..< cal.month:
    r += daysInMonth(i, cal.year)
  return r

# Just add the interval to the event date
proc getSimpleNextInterval*(calendar: Calendar, rrule: RRule, timeZone: string): Calendar =
  result = calendar.copy()
  case rrule.freq
  of daily:
    result.add(TimeScale.Day, rrule.interval)
  of weekly:
    result.add(TimeScale.Day, 7 * rrule.interval)
  of monthly:
    result.add(TimeScale.Month, rrule.interval)
  of yearly:
    result.add(TimeScale.Year, rrule.interval)
  # Must do this to preserve the right hour past DST changes
  result.fixDST(timeZone)

# Get the end of this week, month, etc
proc getEndOfThisInterval*(calendar: Calendar, rrule: RRule, timeZone: string): Timestamp =
  var cal = calendar.copy()
  case rrule.freq
  of daily:
    cal.day += 1
  of weekly:
    let weekStart = (if rrule.weekStart == RRuleDay.none: RRuleDay.mo else: rrule.weekStart).int
    let diff = if weekStart > cal.weekDay: weekStart - cal.weekDay
               else: 7 - cal.weekDay + weekStart
    cal.day += diff
  of monthly:
    cal.day = 1
    cal.month += 1
  of yearly:
    cal.day = 1
    cal.month = 1
    cal.year += 1
  cal.trimDay()
  cal.normalize()
  # Must do this to preserve the right hour past DST changes
  cal.fixDST(timeZone)
  cal.ts

proc getNextIntervalStart*(calendar: Calendar, rrule: RRule, timeZone: string): Calendar =
  result = calendar.copy()
  # result.trimDay()
  case rrule.freq
  of daily:
    result.day += rrule.interval
  of weekly:
    let weekStart = (if rrule.weekStart == RRuleDay.none: RRuleDay.mo else: rrule.weekStart).int
    let diff = if weekStart > result.weekDay: weekStart - result.weekDay
               else: 7 - result.weekDay + weekStart
    result.day += 7 * (rrule.interval - 1) + diff
  of monthly:
    result.day = 1
    result.month += rrule.interval
  of yearly:
    result.day = 1
    result.month = 1
    result.year += rrule.interval
  # Must do this to preserve the right hour past DST changes
  result.normalize()
  result.fixDST(timeZone)

proc matchesRRule*(currentCal: Calendar, rrule: RRule): bool =
  if rrule.byDay.len > 0:
    var found = false
    for (requiredWeekDay, num) in rrule.byDay:
      if num == 0:
        if requiredWeekDay.int == currentCal.weekDay:
          found = true
          break
      elif num > 0: # Every num-th Wednesday of the month
        var count = 0
        var cal = currentCal.copy()
        cal.day = 1
        if rrule.freq == yearly:
          cal.month = 1

        while (rrule.freq == yearly and cal.year == currentCal.year) or
              (rrule.freq == monthly and cal.month == currentCal.month):
          if cal.weekDay == requiredWeekDay.int:
            count += 1
            if count == num:
              break
          cal.add(TimeScale.Day, 1)
        if cal.month == currentCal.month and cal.day == currentCal.day:
          found = true
          break
      else: # Every last -num-th Wednesday of the month
        var count = 0
        var cal = currentCal.copy()
        if rrule.freq == yearly:
          cal.month = 12
          cal.day = 31
        else:
          cal.day = cal.daysInMonth
        while (rrule.freq == yearly and cal.year == currentCal.year) or
              (rrule.freq == monthly and cal.month == currentCal.month):
          if cal.weekDay == requiredWeekDay.int:
            count += 1
            if count == -num:
              break
          cal.add(TimeScale.Day, -1)
        if cal.month == currentCal.month and cal.day == currentCal.day:
          found = true
          break
    if not found:
      return false
  if rrule.byMonth.len > 0 and not rrule.byMonth.contains(currentCal.month):
    return false
  if rrule.byMonthDay.len > 0:
    var matchesRule = false
    for day in rrule.byMonthDay:
      if day > 0 and day == currentCal.day:
        matchesRule = true
        break
      elif day < 0 and currentCal.day == (currentCal.daysInMonth + day + 1):
        matchesRule = true
        break
    if not matchesRule:
      return false
  if rrule.byYearDay.len > 0 and not rrule.byYearDay.contains(currentCal.dayOfYear()):
    return false

  return true

proc addMatchedEvent(self: var ParsedCalendar, ts: Timestamp, event: VEvent) =
  if self.result.len() > MAX_RESULT_COUNT:
    raise newException(ValueError, "Too many events in calendar. Increase MAX_RESULT_COUNT.")

  let key = event.uid & "/" & $ts
  if event.recurrenceId != "":
    self.rRuleProvided[key] = (ts, event)

  elif event.rrules.len() > 0:
    self.rRuleGenerated[key] = (ts, event)

  else:
    self.result.add((ts, event))

proc applyRRule(self: var ParsedCalendar, startTs: Timestamp, endTs: Timestamp, event: VEvent,
    rrule: RRule) =
  let timeZone = if event.timeZone == "": self.timeZone else: event.timeZone
  let duration = event.endTs.float - event.startTs.float
  var
    currentTs = event.startTs
    currentCal = currentTs.calendar(timeZone)
    newEndTs = event.endTs

  let simpleRepeat = rrule.byDay.len == 0 and rrule.byMonth.len == 0 and rrule.byMonthDay.len == 0 and
      rrule.byYearDay.len == 0 and rrule.byWeekNo.len == 0
  var nextIntervalStart: Calendar
  var counter = 0

  # Loop between intervals
  while (rrule.until == 0.Timestamp or currentTs <= rrule.until) and
        (rrule.count == 0 or counter < rrule.count) and
        currentTs <= endTs:

    if simpleRepeat:
      nextIntervalStart = getSimpleNextInterval(currentCal, rrule, timeZone)
      if currentTs <= endTs and newEndTs >= startTs:
        self.addMatchedEvent(currentTs, event)
        counter += 1

    # Need to loop over every day to handle BYDAY, BYMONTH, BYMONTHDAY, etc.
    else:
      nextIntervalStart = getNextIntervalStart(currentCal, rrule, timeZone)
      let intervalEnd = getEndOfThisInterval(currentCal, rrule, timeZone)
      # echo "==="
      # echo "Weekstart: " & $rrule.weekStart
      # echo "Current ts: " & $currentTs & " " & currentTs.formatIso()
      # echo "New end tS: " & $newEndTs & " " & newEndTs.formatIso()
      # echo "Interval end: " & $intervalEnd & " " & intervalEnd.formatIso()
      # echo "Next interval: " & $nextIntervalStart.ts & " " & nextIntervalStart.ts.formatIso()
      while (rrule.until == 0.Timestamp or currentTs <= rrule.until) and
            (rrule.count == 0 or counter < rrule.count) and
            currentTs < intervalEnd and
            currentTs < endTs:

        if currentCal.matchesRRule(rrule) and currentTs <= endTs and newEndTs >= startTs and
            not event.exDates.contains(currentTs):
          self.addMatchedEvent(currentTs, event)
          counter += 1

        currentCal.add(TimeScale.Day, 1)
        currentCal.fixDST(timeZone)
        currentTs = currentCal.ts
        newEndTs = (currentTs.float + duration).Timestamp

    currentCal = nextIntervalStart
    currentTs = currentCal.ts
    newEndTs = (currentTs.float + duration).Timestamp

proc getEvents*(self: var ParsedCalendar, startTs: Timestamp, endTs: Timestamp, search: string = "",
    maxCount: int = 1000): EventsSeq =
  for event in self.events:
    if search != "" and not event.summary.contains(search):
      continue

    for rrule in event.rrules:
      self.applyRRule(startTs, endTs, event, rrule)

    if event.rrules.len == 0 and event.startTs <= endTs and event.endTs >= startTs:
      self.addMatchedEvent(event.startTs, event)

  # dedupe rrule results and standalone results
  for key, (ts, event) in self.rRuleProvided.pairs():
    if self.rRuleGenerated.hasKey(key):
      self.rRuleGenerated.del(key)
    self.result.add((ts, event))
  for key, (ts, event) in self.rRuleGenerated.pairs():
    self.result.add((ts, event))

  self.result.sort(cmp)

  if maxCount > 0 and self.result.len > maxCount:
    self.result = self.result[0..<maxCount]
  return self.result
