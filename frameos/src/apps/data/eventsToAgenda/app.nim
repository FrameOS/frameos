import frameos/types
import json
import strformat
import strutils
import algorithm
import chrono
import times
import pixie

type
  AppConfig* = object
    events*: JsonNode
    baseFontSize*: float
    titleFontSize*: float
    textColor*: Color
    timeColor*: Color
    titleColor*: Color
    startWithToday*: bool

  App* = ref object of AppRoot
    appConfig*: AppConfig

const titleFormat = "{weekday}, {month/n} {day}"

proc getTimezone*(self: App, json: JsonNode): string =
  result = "UTC"
  if json.kind == JArray:
    for result in json.items():
      if result{"timezone"}.getStr() != "":
        return result{"timezone"}.getStr()
  if self.frameConfig.timeZone != "":
    return self.frameConfig.timeZone

proc formatFontSize(value: float): string =
  var formatted = value.formatFloat(ffDecimal, 6)
  while formatted.len > 0 and formatted[^1] == '0':
    formatted.setLen(formatted.len - 1)
  if formatted.len > 0 and formatted[^1] == '.':
    formatted.setLen(formatted.len - 1)
  if formatted.len == 0:
    return "0"
  result = formatted

proc get*(self: App, context: ExecutionContext): string =
  let title = &"^({formatFontSize(self.appConfig.titleFontSize)},{self.appConfig.titleColor.toHtmlHex()})"
  let normal = &"^({formatFontSize(self.appConfig.baseFontSize)},{self.appConfig.textColor.toHtmlHex()})"
  let time = &"^({formatFontSize(self.appConfig.baseFontSize)},{self.appConfig.timeColor.toHtmlHex()})"
  let events = self.appConfig.events
  let timezone = self.getTimezone(events)

  proc h1(text: string): string = &"{title}{text}\n{normal}\n"
  proc formatDay(day: string): string = format(parseTs("{year/4}-{month/2}-{day/2}", day), titleFormat)

  let noEvents = events == nil or events.kind != JArray or events.len == 0

  result = ""

  var currentDay = ""
  if self.appConfig.startWithToday or noEvents:
    let todayTs = epochTime().Timestamp
    result &= h1(format(todayTs, titleFormat, tzName = timezone))
    currentDay = format(todayTs, "{year/4}-{month/2}-{day/2}", tzName = timezone)

  if noEvents:
    result &= &"No events found\n"
    return

  let sortedEvents = events.elems.sorted(
    proc (a, b: JsonNode): int = cmp(a["startTime"].getStr(), b["startTime"].getStr())
  )
  var hasAny = false
  for obj in sortedEvents:
    let summary = obj{"summary"}.getStr()
    let startDay = obj{"startTime"}.getStr()
    let endDay = obj{"endTime"}.getStr()
    let withTime = "T" in startDay
    let startDate = startDay.split("T")[0]

    if startDate != currentDay: # new day, past or future
      if not hasAny and startDate != currentDay and self.appConfig.startWithToday:
        result &= "No events today\n"
      result &= "\n" & h1(formatDay(startDate))
      currentDay = startDate

    hasAny = true

    if withTime:
      let startTime = if "T" in startDay: startDay.split("T")[1][0 .. 4] else: ""
      let endTime = if "T" in endDay: endDay.split("T")[1][0 .. 4] else: ""
      result &= &"{time}{startTime} - {endTime}  {normal}{summary}\n"
    else:
      if startDay == currentDay and endDay == currentDay:
        result &= &"{time}All day  {normal}{summary}\n"
      else:
        result &= &"{time}Until {formatDay(endDay)}  {normal}{summary}\n"
