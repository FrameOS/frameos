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

    let exportFrom = getTime().toUnixFloat().Timestamp
    let exportUntil = (getTime().toUnixFloat() + 7 * 86400.0).Timestamp
    var eventsReply: JsonNode = %[]
    for event in self.cachedEvents:
      if (event.startTime < exportUntil and event.endTime > exportFrom):
        eventsReply.add(%*{
          "summary": event.summary,
          "startTime": event.startTime.float,
          "endTime": event.endTime.float,
          "location": event.location,
          "description": event.description,
          # "rrule": event.rrule,
        })
    self.scene.logger.log(%*{"event": &"ical:reply", "events": len(self.cachedEvents), "inRange": len(eventsReply)})
    self.scene.logger.log(%*{"event": &"ical:reply", "reply": eventsReply})
    self.scene.state[self.appConfig.stateKey] = eventsReply
