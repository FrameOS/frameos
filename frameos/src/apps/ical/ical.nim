import pixie
import times
import tables
import strutils
import chrono

type
  PropertyComponents = object
    name: string
    params: Table[string, seq[string]]
    value: string

  RRuleFreq* = enum
    daily, weekly, monthly, yearly

  RRuleDay* = enum
    none = -1
    su = 0, mo, tu, we, th, fr, sa

  RRule* = object
    freq*: RRuleFreq
    interval*: int
    byDay*: seq[(RRuleDay, int)]
    byMonth*: seq[int]
    byMonthDay*: seq[int]
    until*: Timestamp
    count*: int
    weekStart*: RRuleDay

  VEvent* = ref object
    summary*: string
    description*: string
    startTime*: Timestamp
    endTime*: Timestamp
    location*: string
    rrules*: seq[RRule]

proc extractTimeZone(dateTimeStr: string): string =
  if dateTimeStr.startsWith("TZID="):
    let parts = dateTimeStr.split(":")
    parts[0].split("=")[1]
  else:
    "UTC"

proc parseDateTime(dateTimeStr: string, tzInfo: string): Timestamp =
  let cleanDateTimeStr = if dateTimeStr.contains(";"):
    dateTimeStr.split(";")[1]
  elif dateTimeStr.contains(":"):
    dateTimeStr.split(":")[1]
  else:
    dateTimeStr
  let hasZ = cleanDateTimeStr.endsWith("Z")
  let finalDateTimeStr = if hasZ: cleanDateTimeStr[0 ..< ^1] else: cleanDateTimeStr
  let format = if 'T' in finalDateTimeStr:
                  "{year/4}{month/2}{day/2}T{hour/2}{minute/2}{second/2}"
                else:
                  "{year/4}{month/2}{day/2}"
  try:
    return parseTs(format, finalDateTimeStr, tzInfo)
  except ValueError as e:
    raise newException(TimeParseError, "Failed to parse datetime string: " & dateTimeStr &
      ". Error: " & e.msg)

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

proc parseIcalLine(line: string): PropertyComponents =
  let splitPos = line.find(':')
  if splitPos == -1:
    raise newException(ValueError, "Invalid iCal line format, missing ':'.")

  let arr = line.split(':', 1)
  let (left, right) = (arr[0], arr[1])
  let nameAndParams = left.split(';')

  var components = PropertyComponents(name: nameAndParams[0].strip(), value: right.strip())
  components.params = initTable[string, seq[string]]()

  for i in 1 ..< nameAndParams.len:
    let paramPair = nameAndParams[i].split('=')
    if paramPair.len != 2:
      raise newException(ValueError, "Invalid parameter format.")
    components.params[paramPair[0].strip()] = paramPair[1].split(',')

  return components

proc processLine*(line: string, currentVEvent: var VEvent, inVEvent: var bool, events: var seq[VEvent]) =
  try:
    if line.startsWith("BEGIN:VEVENT"):
      inVEvent = true
      currentVEvent = VEvent()
    elif line.startsWith("END:VEVENT"):
      inVEvent = false
      events.add(currentVEvent)
    elif inVEvent:
      let splitPos = line.find(':')
      if splitPos == -1:
        return

      let arr = line.split({';', ':'}, 1)
      if arr.len > 1:
        let key = arr[0]
        let value = arr[1]
        case key
        of "DTSTART", "DTEND":
          let tzInfo = extractTimeZone(value)
          let timestamp = parseDateTime(value, tzInfo)
          if key == "DTSTART":
            currentVEvent.startTime = timestamp
          else:
            currentVEvent.endTime = timestamp
        of "LOCATION":
          currentVEvent.location = unescape(value)
        of "SUMMARY":
          currentVEvent.summary = unescape(value)
        of "RRULE":
          var rrule = RRule(weekStart: RRuleDay.none, byDay: @[], byMonth: @[], byMonthDay: @[])
          for split in arr[1].split(';'):
            echo split
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
              rrule.until = parseDateTime(keyValue[1], extractTimeZone(keyValue[1]))
            of "BYDAY":
              # "1SU"
              for day in keyValue[1].split(','):
                let dayNum = if day.len > 2: day[0..^2].parseInt() else: 0
                let day = day[^2..^1]
                case day.toUpper():
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
          currentVEvent.rrules.add(rrule)
        of "DESCRIPTION":
          currentVEvent.description = unescape(value)
        else:
          return
  except CatchableError as e:
    echo "Failed to parse calendar line \"" & line & "\". Error: " & e.msg

proc parseICalendar*(content: string): seq[VEvent] =
  let lines = content.splitLines()
  var events: seq[VEvent] = @[]
  var currentVEvent: VEvent
  var inVEvent = false
  var accumulator = ""

  for i, line in lines:
    if line.len > 0 and (line[0] == ' ' or line[0] == '\t'):
      accumulator.add(line[1..^1])
      continue
    if accumulator != "":
      processLine(accumulator.strip(), currentVEvent, inVEvent, events)
      accumulator = ""
    accumulator = line
  if accumulator != "":
    processLine(accumulator.strip(), currentVEvent, inVEvent, events)

  return events
