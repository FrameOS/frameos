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
  Event = object
    startDate: string
    endDate: string
    location: string
    description: string
    title: string

proc parseICalendar(content: string): seq[Event] =
  let lines = content.splitLines()
  var events: seq[Event] = @[]
  var currentEvent: Event
  var inEvent = false

  for line in lines:
    let trimmedLine = line.strip()
    if trimmedLine.startsWith("BEGIN:VEVENT"):
      inEvent = true
      currentEvent = Event()
    elif trimmedLine.startsWith("END:VEVENT"):
      inEvent = false
      events.add(currentEvent)
    elif inEvent:
      let arr = trimmedLine.split(":", 2)
      let key = arr[0]
      let value = arr[1]
      case key
      of "DTSTART":
        currentEvent.startDate = value
      of "DTEND":
        currentEvent.endDate = value
      of "LOCATION":
        currentEvent.location = value
      of "SUMMARY":
        currentEvent.title = value
      of "DESCRIPTION":
        currentEvent.description = value
      else:
        continue

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
    var client = newHttpClient(timeout = 60000)

    try:
      self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:request", "url": self.appConfig.url})
      let response = client.request(self.appConfig.url, httpMethod = HttpGet)
      if response.code != Http200:
        try:
          let json = parseJson(response.body)
          let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
          self.error("Error making request " & $response.status & ": " & error)
        except:
          self.error "Error making request " & $response.status & ": " & response.body
        return

      let text = response.body

      self.log text

      self.log $parseICalendar(text)


      self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:reply", "reply": text})
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
