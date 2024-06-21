import json, strformat, options, strutils
import lib/httpclient
import frameos/types

type
  AppConfig* = object
    entityId*: string
    debug*: bool

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig


proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "legacy/haSensor:log", "message": message})

proc error*(self: App, message: string): JsonNode =
  self.scene.logger.log(%*{"event": "legacy/haSensor:error", "error": message})
  return %*{"error": message}

proc get*(self: App, context: ExecutionContext): JsonNode =
  let haUrl = self.frameConfig.settings{"homeAssistant"}{"url"}.getStr
  if haUrl == "":
    return self.error("Please provide a Home Assistant URL in the settings.")
  let accessToken = self.frameConfig.settings{"homeAssistant"}{"accessToken"}.getStr
  if accessToken == "":
    return self.error("Please provide a Home Assistant access token in the settings.")

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

    try:
      let response = client.request(url)
      if response.code != Http200:
        return self.error "Error fetching Home Assistant status: HTTP " & $response.status

      let responseJson = parseJson(response.body)
      if self.appConfig.debug:
        self.log($responseJson)
      return responseJson

    except CatchableError as e:
      return self.error "Error fetching Home Assistant status: " & $e.msg

  finally:
    client.close()
