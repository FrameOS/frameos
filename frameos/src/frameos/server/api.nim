import json
import pixie
import chroma
import times
import std/[os, strformat, strutils, tables, algorithm]
import locks
import zippy
import mummy
import httpcore
import assets/apps as appsAsset
import drivers/drivers as drivers
import frameos/apps
import frameos/channels
import frameos/types
import frameos/utils/image
import frameos/utils/font
import frameos/config
import frameos/version
from frameos/metrics import defaultProcessMemoryUsage
from frameos/scenes import getLastImagePng, getLastPublicState, getAllPublicStates, getUploadedScenePayload,
    getDynamicSceneOptions
from scenes/scenes import sceneOptions
import ./embedded_assets
import ./state

proc h*(message: string): string =
  message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#039;")

proc s*(message: string): string =
  message.replace("'", "\\'").replace("\n", "\\n")

proc shouldReturnNotModified*(headers: httpcore.HttpHeaders, lastUpdate: float): bool {.gcsafe.} =
  if lastUpdate <= 0.0:
    return false
  let ifModifiedSince = seq[string](headers.getOrDefault("if-modified-since")).join(", ")
  if ifModifiedSince == "":
    return false
  try:
    let ifModifiedTime = parse(ifModifiedSince, "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    return int64(lastUpdate) <= ifModifiedTime.toTime().toUnix()
  except CatchableError:
    return false

proc shouldReturnNotModified*(headers: mummy.HttpHeaders, lastUpdate: float): bool {.gcsafe.} =
  if lastUpdate <= 0.0:
    return false
  var values: seq[string]
  for (name, value) in headers:
    if cmpIgnoreCase(name, "if-modified-since") == 0:
      values.add(value)
  let ifModifiedSince = values.join(", ")
  if ifModifiedSince == "":
    return false
  try:
    let ifModifiedTime = parse(ifModifiedSince, "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    return int64(lastUpdate) <= ifModifiedTime.toTime().toUnix()
  except CatchableError:
    return false

proc parseUrlEncoded*(body: string): Table[string, string] =
  for pair in body.split('&'):
    if pair == "":
      continue
    let kv = pair.split('=', 1)
    let key = decodeQueryComponent(kv[0])
    let value = if kv.len > 1: decodeQueryComponent(kv[1]) else: ""
    result[key] = value

proc jsonResponse*(request: Request, statusCode: httpcore.HttpCode, payload: JsonNode) =
  var headers: mummy.HttpHeaders
  headers["Content-Type"] = "application/json"
  request.respond(int(statusCode), headers, $payload)

proc loadConfigJson(): JsonNode =
  try:
    return parseFile(getConfigFilename())
  except CatchableError:
    return %*{}

proc activeScenesJsonPath*(): tuple[path: string, compressed: bool] =
  let configuredPath = getEnv("FRAMEOS_SCENES_JSON")
  if configuredPath.len > 0:
    return (path: configuredPath, compressed: configuredPath.endsWith(".gz"))
  if fileExists("./scenes.json.gz"):
    return (path: "./scenes.json.gz", compressed: true)
  if fileExists("./scenes.json"):
    return (path: "./scenes.json", compressed: false)
  (path: "./scenes.json.gz", compressed: true)

proc loadScenePayload(): JsonNode =
  var data = ""
  let source = activeScenesJsonPath()
  try:
    if source.path.len > 0 and fileExists(source.path):
      data = if source.compressed: uncompress(readFile(source.path)) else: readFile(source.path)
  except CatchableError:
    data = ""
  if data.len == 0:
    return %*[]
  try:
    let payload = parseJson(data)
    if payload.kind == JArray:
      return payload
  except JsonParsingError, CatchableError:
    discard
  return %*[]

proc fileModifiedIso(path: string): JsonNode =
  try:
    if path.len > 0 and fileExists(path):
      let modified = getFileInfo(path).lastWriteTime
      return %format(fromUnix(modified.toUnix()), "yyyy-MM-dd'T'HH:mm:ss'Z'", utc())
  except CatchableError:
    discard
  newJNull()

const frameSyncCurrentRevisionKey = "frame_sync_current_revision"
const frameSyncDeployedRevisionKey = "frame_sync_deployed_revision"
const frameSyncMarkDeployedKey = "frame_sync_mark_deployed"

proc nextFrameSyncRevision(frameApi: JsonNode): string =
  let previous = frameApi{frameSyncCurrentRevisionKey}.getStr("")
  let micros = int64(epochTime() * 1000000.0)
  result = "rev-" & $micros
  if result == previous:
    result = "rev-" & $(micros + 1)

proc shouldBumpFrameSyncRevision(payload: JsonNode): bool =
  if payload == nil or payload.kind != JObject or payload{frameSyncMarkDeployedKey}.getBool(false):
    return false
  for key in payload.keys:
    if key notin [
      "next_action",
      "skip_runtime_reload",
      frameSyncMarkDeployedKey,
      "last_successful_deploy",
      "last_successful_deploy_at",
    ]:
      return true
  false

proc ensureParentDir(path: string) =
  let dir = splitFile(path).dir
  if dir.len > 0 and not dirExists(dir):
    createDir(dir)

proc writeTextFileAtomically(path: string, body: string) =
  ensureParentDir(path)
  let tempPath = path & ".tmp"
  writeFile(tempPath, body)
  if fileExists(path):
    removeFile(path)
  moveFile(tempPath, path)

const frameAdminEditableSettingsFields = [
  ("frameOS", "apiKey"),
  ("openAI", "apiKey"),
  ("homeAssistant", "url"),
  ("homeAssistant", "accessToken"),
  ("github", "api_key"),
  ("unsplash", "accessKey"),
]

proc frameAdminSettingsSource(configJson: JsonNode): JsonNode =
  if configJson != nil and configJson.kind == JObject and configJson{"settings"} != nil and
      configJson{"settings"}.kind == JObject:
    return copy(configJson["settings"])
  if globalFrameConfig != nil and globalFrameConfig.settings != nil and globalFrameConfig.settings.kind == JObject:
    return copy(globalFrameConfig.settings)
  %*{}

proc frameAdminEditableSettingsPayload*(settings: JsonNode = nil): JsonNode =
  let source =
    if settings != nil and settings.kind == JObject:
      settings
    else:
      frameAdminSettingsSource(loadConfigJson())
  result = %*{}
  for (section, field) in frameAdminEditableSettingsFields:
    let sectionNode = source{section}
    if sectionNode != nil and sectionNode.kind == JObject and sectionNode.hasKey(field):
      if result{section} == nil or result{section}.kind != JObject:
        result[section] = %*{}
      result[section][field] = copy(sectionNode[field])

proc persistFrameAdminSettingsUpdate*(payload: JsonNode): JsonNode =
  if payload == nil or payload.kind != JObject:
    raise newException(ValueError, "Settings payload must be an object")

  let configPath = getConfigFilename()
  var configJson = loadConfigJson()
  if configJson == nil or configJson.kind != JObject:
    configJson = %*{}

  var settings = frameAdminSettingsSource(configJson)
  for (section, field) in frameAdminEditableSettingsFields:
    let sectionPayload = payload{section}
    if sectionPayload != nil and sectionPayload.kind == JObject and sectionPayload.hasKey(field):
      if settings{section} == nil or settings{section}.kind != JObject:
        settings[section] = %*{}
      settings[section][field] = copy(sectionPayload[field])

  configJson["settings"] = settings
  writeTextFileAtomically(configPath, pretty(configJson, indent = 4) & "\n")

  if globalFrameConfig != nil:
    globalFrameConfig.settings = copy(settings)
  if globalFrameOS != nil and globalFrameOS.frameConfig != nil:
    globalFrameOS.frameConfig.settings = copy(settings)

  frameAdminEditableSettingsPayload(settings)

proc putJsonIfPresent(target: JsonNode, source: JsonNode, sourceKey, targetKey: string) =
  if source.kind != JObject or not source.hasKey(sourceKey):
    return
  if source[sourceKey].kind == JNull:
    if target.kind == JObject and target.hasKey(targetKey):
      target.delete(targetKey)
  else:
    target[targetKey] = copy(source[sourceKey])

proc objectNodeOrEmpty(value: JsonNode): JsonNode =
  if value != nil and value.kind == JObject:
    return copy(value)
  %*{}

proc frontendHttpsProxyToRuntime(value: JsonNode, existing: JsonNode): JsonNode =
  result = objectNodeOrEmpty(existing)
  if value == nil or value.kind != JObject:
    return
  putJsonIfPresent(result, value, "enable", "enable")
  putJsonIfPresent(result, value, "port", "port")
  putJsonIfPresent(result, value, "expose_only_port", "exposeOnlyPort")
  if value.hasKey("certs") and value["certs"].kind == JObject:
    let certs = value["certs"]
    putJsonIfPresent(result, certs, "server", "serverCert")
    putJsonIfPresent(result, certs, "server_key", "serverKey")

proc frontendErrorBehaviorToRuntime(value: JsonNode, existing: JsonNode): JsonNode =
  result = objectNodeOrEmpty(existing)
  if value == nil or value.kind != JObject:
    return
  putJsonIfPresent(result, value, "mode", "mode")
  putJsonIfPresent(result, value, "retry_seconds", "retrySeconds")
  putJsonIfPresent(result, value, "silent_retry_seconds", "silentRetrySeconds")
  putJsonIfPresent(result, value, "silent_retry_forever", "silentRetryForever")
  putJsonIfPresent(result, value, "silent_window_minutes", "silentWindowMinutes")
  putJsonIfPresent(result, value, "show_error_retry_seconds", "showErrorRetrySeconds")

proc frontendFramePayloadToRuntimeConfig*(payload: JsonNode, existing: JsonNode): JsonNode =
  result = if existing != nil and existing.kind == JObject: copy(existing) else: %*{}
  if payload == nil or payload.kind != JObject:
    return

  for pair in [
    ("name", "name"),
    ("mode", "mode"),
    ("frame_host", "frameHost"),
    ("frame_port", "framePort"),
    ("frame_access_key", "frameAccessKey"),
    ("frame_access", "frameAccess"),
    ("server_host", "serverHost"),
    ("server_port", "serverPort"),
    ("server_api_key", "serverApiKey"),
    ("server_send_logs", "serverSendLogs"),
    ("width", "width"),
    ("height", "height"),
    ("device", "device"),
    ("device_config", "deviceConfig"),
    ("metrics_interval", "metricsInterval"),
    ("max_http_response_bytes", "maxHttpResponseBytes"),
    ("rotate", "rotate"),
    ("flip", "flip"),
    ("scaling_mode", "scalingMode"),
    ("image_engine", "imageEngine"),
    ("settings", "settings"),
    ("assets_path", "assetsPath"),
    ("save_assets", "saveAssets"),
    ("upload_fonts", "uploadFonts"),
    ("log_to_file", "logToFile"),
    ("debug", "debug"),
    ("timezone", "timeZone"),
    ("timezone_updater", "timeZoneUpdates"),
    ("schedule", "schedule"),
    ("gpio_buttons", "gpioButtons"),
    ("control_code", "controlCode"),
    ("network", "network"),
    ("agent", "agent"),
    ("mountpoints", "mountpoints"),
    ("palette", "palette"),
    ("interval", "interval"),
    ("background_color", "backgroundColor"),
    ("color", "color"),
    ("reboot", "reboot"),
    ("buildroot", "buildroot"),
    ("embedded", "embedded"),
    ("rpios", "rpios"),
  ]:
    putJsonIfPresent(result, payload, pair[0], pair[1])

  if payload.hasKey("frame_admin_auth"):
    putJsonIfPresent(result, payload, "frame_admin_auth", "frameAdminAuth")
  if payload.hasKey("https_proxy"):
    result["httpsProxy"] = frontendHttpsProxyToRuntime(payload["https_proxy"], result{"httpsProxy"})
  if payload.hasKey("error_behavior"):
    result["errorBehavior"] = frontendErrorBehaviorToRuntime(payload["error_behavior"], result{"errorBehavior"})

  var frameApi = if result{"frameApi"} != nil and result{"frameApi"}.kind == JObject: copy(result["frameApi"]) else: %*{}
  for key in payload.keys:
    if key != "next_action" and key != "skip_runtime_reload" and key != frameSyncMarkDeployedKey:
      frameApi[key] = copy(payload[key])
  if payload{frameSyncMarkDeployedKey}.getBool(false):
    var revision = payload{frameSyncCurrentRevisionKey}.getStr("")
    if revision.len == 0:
      revision = frameApi{frameSyncCurrentRevisionKey}.getStr("")
    if revision.len == 0:
      revision = nextFrameSyncRevision(frameApi)
    frameApi[frameSyncCurrentRevisionKey] = %revision
    frameApi[frameSyncDeployedRevisionKey] = %revision
  elif shouldBumpFrameSyncRevision(payload):
    let previousRevision = frameApi{frameSyncCurrentRevisionKey}.getStr("")
    if frameApi{frameSyncDeployedRevisionKey}.getStr("").len == 0:
      let deployedRevision = if previousRevision.len > 0: previousRevision else: "legacy-deploy"
      frameApi[frameSyncDeployedRevisionKey] = %deployedRevision
    frameApi[frameSyncCurrentRevisionKey] = %nextFrameSyncRevision(frameApi)
  elif frameApi{frameSyncCurrentRevisionKey}.getStr("").len == 0:
    let revision = nextFrameSyncRevision(frameApi)
    frameApi[frameSyncCurrentRevisionKey] = %revision
    if frameApi{frameSyncDeployedRevisionKey}.getStr("").len == 0:
      frameApi[frameSyncDeployedRevisionKey] = %revision
  result["frameApi"] = frameApi

proc persistScenesPayload*(scenes: JsonNode) =
  if scenes == nil or scenes.kind != JArray:
    return
  let target = activeScenesJsonPath()
  let prettyScenes = pretty(scenes, indent = 4) & "\n"
  let body = if target.compressed: compress(prettyScenes, dataFormat = dfGzip) else: prettyScenes
  writeTextFileAtomically(target.path, body)

proc persistFrameApiUpdate*(payload: JsonNode) =
  if payload == nil or payload.kind != JObject:
    raise newException(ValueError, "Frame update payload must be a JSON object")

  let configPath = getConfigFilename()
  let existing = loadConfigJson()
  let nextConfig = frontendFramePayloadToRuntimeConfig(payload, existing)
  if payload.hasKey("scenes"):
    persistScenesPayload(payload["scenes"])
  writeTextFileAtomically(configPath, pretty(nextConfig, indent = 4) & "\n")

proc frameControlCodeJson(controlCode: ControlCode): JsonNode =
  if controlCode == nil:
    return %*{}
  result = %*{
    "enabled": controlCode.enabled,
    "position": controlCode.position,
    "size": controlCode.size,
    "padding": controlCode.padding,
    "offsetX": controlCode.offsetX,
    "offsetY": controlCode.offsetY,
    "qrCodeColor": controlCode.qrCodeColor.toHtmlHex(),
    "backgroundColor": controlCode.backgroundColor.toHtmlHex(),
  }

proc frameScheduleJson(schedule: FrameSchedule): JsonNode =
  if schedule == nil:
    return %*{"events": %*[]}
  var events: seq[JsonNode] = @[]
  for event in schedule.events:
    events.add(%*{
      "id": event.id,
      "minute": event.minute,
      "hour": event.hour,
      "weekday": event.weekday,
      "event": event.event,
      "payload": event.payload,
    })
  result = %*{"events": events}

proc frameGpioButtonsJson(buttons: seq[GPIOButton]): JsonNode =
  var entries: seq[JsonNode] = @[]
  for button in buttons:
    entries.add(%*{"pin": button.pin, "label": button.label})
  result = %*entries

proc frameNetworkJson(network: NetworkConfig): JsonNode =
  if network == nil:
    return %*{}
  result = %*{
    "networkCheck": network.networkCheck,
    "networkCheckTimeoutSeconds": network.networkCheckTimeoutSeconds,
    "networkCheckUrl": network.networkCheckUrl,
    "wifiHotspot": network.wifiHotspot,
    "wifiHotspotSsid": network.wifiHotspotSsid,
    "wifiHotspotPassword": network.wifiHotspotPassword,
    "wifiHotspotTimeoutSeconds": network.wifiHotspotTimeoutSeconds,
  }

proc frameAgentJson(agent: AgentConfig): JsonNode =
  if agent == nil:
    return %*{}
  result = %*{
    "agentEnabled": agent.agentEnabled,
    "agentRunCommands": agent.agentRunCommands,
    "agentSharedSecret": agent.agentSharedSecret,
  }

proc frameMountpointsJson(mountpoints: MountpointsConfig, exposeSecrets: bool): JsonNode =
  if mountpoints == nil:
    return %*{"enabled": false, "items": %*[]}
  var items: seq[JsonNode] = @[]
  for mountpoint in mountpoints.items:
    if mountpoint == nil:
      continue
    items.add(%*{
      "enabled": mountpoint.enabled,
      "source": mountpoint.source,
      "target": mountpoint.target,
      "username": mountpoint.username,
      "password": if exposeSecrets: mountpoint.password else: "",
      "domain": mountpoint.domain,
      "options": mountpoint.options,
    })
  result = %*{
    "enabled": mountpoints.enabled,
    "items": items,
  }

proc framePaletteJson(palette: PaletteConfig): JsonNode =
  if palette == nil:
    return %*{}
  var colors: seq[JsonNode] = @[]
  for color in palette.colors:
    colors.add(%*[color[0], color[1], color[2]])
  result = %*{"colors": colors}

proc frameDeviceConfigJson(deviceConfig: DeviceConfig): JsonNode =
  if deviceConfig == nil:
    return %*{}
  var headers: seq[JsonNode] = @[]
  for header in deviceConfig.httpUploadHeaders:
    headers.add(%*{"name": header.name, "value": header.value})
  result = %*{
    "vcom": deviceConfig.vcom,
    "partial": deviceConfig.partial,
    "partialMaxAreaPercent": deviceConfig.partialMaxAreaPercent,
    "partialMaxRefreshesBeforeFull": deviceConfig.partialMaxRefreshesBeforeFull,
    "uploadUrl": deviceConfig.httpUploadUrl,
    "uploadHeaders": headers,
  }

proc frameHttpsProxyJson(httpsProxy: HttpsProxyConfig, exposeSecrets: bool): JsonNode =
  let port = if httpsProxy != nil and httpsProxy.port > 0: httpsProxy.port else: 8443
  result = %*{
    "enable": if httpsProxy != nil: httpsProxy.enable else: false,
    "port": port,
    "expose_only_port": if httpsProxy != nil: httpsProxy.exposeOnlyPort else: true,
    "certs": {
      "server": if exposeSecrets and httpsProxy != nil: httpsProxy.serverCert else: "",
      "server_key": if exposeSecrets and httpsProxy != nil: httpsProxy.serverKey else: "",
      "client_ca": "",
    },
    "server_cert_not_valid_after": newJNull(),
    "client_ca_cert_not_valid_after": newJNull(),
  }

proc frameErrorBehaviorJson(errorBehavior: ErrorBehaviorConfig): JsonNode =
  if errorBehavior == nil:
    return %*{
      "mode": "show_error_retry",
      "retry_seconds": 60,
      "silent_retry_seconds": 60,
      "silent_retry_forever": false,
      "silent_window_minutes": 10,
      "show_error_retry_seconds": 60,
    }
  %*{
    "mode": errorBehavior.mode,
    "retry_seconds": errorBehavior.retrySeconds,
    "silent_retry_seconds": errorBehavior.silentRetrySeconds,
    "silent_retry_forever": errorBehavior.silentRetryForever,
    "silent_window_minutes": errorBehavior.silentWindowMinutes,
    "show_error_retry_seconds": errorBehavior.showErrorRetrySeconds,
  }

proc frameTimeZoneUpdatesJson(timeZoneUpdates: TimeZoneUpdatesConfig): JsonNode =
  if timeZoneUpdates == nil:
    return %*{
      "enabled": true,
      "hour": 3,
      "url": "https://tz.frameos.net/tzdata.json.gz",
    }
  %*{
    "enabled": timeZoneUpdates.enabled,
    "hour": timeZoneUpdates.hour,
    "url": timeZoneUpdates.url,
  }

proc storedFrameApiPayload(configJson: JsonNode): JsonNode =
  if configJson.kind == JObject and configJson{"frameApi"} != nil and configJson{"frameApi"}.kind == JObject:
    return copy(configJson["frameApi"])
  %*{}

proc touchFrameSyncRevision*() =
  let configPath = getConfigFilename()
  var configJson = loadConfigJson()
  if configJson == nil or configJson.kind != JObject:
    configJson = %*{}
  var frameApi = storedFrameApiPayload(configJson)
  let previousRevision = frameApi{frameSyncCurrentRevisionKey}.getStr("")
  if frameApi{frameSyncDeployedRevisionKey}.getStr("").len == 0:
    let deployedRevision = if previousRevision.len > 0: previousRevision else: "legacy-deploy"
    frameApi[frameSyncDeployedRevisionKey] = %deployedRevision
  frameApi[frameSyncCurrentRevisionKey] = %nextFrameSyncRevision(frameApi)
  configJson["frameApi"] = frameApi
  writeTextFileAtomically(configPath, pretty(configJson, indent = 4) & "\n")

proc storedConfigValue(configJson: JsonNode, key: string, fallback: JsonNode): JsonNode =
  if configJson.kind == JObject and configJson.hasKey(key):
    return copy(configJson[key])
  fallback

proc storedApiOrConfigValue(
  configJson: JsonNode, storedFrameApi: JsonNode, apiKey, configKey: string, fallback: JsonNode
): JsonNode =
  if storedFrameApi.kind == JObject and storedFrameApi.hasKey(apiKey):
    return copy(storedFrameApi[apiKey])
  storedConfigValue(configJson, configKey, fallback)

proc storedFrameAdminAuthValue(configJson: JsonNode, storedFrameApi: JsonNode, exposeSecrets: bool): JsonNode =
  let source =
    if storedFrameApi.kind == JObject and storedFrameApi{"frame_admin_auth"} != nil and
        storedFrameApi{"frame_admin_auth"}.kind == JObject:
      storedFrameApi["frame_admin_auth"]
    elif configJson.kind == JObject and configJson{"frameAdminAuth"} != nil and configJson{"frameAdminAuth"}.kind == JObject:
      configJson["frameAdminAuth"]
    elif globalFrameConfig != nil and globalFrameConfig.frameAdminAuth != nil:
      globalFrameConfig.frameAdminAuth
    else:
      %*{}

  result = %*{
    "enabled": source{"enabled"}.getBool(false),
  }
  if exposeSecrets:
    result["user"] = %source{"user"}.getStr("")
    result["pass"] = %source{"pass"}.getStr("")

proc frameApiPayload*(connectionsState: ConnectionsState, exposeSecrets = false): JsonNode =
  let configPath = getConfigFilename()
  let configJson = loadConfigJson()
  let storedFrameApi = storedFrameApiPayload(configJson)
  let interval = if configJson.kind == JObject: configJson{"interval"}.getFloat(300) else: 300
  let backgroundColor =
    if configJson.kind == JObject: configJson{"backgroundColor"}.getStr("#000000") else: "#000000"
  let colorValue =
    if configJson.kind == JObject and configJson.hasKey("color"): configJson["color"] else: newJNull()
  let scenesPayload = loadScenePayload()
  let frameAccessKey = if exposeSecrets: globalFrameConfig.frameAccessKey else: ""
  let frameAdminAuth = storedFrameAdminAuthValue(configJson, storedFrameApi, exposeSecrets)
  let serverApiKey = if exposeSecrets: globalFrameConfig.serverApiKey else: ""
  let scenesSource = activeScenesJsonPath()
  var activeConnections = 0
  withLock connectionsState.lock:
    activeConnections = connectionsState.items.len

  result = %*{
    "id": frameApiId(),
    "project_id": 0,
    "name": globalFrameConfig.name,
    "mode": globalFrameConfig.mode,
    "frame_host": globalFrameConfig.frameHost,
    "frame_port": globalFrameConfig.framePort,
    "frame_access_key": frameAccessKey,
    "frame_access": globalFrameConfig.frameAccess,
    "frame_admin_auth": frameAdminAuth,
    "https_proxy": frameHttpsProxyJson(globalFrameConfig.httpsProxy, exposeSecrets),
    "ssh_user": "",
    "ssh_pass": "",
    "ssh_port": 22,
    "ssh_keys": %*[],
    "server_host": globalFrameConfig.serverHost,
    "server_port": globalFrameConfig.serverPort,
    "server_api_key": serverApiKey,
    "server_send_logs": globalFrameConfig.serverSendLogs,
    "status": "ready",
    "archived": false,
    "version": compiledFrameOSVersion(),
    "width": globalFrameConfig.width,
    "height": globalFrameConfig.height,
    "device": globalFrameConfig.device,
    "device_config": frameDeviceConfigJson(globalFrameConfig.deviceConfig),
    "color": colorValue,
    "timezone": globalFrameConfig.timeZone,
    "timezone_updater": frameTimeZoneUpdatesJson(globalFrameConfig.timeZoneUpdates),
    "interval": interval,
    "metrics_interval": globalFrameConfig.metricsInterval,
    "max_http_response_bytes": globalFrameConfig.maxHttpResponseBytes,
    "scaling_mode": globalFrameConfig.scalingMode,
    "image_engine": globalFrameConfig.imageEngine,
    "rotate": globalFrameConfig.rotate,
    "flip": globalFrameConfig.flip,
    "background_color": backgroundColor,
    "scenes": scenesPayload,
    "debug": globalFrameConfig.debug,
    "last_log_at": newJNull(),
    "log_to_file": globalFrameConfig.logToFile,
    "assets_path": globalFrameConfig.assetsPath,
    "save_assets": globalFrameConfig.saveAssets,
    "upload_fonts": storedApiOrConfigValue(configJson, storedFrameApi, "upload_fonts", "uploadFonts", %""),
    "reboot": storedApiOrConfigValue(configJson, storedFrameApi, "reboot", "reboot", newJNull()),
    "control_code": frameControlCodeJson(globalFrameConfig.controlCode),
    "schedule": frameScheduleJson(globalFrameConfig.schedule),
    "gpio_buttons": frameGpioButtonsJson(globalFrameConfig.gpioButtons),
    "network": frameNetworkJson(globalFrameConfig.network),
    "agent": frameAgentJson(globalFrameConfig.agent),
    "mountpoints": frameMountpointsJson(globalFrameConfig.mountpoints, exposeSecrets),
    "error_behavior": frameErrorBehaviorJson(globalFrameConfig.errorBehavior),
    "palette": framePaletteJson(globalFrameConfig.palette),
    "buildroot": storedApiOrConfigValue(configJson, storedFrameApi, "buildroot", "buildroot", newJNull()),
    "embedded": storedApiOrConfigValue(configJson, storedFrameApi, "embedded", "embedded", newJNull()),
    "rpios": storedApiOrConfigValue(configJson, storedFrameApi, "rpios", "rpios", newJNull()),
    "terminal_history": storedApiOrConfigValue(
      configJson, storedFrameApi, "terminal_history", "terminalHistory", %*[]
    ),
    "last_successful_deploy": storedApiOrConfigValue(
      configJson, storedFrameApi, "last_successful_deploy", "lastSuccessfulDeploy", newJNull()
    ),
    "last_successful_deploy_at": storedApiOrConfigValue(
      configJson, storedFrameApi, "last_successful_deploy_at", "lastSuccessfulDeployAt", newJNull()
    ),
    "frame_sync": {
      "current_revision": storedFrameApi{frameSyncCurrentRevisionKey}.getStr(""),
      "deployed_revision": storedFrameApi{frameSyncDeployedRevisionKey}.getStr(""),
      "frame_config_modified_at": fileModifiedIso(configPath),
      "scenes_modified_at": fileModifiedIso(scenesSource.path),
    },
    "active_connections": activeConnections,
  }
  for key in storedFrameApi.keys:
    if exposeSecrets or not result.hasKey(key):
      result[key] = copy(storedFrameApi[key])

const frameSyncExposeHeaders = "X-Scene-Id, X-FrameOS-Sync-Changed, X-FrameOS-Sync-Revision, X-FrameOS-Deployed-Revision, X-FrameOS-Frame-Config-Modified-At, X-FrameOS-Scenes-Modified-At, X-FrameOS-Last-Successful-Deploy-At"

proc putHeaderIfPresent(headers: var mummy.HttpHeaders, name: string, value: string) =
  if value.len > 0:
    headers[name] = value

proc addFrameSyncHeaders(headers: var mummy.HttpHeaders) =
  let configPath = getConfigFilename()
  let scenesSource = activeScenesJsonPath()
  let configJson = loadConfigJson()
  let storedFrameApi = storedFrameApiPayload(configJson)
  let currentRevision = storedFrameApi{frameSyncCurrentRevisionKey}.getStr("")
  let deployedRevision = storedFrameApi{frameSyncDeployedRevisionKey}.getStr("")
  let lastSuccessfulDeployAt = storedApiOrConfigValue(
    configJson, storedFrameApi, "last_successful_deploy_at", "lastSuccessfulDeployAt", newJNull()
  ).getStr("")
  let hasChanges = currentRevision.len > 0 and deployedRevision.len > 0 and currentRevision != deployedRevision
  headers["X-FrameOS-Sync-Changed"] = if hasChanges: "1" else: "0"
  putHeaderIfPresent(headers, "X-FrameOS-Sync-Revision", currentRevision)
  putHeaderIfPresent(headers, "X-FrameOS-Deployed-Revision", deployedRevision)
  putHeaderIfPresent(headers, "X-FrameOS-Frame-Config-Modified-At", fileModifiedIso(configPath).getStr(""))
  putHeaderIfPresent(headers, "X-FrameOS-Scenes-Modified-At", fileModifiedIso(scenesSource.path).getStr(""))
  putHeaderIfPresent(headers, "X-FrameOS-Last-Successful-Deploy-At", lastSuccessfulDeployAt)
  headers["Access-Control-Expose-Headers"] = frameSyncExposeHeaders

proc buildFrameImageResponse*(request: Request): tuple[status: httpcore.HttpCode, headers: mummy.HttpHeaders, body: string] =
  let startedAt = epochTime()
  let logImageRequest = globalFrameConfig.debug
  let memoryBefore = if logImageRequest: defaultProcessMemoryUsage() else: newJObject()
  let (sceneId, _, _, lastUpdate) = getLastPublicState()
  if shouldReturnNotModified(request.headers, lastUpdate):
    var headers: mummy.HttpHeaders
    headers["X-Scene-Id"] = $sceneId
    addFrameSyncHeaders(headers)
    if logImageRequest:
      log(%*{
        "event": "http:image",
        "source": "notModified",
        "status": int(Http304),
        "sceneId": $sceneId,
        "bytes": 0,
        "ms": (epochTime() - startedAt) * 1000.0,
        "processMemoryBefore": memoryBefore,
        "processMemoryAfter": defaultProcessMemoryUsage(),
      })
    return (Http304, headers, "")

  var headers: mummy.HttpHeaders
  headers["Content-Type"] = "image/png"
  headers["Content-Disposition"] = &"inline; filename=\"{sceneId}.png\""
  headers["X-Scene-Id"] = $sceneId
  addFrameSyncHeaders(headers)
  if lastUpdate > 0.0:
    let lastModified = format(fromUnix(int64(lastUpdate)), "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    headers["Last-Modified"] = lastModified
  var driverPreview = "unknown"
  var driverPreviewError = ""
  try:
    let image = drivers.toPng(360 - globalFrameConfig.rotate, globalFrameConfig.flip)
    if image != "":
      if logImageRequest:
        log(%*{
          "event": "http:image",
          "source": "driver",
          "status": int(Http200),
          "sceneId": $sceneId,
          "bytes": image.len,
          "ms": (epochTime() - startedAt) * 1000.0,
          "processMemoryBefore": memoryBefore,
          "processMemoryAfter": defaultProcessMemoryUsage(),
        })
      return (Http200, headers, image)
    else:
      driverPreview = "unavailable"
  except Exception as e:
    driverPreview = "error"
    driverPreviewError = e.msg
  try:
    let image = getLastImagePng()
    if logImageRequest:
      var payload = %*{
        "event": "http:image",
        "source": "lastImage",
        "status": int(Http200),
        "sceneId": $sceneId,
        "bytes": image.len,
        "ms": (epochTime() - startedAt) * 1000.0,
        "driverPreview": driverPreview,
        "processMemoryBefore": memoryBefore,
        "processMemoryAfter": defaultProcessMemoryUsage(),
      }
      if driverPreviewError.len > 0:
        payload["driverPreviewError"] = %driverPreviewError
      log(payload)
    return (Http200, headers, image)
  except Exception as fallbackError:
    let image = renderError(globalFrameConfig.renderWidth(), globalFrameConfig.renderHeight(),
      &"Error: {$fallbackError.msg}\n{$fallbackError.getStackTrace()}").encodeImage(PngFormat)
    if logImageRequest:
      var payload = %*{
        "event": "http:image",
        "source": "error",
        "status": int(Http200),
        "sceneId": $sceneId,
        "bytes": image.len,
        "ms": (epochTime() - startedAt) * 1000.0,
        "driverPreview": driverPreview,
        "fallbackError": fallbackError.msg,
        "processMemoryBefore": memoryBefore,
        "processMemoryAfter": defaultProcessMemoryUsage(),
      }
      if driverPreviewError.len > 0:
        payload["driverPreviewError"] = %driverPreviewError
      log(payload)
    return (Http200, headers, image)

proc renderControlPage*(request: Request) =
  var fieldsHtml = ""
  var fieldsSubmitHtml = ""
  let (currentSceneId, values, fields, _) = getLastPublicState()
  for field in fields:
    let key = field.name
    let label = if field.label != "": field.label else: key
    let placeholder = field.placeholder
    let fieldType = field.fieldType
    let value = if values.hasKey(key): values{key} else: %*""
    var stringValue = value.getStr()

    if fieldsSubmitHtml != "":
      fieldsSubmitHtml.add(", ")
    if fieldType == "integer":
      stringValue = $value.getInt()
      fieldsSubmitHtml.add(fmt"'{s($key)}': parseInt(document.getElementById('{s($key)}').value)")
    elif fieldType == "float":
      stringValue = $value.getFloat()
      fieldsSubmitHtml.add(fmt"'{s($key)}': parseFloat(document.getElementById('{s($key)}').value)")
    elif fieldType == "boolean":
      stringValue = $value.getBool()
      fieldsSubmitHtml.add(fmt"'{s($key)}': document.getElementById('{s($key)}').value === 'true'")
    else:
      fieldsSubmitHtml.add(fmt"'{s($key)}': document.getElementById('{s($key)}').value")

    fieldsHtml.add(fmt"<label for='{h($key)}'>{h(label)}</label><br/>")
    if fieldType == "text":
      fieldsHtml.add(fmt"<textarea id='{h($key)}' placeholder='{h(placeholder)}' rows=5>{h(stringValue)}</textarea><br/><br/>")
    elif fieldType == "select" or fieldType == "boolean" or fieldType == "font":
      fieldsHtml.add(fmt"<select id='{h($key)}' placeholder='{h(placeholder)}'>")
      {.gcsafe.}:
        let options = if fieldType == "boolean": @[
          "true", "false"
        ] elif fieldType == "font":
          getAvailableFonts(globalFrameConfig.assetsPath)
        else:
          field.options
      for option in options:
        let selected = if option == stringValue: " selected" else: ""
        fieldsHtml.add(fmt"<option value='{h($option)}'{selected}>{h($option)}</option>")
      fieldsHtml.add("</select><br/><br/>")
    else:
      fieldsHtml.add(fmt"<input type='text' id='{h($key)}' placeholder='{h(placeholder)}' value='{h(stringValue)}' /><br/><br/>")

  var sceneOptionsHtml = ""
  var allSceneOptions: seq[tuple[id: SceneId, name: string]]
  var seenSceneIds = initTable[string, bool]()

  proc addSceneOption(sceneId: SceneId, sceneName: string) =
    let sceneIdString = sceneId.string
    if seenSceneIds.hasKey(sceneIdString):
      return
    seenSceneIds[sceneIdString] = true
    allSceneOptions.add((id: sceneId, name: sceneName))

  for (sceneId, sceneName) in sceneOptions:
    addSceneOption(sceneId, sceneName)
  var dynamicSceneOptions: seq[tuple[id: SceneId, name: string]]
  {.gcsafe.}:
    dynamicSceneOptions = getDynamicSceneOptions()
  for (sceneId, sceneName) in dynamicSceneOptions:
    addSceneOption(sceneId, sceneName)

  allSceneOptions.sort(proc(a, b: tuple[id: SceneId, name: string]): int =
    result = cmpIgnoreCase(a.name, b.name)
    if result == 0:
      result = cmp(a.id.string, b.id.string)
  )

  for sceneOption in allSceneOptions:
    let selected = if sceneOption.id == currentSceneId: " selected" else: ""
    sceneOptionsHtml.add(
      fmt"<option value='{h(sceneOption.id.string)}'{selected}>{h(sceneOption.name)}</option>"
    )

  fieldsHtml.add("<input type='submit' id='setSceneState' value='Set Scene State'>")
  {.gcsafe.}:
    let controlHtml = getWebAsset("assets/compiled/web/control.html").
      replace("/*$$fieldsHtml$$*/", fieldsHtml).
      replace("/*$$fieldsSubmitHtml$$*/", fieldsSubmitHtml).
      replace("/*$$sceneOptionsHtml$$*/", sceneOptionsHtml).
      replace("Frame Control", if globalFrameConfig.name != "": h(globalFrameConfig.name) else: "Frame Control")
    request.respond(int(Http200), body = controlHtml)

proc appsPayload*(): string =
  appsAsset.getAppsJson()

proc frameStatePayload*(): tuple[sceneId: SceneId, state: JsonNode] =
  let (sceneId, state, _, _) = getLastPublicState()
  (sceneId: sceneId, state: state)

proc frameStatesPayload*(): tuple[sceneId: SceneId, states: JsonNode] =
  getAllPublicStates()

proc uploadedScenesPayload*(): JsonNode =
  getUploadedScenePayload()
