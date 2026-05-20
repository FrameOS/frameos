import json, strformat, options, strutils, times, httpclient
import frameos/apps
import frameos/types
import frameos/runtime_diagnostics
import frameos/utils/http_client

const
  RequestTimeoutMs = 10000
  MaxResponseBytes = 1024 * 1024
  MaxResponseSeconds = 15.0
  MinimumFetchIntervalSeconds = 1.0

type
  AppConfig* = object
    entityId*: string
    debug*: bool

  App* = ref object of AppRoot
    appConfig*: AppConfig
    lastFetchAt*: float
    json*: Option[JsonNode]

proc error*(self: App, message: string): JsonNode =
  self.logError(message)
  return %*{"error": message}

proc get*(self: App, context: ExecutionContext): JsonNode =
  let sceneId = if self.scene.isNil: "" else: self.scene.id.string
  let contextEvent = if context.isNil: "" else: context.event
  let diagnosticsEnabled = self.frameConfig.debug
  if diagnosticsEnabled:
    markRuntimeCheckpoint("app:get", currentSceneId = sceneId, contextEvent = contextEvent,
      nodeId = self.nodeId.int, nodeType = "app", keyword = self.nodeName)
  defer:
    if diagnosticsEnabled:
      markRuntimeCheckpoint("app:get:done", currentSceneId = sceneId, contextEvent = contextEvent,
        nodeId = self.nodeId.int, nodeType = "app", keyword = self.nodeName)

  let haUrl = self.frameConfig.settings{"homeAssistant"}{"url"}.getStr
  if haUrl == "":
    return self.error("Please provide a Home Assistant URL in the settings.")
  let accessToken = self.frameConfig.settings{"homeAssistant"}{"accessToken"}.getStr
  if accessToken == "":
    return self.error("Please provide a Home Assistant access token in the settings.")

  if self.json.isSome and self.lastFetchAt + MinimumFetchIntervalSeconds > epochTime():
    return copy(self.json.get())

  let headers = newHttpHeaders([
        ("Authorization", "Bearer " & accessToken),
        ("Accept", "application/json"),
        ("Accept-Encoding", "identity"),
        ("Connection", "close")
  ])
  var slashlessUrl = haUrl
  slashlessUrl.removeSuffix("/")
  let url = &"{slashlessUrl}/api/states/{self.appConfig.entityId}"
  if self.appConfig.debug:
    self.log("Fetching Home Assistant status from " & url)

  try:
    let responseBody = boundedGetContent(url,
      headers = headers,
      timeoutMs = RequestTimeoutMs,
      maxBytes = MaxResponseBytes,
      maxSeconds = MaxResponseSeconds)
    let responseJson = parseJson(responseBody)
    self.json = some(copy(responseJson))
    self.lastFetchAt = epochTime()
    if self.appConfig.debug:
      self.log($responseJson)
    return responseJson
  except CatchableError as e:
    return self.error "Error fetching Home Assistant status: " & $e.msg
