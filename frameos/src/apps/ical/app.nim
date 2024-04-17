import pixie
import times
import options
import json
import strformat
import httpclient
from frameos/utils/image import scaleAndDrawImage
import frameos/types
import strutils, sequtils

type
  AppConfig* = object
    url*: string
    cacheSeconds*: float
    stateKey*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedReply: string
    cachedUrl: string

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
    cachedReply: "",
    cacheExpiry: 0.0,
    cachedUrl: "",
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"openai:{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"openai:{self.nodeId}:error", "error": message})
  self.scene.state[self.appConfig.stateKey] = %*(&"Error: {message}")

type
  Event* = object
    startDate*: string
    endDate*: string
    location*: string
    description*: string
    title*: string

proc toUTC(localDateTime: DateTime, tzInfo: string): DateTime =
  # Placeholder for timezone conversion, implement using a library if available.
  localDateTime # .toTimezone(getTimezone(tzInfo)).toUniversal()

proc extractTimeZone(dateTimeStr: string): string =
  if dateTimeStr.startsWith("TZID="):
    let parts = dateTimeStr.split(":")
    parts[0].split("=")[1]
  else:
    "UTC" # Assume UTC if no timezone is specified

proc parseDateTime(dateTimeStr: string): DateTime =
  let cleanDateTimeStr = if dateTimeStr.contains(";"):
    dateTimeStr.split(";")[1]
  elif dateTimeStr.contains(":"):
    dateTimeStr.split(":")[1]
  else:
    dateTimeStr

  let hasZ = cleanDateTimeStr.endsWith("Z")
  let finalDateTimeStr = if hasZ: cleanDateTimeStr[0 ..< ^1] else: cleanDateTimeStr
  let format = if 'T' in finalDateTimeStr: "yyyyMMdd'T'HHmmss" else: "yyyyMMdd"

  try:
    let parsedDate = finalDateTimeStr.parse(format, utc())
    return if hasZ: parsedDate else: parsedDate # .toLocal() # Convert to local time if 'Z' is not present
  except ValueError as e:
    raise newException(TimeParseError, "Failed to parse datetime string: " & dateTimeStr &
      ". Error: " & e.msg)

proc processLine*(line: string, currentEvent: var Event, inEvent: var bool, events: var seq[Event]) =
  if line.startsWith("BEGIN:VEVENT"):
    inEvent = true
    currentEvent = Event()
  elif line.startsWith("END:VEVENT"):
    inEvent = false
    events.add(currentEvent)
  elif inEvent:
    echo "Processing line: ", line
    let arr = line.split({';', ':'}, 1)
    echo arr
    if arr.len > 1:
      let key = arr[0] # Handle keys like "DTSTART;TZID=Europe/Brussels"
      let value = arr[1]
      echo "Key: ", key, ", Value: ", value
      case key
      of "DTSTART", "DTEND":
        let dateTimeValue = parseDateTime(value)
        let tzInfo = extractTimeZone(value)
        let tzstring = "yyyy-MM-dd'T'HH:mm:ss"
        let dateTime = &"{dateTimeValue.format(tzstring)} {tzInfo}"
        if key == "DTSTART":
          currentEvent.startDate = dateTime
        else:
          currentEvent.endDate = dateTime
      of "LOCATION":
        currentEvent.location = value
      of "SUMMARY":
        currentEvent.title = value
      of "DESCRIPTION":
        currentEvent.description = value
      else:
        return

proc parseICalendar*(content: string): seq[Event] =
  let lines = content.splitLines()
  var events: seq[Event] = @[]
  var currentEvent: Event
  var inEvent = false
  var propertyAccumulator = ""

  for i, line in lines:
    if line.len > 0 and (line[0] == ' ' or line[0] == '\t'):
      propertyAccumulator.add(line[1..^1])
      continue
    if propertyAccumulator != "":
      processLine(propertyAccumulator.strip(), currentEvent, inEvent, events)
      propertyAccumulator = ""
    propertyAccumulator = line

  if propertyAccumulator != "":
    processLine(propertyAccumulator.strip(), currentEvent, inEvent, events)

  return events

proc run*(self: App, context: ExecutionContext) =
  if self.appConfig.url == "":
    self.error("No url provided in app config.")
    return

  var reply = ""
  if self.appConfig.cacheSeconds > 0 and self.cachedReply != "" and
      self.cacheExpiry > epochTime() and self.cachedUrl == self.appConfig.url:
    reply = self.cachedReply
  else:
    # var client = newHttpClient(timeout = 60000)

    # try:
    #   self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:request", "url": self.appConfig.url})
    #   let response = client.request(self.appConfig.url, httpMethod = HttpGet)
    #   if response.code != Http200:
    #     try:
    #       let json = parseJson(response.body)
    #       let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
    #       self.error("Error making request " & $response.status & ": " & error)
    #     except:
    #       self.error "Error making request " & $response.status & ": " & response.body
    #     return
    self.error "Error making stuff"

    #   let text = response.body

    #   self.log text

    #   # self.log $parseICalendar(text)


    #   self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:reply", "reply": text})
    # except CatchableError as e:
    #   self.error "iCal fetch error: " & $e.msg
    # finally:
    #   client.close()

    if self.appConfig.cacheSeconds > 0:
      self.cachedReply = reply
      self.cachedUrl = self.appConfig.url
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds

  if reply != "":
    self.scene.state[self.appConfig.stateKey] = %*(reply)
