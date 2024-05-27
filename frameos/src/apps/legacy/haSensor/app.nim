import json, strformat, options, times, strutils
import lib/httpclient
import frameos/types

type
  AppConfig* = object
    entityId*: string
    stateKey*: string
    cacheSeconds*: float
    debug*: bool

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig
    lastFetchAt*: float
    json: Option[JsonNode]

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
    lastFetchAt: 0,
    json: none(JsonNode),
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "legacy/haSensor:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "legacy/haSensor:error", "error": message})

proc run*(self: App, context: ExecutionContext) =
  let haUrl = self.frameConfig.settings{"homeAssistant"}{"url"}.getStr
  if haUrl == "":
    self.error("Please provide a Home Assistant URL in the settings.")
    return
  let accessToken = self.frameConfig.settings{"homeAssistant"}{
      "accessToken"}.getStr
  if accessToken == "":
    self.error("Please provide a Home Assistant access token in the settings.")
    return

  var client = newHttpClient(timeout = 10000)
  try:
    client.headers = newHttpHeaders([
        ("Authorization", "Bearer " & accessToken),
        ("Content-Type", "application/json"),
        ("Content-Encoding", "gzip")
    ])
    var slashlessUrl = haUrl
    slashlessUrl.removeSuffix("/")
    let url = &"{slashlessUrl}/api/states/{self.appConfig.entityId}"
    if self.appConfig.debug:
      self.log("Fetching Home Assistant status from " & url)

    if self.json.isNone or self.lastFetchAt == 0 or self.lastFetchAt +
        self.appConfig.cacheSeconds < epochTime():
      try:
        let response = client.request(url)
        if response.code != Http200:
          self.error "Error fetching Home Assistant status: HTTP " &
              $response.status
          return
        self.json = some(parseJson(response.body))
        self.lastFetchAt = epochTime()
      except CatchableError as e:
        self.error "Error fetching Home Assistant status: " & $e.msg
        return

    if self.json.isSome:
      let stateKey = if self.appConfig.stateKey ==
          "": "state" else: self.appConfig.stateKey
      self.scene.state[stateKey] = self.json.get()
      if self.appConfig.debug:
        self.log($self.scene.state[stateKey])
    else:
      self.error "No JSON response from Home Assistant"
  finally:
    client.close()
