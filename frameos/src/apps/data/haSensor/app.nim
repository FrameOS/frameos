import json, strformat, options, strutils, times, uri
import frameos/apps
import frameos/types
import frameos/runtime_diagnostics
import frameos/utils/http_client

const
  RequestTimeoutMs = 10000
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

proc isHaEntityId*(value: string): bool =
  ## Home Assistant entity ids are `<domain>.<object_id>`, both halves
  ## `[a-z0-9_]+`. Anything else (a `/`, a `?`, a `..`) would be spliced
  ## into the request path and could steer the frame's HA token at a
  ## different endpoint — so the shape is enforced before the URL is built.
  let parts = value.split('.')
  if parts.len != 2:
    return false
  for part in parts:
    if part.len == 0:
      return false
    for ch in part:
      if ch notin {'a'..'z', '0'..'9', '_'}:
        return false
  true

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

  let headers: seq[SimpleHttpHeader] = @[
    (name: "Authorization", value: "Bearer " & accessToken),
    (name: "Accept", value: "application/json"),
    (name: "Accept-Encoding", value: "identity"),
  ]
  let entityId = self.appConfig.entityId.strip()
  if not isHaEntityId(entityId):
    return self.error("Invalid Home Assistant entity id \"" & entityId &
      "\": expected <domain>.<object_id> using only a-z, 0-9 and _.")
  var slashlessUrl = haUrl
  slashlessUrl.removeSuffix("/")
  let url = &"{slashlessUrl}/api/states/{encodeUrl(entityId, usePlus = false)}"
  if self.appConfig.debug:
    self.log("Fetching Home Assistant status from " & url)

  try:
    let response = boundedRequestWithHeaders(url,
      headers = headers,
      timeoutMs = RequestTimeoutMs,
      maxBytes = self.maxHttpResponseBytes(),
      maxSeconds = MaxResponseSeconds)
    if response.code >= 400:
      return self.error "Error fetching Home Assistant status: HTTP " & response.status & ": " & response.body
    let responseBody = response.body
    let responseJson = parseJson(responseBody)
    self.json = some(copy(responseJson))
    self.lastFetchAt = epochTime()
    if self.appConfig.debug:
      self.log($responseJson)
    return responseJson
  except CatchableError as e:
    return self.error "Error fetching Home Assistant status: " & $e.msg
