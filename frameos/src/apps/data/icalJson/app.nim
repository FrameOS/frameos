import pixie
import times
import options
import json
import strutils
import frameos/apps
import frameos/types
import chrono

import ./ical

type
  AppConfig* = object
    ical*: string
    exportFrom*: string
    exportUntil*: string
    exportCount*: int
    search*: string
    addLocation*: bool
    addUrl*: bool
    addDescription*: bool
    addTimezone*: bool

  App* = ref object of AppRoot
    appConfig*: AppConfig

# Parse "this/last/next day|week|month|year" into start/end of that period (in tz),
# falling back to plain "YYYY-MM-DD" parsing if pattern doesn't match.
proc parsePeriodBoundary*(value, tzName: string; isStart: bool): Timestamp =
  let s = value.strip.toLowerAscii
  if s.len == 0:
    return epochTime().Timestamp

  let parts = s.splitWhitespace
  if parts.len == 2 and (parts[0] in ["this", "last", "next"]) and (parts[1] in ["day", "week", "month", "year"]):
    var cal = calendar(epochTime().Timestamp, tzName)
    let scale = parseTimeScale(parts[1]) # Day/Week/Month/Year
    case parts[0]
    of "last": cal.sub(scale, 1)
    of "next": cal.add(scale, 1)
    else: discard # "this"
    if isStart: cal.toStartOf(scale) else: cal.toEndOf(scale)
    return cal.ts

  return parseTs("{year/4}-{month/2}-{day/2}", value, tzName)

proc get*(self: App; context: ExecutionContext): JsonNode =
  result = %*[]
  if self.appConfig.iCal.startsWith("http"):
    self.logError "Pass in iCal data as a string, not a URL."
    return
  if self.appConfig.iCal == "":
    self.logError "No iCal data provided."
    return

  let timezone = if self.frameConfig.timeZone != "": self.frameConfig.timeZone else: "UTC"

  let startTs =
    if self.appConfig.exportFrom == "":
      epochTime().Timestamp
    else:
      parsePeriodBoundary(self.appConfig.exportFrom, timezone, true)

  let endTs =
    if self.appConfig.exportUntil == "":
      (epochTime() + 366.0 * 24.0 * 60.0 * 60.0).Timestamp
    else:
      parsePeriodBoundary(self.appConfig.exportUntil, timezone, false)

  var parsedCalendar: ParsedCalendar
  try:
    parsedCalendar = parseICalendar(self.appConfig.iCal, timezone)
  except CatchableError as e:
    self.logError "Error parsing iCal: " & $e.msg
    return

  let matchedEvents = getEvents(parsedCalendar, startTs, endTs, self.appConfig.search, self.appConfig.exportCount)
  var eventsReply: JsonNode = %[]
  for (time, event) in matchedEvents:
    let startTime = if event.fullDay: time.format("{year/4}-{month/2}-{day/2}", parsedCalendar.timeZone)
                    else: time.format("{year/4}-{month/2}-{day/2}T{hour/2}:{minute/2}:{second/2}",
                        parsedCalendar.timeZone)
    let endTimeFloat = time.float + (event.endTs.float - event.startTs.float) - (if event.fullDay: 0.001 else: 0.0) + (
        if event.fullDay and event.startTs == event.endTs: 86400.0 else: 0.0)
    let endTime = if event.fullDay: endTimeFloat.Timestamp.format("{year/4}-{month/2}-{day/2}", parsedCalendar.timeZone)
                  else: endTimeFloat.Timestamp.format("{year/4}-{month/2}-{day/2}T{hour/2}:{minute/2}:{second/2}",
                        parsedCalendar.timeZone)
    let jsonEvent = %*{
      "summary": event.summary,
      "startTime": startTime,
      "endTime": endTime,
    }
    if event.location != "" and self.appConfig.addLocation:
      jsonEvent["location"] = %*event.location
    if event.url != "" and self.appConfig.addUrl:
      jsonEvent["url"] = %*event.url
    if event.description != "" and self.appConfig.addDescription:
      jsonEvent["description"] = %*event.description
    if self.appConfig.addTimezone:
      jsonEvent["timezone"] = %*(if event.timeZone == "": parsedCalendar.timeZone else: event.timeZone)
    eventsReply.add(jsonEvent)
  self.log(%*{"event": "reply", "eventsInRange": len(eventsReply)})
  return eventsReply
