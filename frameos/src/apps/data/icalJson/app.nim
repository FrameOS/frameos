import pixie
import times
import options
import json
import strutils
import frameos/apps
import frameos/types
import chrono
import frameos/utils/period

import ./ical

type
  AppConfig* = object
    ## `ical` is a Spool, not a string: an ICS feed is the one input in the
    ## app library that is routinely multi-MB while its output is a handful of
    ## events. Declaring `byteIter` in config.json is what makes the loader
    ## hand it over without materializing (docs/value-pipeline.md, phase 2).
    ical*: Spool
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

proc get*(self: App; context: ExecutionContext): JsonNode =
  result = %*[]
  if self.appConfig.iCal.len == 0:
    self.logError "No iCal data provided."
    return
  # A URL instead of a document is the classic misconfiguration; catching it
  # needs the first few bytes, never the whole body.
  if self.appConfig.iCal.startsWithBytes("http"):
    self.logError "Pass in iCal data as a string, not a URL."
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
    # The export window doubles as the fold's keep-window: a multi-year feed
    # keeps only the window's events (plus recurring masters) resident.
    parsedCalendar = parseICalendar(self.appConfig.iCal, timezone,
      keepFrom = startTs, keepUntil = endTs)
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
