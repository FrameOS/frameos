import pixie
import times
import options
import json
import strformat
import httpclient
from frameos/utils/image import scaleAndDrawImage
import frameos/types
import strutils, sequtils
import chrono

type
  AppConfig* = object
    url*: string
    cacheSeconds*: float
    stateKey*: string
    exportFrom*: string
    exportUntil*: string

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
  echo message
  self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  echo message
  self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:error", "error": message})
  self.scene.state[self.appConfig.stateKey] = %*(&"Error: {message}")

type
  Event* = object
    startDate*: Timestamp
    endDate*: Timestamp
    location*: string
    description*: string
    title*: string
    rrule*: string

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

proc processLine*(line: string, currentEvent: var Event, inEvent: var bool, events: var seq[Event]) =
  if line.startsWith("BEGIN:VEVENT"):
    inEvent = true
    currentEvent = Event()
  elif line.startsWith("END:VEVENT"):
    inEvent = false
    events.add(currentEvent)
  elif inEvent:
    let arr = line.split({';', ':'}, 1)
    if arr.len > 1:
      let key = arr[0]
      let value = arr[1]
      case key
      of "DTSTART", "DTEND":
        let tzInfo = extractTimeZone(value)
        let timestamp = parseDateTime(value, tzInfo)
        if key == "DTSTART":
          currentEvent.startDate = timestamp
        else:
          currentEvent.endDate = timestamp
      of "LOCATION":
        currentEvent.location = unescape(value)
      of "SUMMARY":
        currentEvent.title = unescape(value)
      of "RRULE":
        currentEvent.rrule = unescape(value)
      of "DESCRIPTION":
        currentEvent.description = unescape(value)
      else:
        return

proc parseICalendar*(content: string): seq[Event] =
  let lines = content.splitLines()
  var events: seq[Event] = @[]
  var currentEvent: Event
  var inEvent = false
  var accumulator = ""

  for i, line in lines:
    if line.len > 0 and (line[0] == ' ' or line[0] == '\t'):
      accumulator.add(line[1..^1])
      continue
    if accumulator != "":
      processLine(accumulator.strip(), currentEvent, inEvent, events)
      accumulator = ""
    accumulator = line
  if accumulator != "":
    processLine(accumulator.strip(), currentEvent, inEvent, events)

  return events

proc run*(self: App, context: ExecutionContext) =
  if self.appConfig.url == "":
    self.error("No url provided in app config.")
    return

  var reply = ""
  if self.appConfig.cacheSeconds > 0 and self.cachedReply != "" and
      self.cacheExpiry > epochTime() and self.cachedUrl == self.appConfig.url:
    self.log "Cached"
    reply = self.cachedReply
  else:
    self.log "Starting"
    var client = newHttpClient(timeout = 60000)
    try:
      self.scene.logger.log(%*{"event": &"ical:request", "url": self.appConfig.url})
      let response = client.request(self.appConfig.url, httpMethod = HttpGet)
      self.log "Code: " & $response.code
      if response.code != Http200:
        try:
          let json = parseJson(response.body)
          let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
          self.error("Error making request " & $response.status & ": " & error)
        except:
          self.error "Error making request " & $response.status & ": " & response.body
        return
      let text = response.body
      let entries = parseICalendar(text)
      reply = $entries
      self.scene.logger.log(%*{"event": &"ical:reply", "reply": reply})
    except CatchableError as e:
      self.error "iCal fetch error: " & $e.msg
    finally:
      client.close()

    if self.appConfig.cacheSeconds > 0:
      self.cachedReply = reply
      self.cachedUrl = self.appConfig.url
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds

  if reply != "":
    self.scene.state[self.appConfig.stateKey] = %*(reply)
