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

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): JsonNode =
  result = %*[]
  if self.appConfig.iCal.startsWith("http"):
    self.logError "Pass in iCal data as a string, not a URL."
    return
  if self.appConfig.iCal == "":
    self.logError "No iCal data provided."
    return

  let timezone = "UTC"
  let startTs = if self.appConfig.exportFrom == "": epochTime().Timestamp
                else: parseTs("{year/4}-{month/2}-{day/2}", self.appConfig.exportFrom, timezone)
  let endTs = if self.appConfig.exportUntil == "": (epochTime() + 366 * 24 * 60 * 60).Timestamp
              else: parseTs("{year/4}-{month/2}-{day/2}", self.appConfig.exportUntil, timezone)

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
    let endTimeFloat = time.float + (event.endTs.float - event.startTs.float) - (if event.fullDay: 0.001 else: 0.0)
    let endTime = if event.fullDay: endTimeFloat.Timestamp.format("{year/4}-{month/2}-{day/2}", parsedCalendar.timeZone)
                  else: endTimeFloat.Timestamp.format("{year/4}-{month/2}-{day/2}T{hour/2}:{minute/2}:{second/2}",
                        parsedCalendar.timeZone)
    let jsonEvent = %*{
      "summary": event.summary,
      "startTime": startTime,
      "endTime": endTime,
    }
    if event.location != "":
      jsonEvent["location"] = %*event.location
    if event.description != "":
      jsonEvent["description"] = %*event.description
    if event.url != "":
      jsonEvent["url"] = %*event.url
    eventsReply.add(jsonEvent)
  self.log(%*{"event": "reply", "eventsInRange": len(eventsReply)})
  return eventsReply
