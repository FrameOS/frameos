import pixie
import times
import options
import json
import strformat
import httpclient
import frameos/types
import chrono

import ./ical

type
  AppConfig* = object
    url*: string
    cacheSeconds*: float
    stateKey*: string
    exportFrom*: string
    exportUntil*: string
    exportCount*: int

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedEvents: seq[VEvent]
    cachedUrl: string

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
    cachedEvents: @[],
    cacheExpiry: 0.0,
    cachedUrl: "",
  )
  scene.state[appConfig.stateKey] = %[]

proc log*(self: App, message: string) =
  echo message
  self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  echo message
  self.scene.logger.log(%*{"event": &"ical:{self.nodeId}:error", "error": message})
  self.scene.state[self.appConfig.stateKey] = %*(&"Error: {message}")

proc run*(self: App, context: ExecutionContext) =
  if self.appConfig.url == "":
    self.error("No url provided in app config.")
    return

  if self.appConfig.cacheSeconds > 0 and self.cacheExpiry > epochTime() and self.cachedUrl == self.appConfig.url:
    self.log "Cached"
  else:
    self.log "Fetching"
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
      self.cachedEvents = parseICalendar(response.body)
      self.cachedUrl = self.appConfig.url
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds
    except CatchableError as e:
      self.error "iCal fetch error: " & $e.msg
    finally:
      client.close()

    let timezone = now().timezone()
    let exportFrom = (if self.appConfig.exportFrom != "": parse(self.appConfig.exportFrom, "yyyy-MM-dd",
        timezone) else: now()).toTime().toUnixFloat().Timestamp
    var exportUntil = if self.appConfig.exportUntil != "": parse(self.appConfig.exportUntil, "yyyy-MM-dd",
        timezone).toTime().toUnixFloat().Timestamp else: 0.Timestamp
    let matchedEvents = getEvents(self.cachedEvents, exportFrom, exportUntil, self.appConfig.exportCount)
    var eventsReply: JsonNode = %[]
    for (time, event) in matchedEvents:
      let jsonEvent = %*{
        "summary": event.summary,
        "startTime": time.format("yyyy-MM-dd'T'HH:mm:ss"),
        "endTime": (time.float + (event.endTime.float - event.startTime.float)).TimeStamp.format(
            "yyyy-MM-dd'T'HH:mm:ss"),
        "location": event.location,
        "description": event.description,
      }
      eventsReply.add(jsonEvent)
    self.scene.logger.log(%*{"event": &"ical:reply", "events": len(self.cachedEvents), "inRange": len(eventsReply)})
    self.scene.logger.log(%*{"event": &"ical:reply", "reply": eventsReply})
    self.scene.state[self.appConfig.stateKey] = eventsReply
