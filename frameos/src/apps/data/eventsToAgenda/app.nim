import frameos/apps
import frameos/types
import json
import strformat
import strutils
import sequtils
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

proc get*(self: App, context: ExecutionContext): string =
  let title = &"^({self.appConfig.titleFontSize},{self.appConfig.titleColor.toHtmlHex()})"
  let normal = &"^({self.appConfig.baseFontSize},{self.appConfig.textColor.toHtmlHex()})"
  let time = &"^({self.appConfig.baseFontSize},{self.appConfig.timeColor.toHtmlHex()})"
  let events = self.appConfig.events
  let timezone = self.getTimezone(events)
  let todayTs = epochTime().Timestamp
  let today = format(todayTs, titleFormat, tzName = timezone)

  proc h1(text: string): string = &"{title}{text}\n{normal}\n"
  proc formatDay(day: string): string = format(parseTs("{year/4}-{month/2}-{day/2}", day), titleFormat)

  var currentDay = format(todayTs, "{year/4}-{month/2}-{day/2}", tzName = timezone)

  result = h1(today)

  if events == nil or events.kind != JArray or events.len == 0:
    result &= &"No events found\n"
    return

  var hasAny = false
  for obj in events.items():
    let summary = obj{"summary"}.getStr()
    let startDay = obj{"startTime"}.getStr()
    let endDay = obj{"endTime"}.getStr()
    let withTime = "T" in startDay
    let startDate = startDay.split("T")[0]

    if startDate > currentDay:
      if not hasAny:
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
