import json
import pixie
import chroma
import times
import std/os
import assets/web as webAssets
import assets/frame_web as frameWebAssets
import assets/apps as appsAsset
import httpcore
import osproc
import threadpool
import locks
import strformat
import options
import strutils
import tables
import algorithm
import random
import hashes
import checksums/md5
import zippy
import mummy
import mummy/routers
import drivers/drivers as drivers
import frameos/apps
import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/font
import frameos/config
import frameos/portal as netportal
from net import Port
from frameos/scenes import getLastImagePng, getLastPublicState, getAllPublicStates, getUploadedScenePayload,
    getDynamicSceneOptions
from scenes/scenes import sceneOptions

var globalFrameOS: FrameOS
var globalFrameConfig: FrameConfig
var globalRunner: RunnerControl
var globalAdminSessionSalt {.threadvar.}: string
var globalAdminConnectionsState: ConnectionsState
var globalRecentLogs: seq[JsonNode] = @[]
var globalRecentLogsLock: Lock
var globalRecentLogId = 0
let frameWebIndexHtml = frameWebAssets.getAsset("assets/compiled/frame_web/index.html")
const MAX_RECENT_LOGS = 5000
const FRAME_API_ID = 1

proc initConnectionsState(): ConnectionsState =
  new(result)
  initLock(result.lock)
  result.items = @[]

proc sendToAll(state: ConnectionsState, message: string) {.gcsafe.} =
  withLock state.lock:
    for connection in state.items:
      connection.send(message)

proc addConnection(state: ConnectionsState, websocket: WebSocket) {.gcsafe.} =
  withLock state.lock:
    state.items.add(websocket)

proc removeConnection(state: ConnectionsState, websocket: WebSocket) {.gcsafe.} =
  withLock state.lock:
    let index = state.items.find(websocket)
    if index >= 0:
      state.items.delete(index)

proc hasConnections(state: ConnectionsState): bool {.gcsafe.} =
  withLock state.lock:
    result = state.items.len > 0

proc toUiLog(payload: (float, JsonNode)): JsonNode =
  let (timestamp, logPayload) = payload
  globalRecentLogId += 1
  let isoTimestamp = format(fromUnix(int64(timestamp)), "yyyy-MM-dd'T'HH:mm:ss'Z'", utc())
  result = %*{
    "id": globalRecentLogId,
    "timestamp": isoTimestamp,
    "ip": "",
    "type": "webhook",
    "line": $logPayload,
    "frame_id": FRAME_API_ID,
  }

proc storeUiLog(logEntry: JsonNode) =
  {.gcsafe.}:
    withLock globalRecentLogsLock:
      globalRecentLogs.add(logEntry)
      if globalRecentLogs.len > MAX_RECENT_LOGS:
        globalRecentLogs = globalRecentLogs[(globalRecentLogs.len - MAX_RECENT_LOGS) .. (globalRecentLogs.len - 1)]

proc getUiLogs(): JsonNode =
  {.gcsafe.}:
    withLock globalRecentLogsLock:
      return %*globalRecentLogs

proc h(message: string): string =
  message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#039;")

proc s(message: string): string =
  message.replace("'", "\\'").replace("\n", "\\n")

proc contentTypeForAsset(path: string): string =
  if path.endsWith(".css"):
    "text/css"
  elif path.endsWith(".js"):
    "application/javascript"
  elif path.endsWith(".svg"):
    "image/svg+xml"
  elif path.endsWith(".png"):
    "image/png"
  elif path.endsWith(".woff2"):
    "font/woff2"
  elif path.endsWith(".woff"):
    "font/woff"
  else:
    "application/octet-stream"

proc loadConfigJson(): JsonNode =
  try:
    return parseFile(getConfigFilename())
  except CatchableError:
    return %*{}

proc loadScenePayload(): JsonNode =
  var data = ""
  let envPath = getEnv("FRAMEOS_SCENES_JSON")
  if envPath.len > 0:
    try:
      if envPath.endsWith(".gz") and fileExists(envPath):
        data = uncompress(readFile(envPath))
      elif fileExists(envPath):
        data = readFile(envPath)
    except CatchableError:
      data = ""
  if data.len == 0:
    try:
      if fileExists("./scenes.json.gz"):
        data = uncompress(readFile("./scenes.json.gz"))
      elif fileExists("./scenes.json"):
        data = readFile("./scenes.json")
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
    "uploadUrl": deviceConfig.httpUploadUrl,
    "uploadHeaders": headers,
  }

proc frameApiId(): int =
  FRAME_API_ID

proc parseFrameApiId(rawId: string): int =
  try:
    return parseInt(rawId)
  except CatchableError:
    return -1

proc frameAssetsPayload(): JsonNode =
  let configuredAssetsPath = if globalFrameConfig.assetsPath.len > 0: globalFrameConfig.assetsPath else: "/srv/assets"
  let assetsPath = normalizedPath(configuredAssetsPath)
  var assets: seq[JsonNode] = @[]
  if not dirExists(assetsPath):
    return %*[]

  proc addAsset(path: string, kind: PathComponent) =
    if kind notin {pcDir, pcFile}:
      return
    try:
      let info = getFileInfo(path)
      assets.add(%*{
        "path": path,
        "size": if kind == pcFile: info.size else: 0,
        "mtime": info.lastWriteTime.toUnix(),
        "is_dir": kind == pcDir,
      })
    except CatchableError:
      discard

  for kind, path in walkDir(assetsPath, relative = false):
    if kind == pcDir:
      addAsset(path, kind)

  for filePath in walkDirRec(assetsPath, relative = false):
    addAsset(filePath, pcFile)

  return %*assets

proc withinBasePath(path, basePath: string): bool =
  let normalizedTargetPath = normalizedPath(path)
  let normalizedBasePath = normalizedPath(basePath)
  return normalizedTargetPath == normalizedBasePath or normalizedTargetPath.startsWith(normalizedBasePath & DirSep)

proc contentTypeForFilePath(path: string): string =
  let lowerPath = path.toLowerAscii()
  if lowerPath.endsWith(".png"):
    return "image/png"
  if lowerPath.endsWith(".jpg") or lowerPath.endsWith(".jpeg"):
    return "image/jpeg"
  if lowerPath.endsWith(".webp"):
    return "image/webp"
  if lowerPath.endsWith(".gif"):
    return "image/gif"
  if lowerPath.endsWith(".svg"):
    return "image/svg+xml"
  contentTypeForAsset(lowerPath)

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

proc shouldReturnNotModified(headers: mummy.HttpHeaders, lastUpdate: float): bool {.gcsafe.} =
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

const AUTH_HEADER = "authorization"
const AUTH_TYPE = "Bearer"
const ACCESS_COOKIE = "frame_access_key"
const ADMIN_SESSION_COOKIE = "frame_admin_session"
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24

type
  AccessType = enum
    Read
    Write

proc getAssetPayload(path: string, thumb: bool): tuple[status: httpcore.HttpCode, headers: mummy.HttpHeaders, body: string] =
  let configuredAssetsPath = if globalFrameConfig.assetsPath.len > 0: globalFrameConfig.assetsPath else: "/srv/assets"
  let assetsPath = normalizedPath(configuredAssetsPath)
  let relPath = path.strip()
  if relPath.len == 0:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Path is required"}))

  let fullPath = normalizedPath(assetsPath / relPath)
  if not withinBasePath(fullPath, assetsPath):
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Invalid path"}))
  if not fileExists(fullPath):
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http404, headers, $(%*{"detail": "Asset not found"}))

  if not thumb:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = contentTypeForFilePath(fullPath)
    return (Http200, headers, readFile(fullPath))

  let fullMd5 = getMD5(fullPath)
  let thumbRoot = assetsPath / ".thumbs"
  let thumbPath = normalizedPath(thumbRoot / (fullMd5 & ".320x320.jpg"))
  if not withinBasePath(thumbPath, thumbRoot):
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Invalid thumbnail path"}))

  try:
    if not fileExists(thumbPath):
      createDir(parentDir(thumbPath))
      let cmd = "convert " & quoteShell(fullPath) & " -thumbnail 320x320 " & quoteShell(thumbPath)
      let (output, exitCode) = execCmdEx(cmd)
      if exitCode != 0:
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = "application/json"
        return (Http500, headers, $(%*{"detail": "Failed to generate thumbnail", "error": output}))
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "image/jpeg"
    return (Http200, headers, readFile(thumbPath))
  except CatchableError as e:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http500, headers, $(%*{"detail": "Failed to fetch asset", "error": e.msg}))

proc frameApiPayload(connectionsState: ConnectionsState): JsonNode =
  let configJson = loadConfigJson()
  let interval = if configJson.kind == JObject: configJson{"interval"}.getFloat(300) else: 300
  let backgroundColor =
    if configJson.kind == JObject: configJson{"backgroundColor"}.getStr("#000000") else: "#000000"
  let colorValue =
    if configJson.kind == JObject and configJson.hasKey("color"): configJson["color"] else: newJNull()
  let scenesPayload = loadScenePayload()
  var activeConnections = 0
  withLock connectionsState.lock:
    activeConnections = connectionsState.items.len

  result = %*{
    "id": frameApiId(),
    "name": globalFrameConfig.name,
    "mode": globalFrameConfig.mode,
    "frame_host": globalFrameConfig.frameHost,
    "frame_port": globalFrameConfig.framePort,
    "frame_access_key": globalFrameConfig.frameAccessKey,
    "frame_access": globalFrameConfig.frameAccess,
    "frame_admin_auth": globalFrameConfig.frameAdminAuth,
    "ssh_user": "",
    "ssh_pass": "",
    "ssh_port": 22,
    "ssh_keys": %*[],
    "server_host": globalFrameConfig.serverHost,
    "server_port": globalFrameConfig.serverPort,
    "server_api_key": globalFrameConfig.serverApiKey,
    "status": "ready",
    "width": globalFrameConfig.width,
    "height": globalFrameConfig.height,
    "device": globalFrameConfig.device,
    "device_config": frameDeviceConfigJson(globalFrameConfig.deviceConfig),
    "color": colorValue,
    "interval": interval,
    "metrics_interval": globalFrameConfig.metricsInterval,
    "scaling_mode": globalFrameConfig.scalingMode,
    "rotate": globalFrameConfig.rotate,
    "flip": globalFrameConfig.flip,
    "background_color": backgroundColor,
    "scenes": scenesPayload,
    "debug": globalFrameConfig.debug,
    "log_to_file": globalFrameConfig.logToFile,
    "assets_path": globalFrameConfig.assetsPath,
    "save_assets": globalFrameConfig.saveAssets,
    "control_code": frameControlCodeJson(globalFrameConfig.controlCode),
    "schedule": frameScheduleJson(globalFrameConfig.schedule),
    "gpio_buttons": frameGpioButtonsJson(globalFrameConfig.gpioButtons),
    "network": frameNetworkJson(globalFrameConfig.network),
    "agent": frameAgentJson(globalFrameConfig.agent),
    "palette": framePaletteJson(globalFrameConfig.palette),
    "active_connections": activeConnections,
  }

proc buildFrameImageResponse(request: Request): tuple[status: httpcore.HttpCode, headers: mummy.HttpHeaders, body: string] =
  let (sceneId, _, _, lastUpdate) = getLastPublicState()
  if shouldReturnNotModified(request.headers, lastUpdate):
    var headers: mummy.HttpHeaders
    headers["X-Scene-Id"] = $sceneId
    headers["Access-Control-Expose-Headers"] = "X-Scene-Id"
    return (Http304, headers, "")

  var headers: mummy.HttpHeaders
  headers["Content-Type"] = "image/png"
  headers["Content-Disposition"] = &"inline; filename=\"{sceneId}.png\""
  headers["X-Scene-Id"] = $sceneId
  headers["Access-Control-Expose-Headers"] = "X-Scene-Id"
  if lastUpdate > 0.0:
    let lastModified = format(fromUnix(int64(lastUpdate)), "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    headers["Last-Modified"] = lastModified
  try:
    let image = drivers.toPng(360 - globalFrameConfig.rotate)
    if image != "":
      return (Http200, headers, image)
    else:
      raise newException(Exception, "No image available")
  except Exception:
    try:
      return (Http200, headers, getLastImagePng())
    except Exception as e:
      return (Http200, headers, renderError(globalFrameConfig.renderWidth(), globalFrameConfig.renderHeight(),
        &"Error: {$e.msg}\n{$e.getStackTrace()}").encodeImage(PngFormat))

proc respond(request: Request; statusCode: httpcore.HttpCode;
    headers: sink mummy.HttpHeaders = emptyHttpHeaders(); body: sink string = "") =
  mummy.respond(request, int(statusCode), headers, body)

proc getCookieValue(request: Request, name: string): string =
  if not request.headers.contains("cookie"):
    return ""
  let cookieHeader = request.headers["cookie"]
  for cookie in cookieHeader.split(";"):
    let parts = cookie.strip().split("=", 1)
    if parts.len == 2 and parts[0] == name:
      return parts[1]
  return ""

template adminAuthUser(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"user"}.getStr("")

template adminAuthPass(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"pass"}.getStr("")

template adminAuthEnabled(): bool =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"enabled"}.getBool(false) and
      globalFrameConfig.frameAdminAuth{"user"}.getStr("").len > 0 and
      globalFrameConfig.frameAdminAuth{"pass"}.getStr("").len > 0

proc getOrCreateAdminSessionSalt(configPath: string): string =
  let envSecret = getEnv("FRAMEOS_ADMIN_SESSION_SALT")
  if envSecret.len > 0:
    return envSecret

  let secretPath = configPath & ".admin_session_salt"
  try:
    if fileExists(secretPath):
      let existing = readFile(secretPath).strip()
      if existing.len > 0:
        return existing
  except CatchableError:
    discard

  randomize()
  let generated = $(hash($epochTime() & ":" & $rand(1_000_000_000) & ":" & configPath))
  try:
    writeFile(secretPath, generated & "\n")
  except CatchableError:
    discard
  return generated

proc hasAdminSession(request: Request): bool =
  {.gcsafe.}:
    if not adminAuthEnabled():
      return true
    if adminAuthUser().len == 0 or adminAuthPass().len == 0:
      return false
    let token = getCookieValue(request, ADMIN_SESSION_COOKIE)
    let expectedToken = $(hash(globalAdminSessionSalt & ":" & adminAuthUser() & ":" & adminAuthPass()))
    return token.len > 0 and token == expectedToken

proc hasAccess(request: Request, accessType: AccessType): bool =
  {.gcsafe.}:
    let access = globalFrameConfig.frameAccess
    if access == "public" or (access == "protected" and accessType == Read):
      return true
    let accessKey = globalFrameConfig.frameAccessKey
    if accessKey == "":
      return false
    if request.queryParams.contains("k") and request.queryParams["k"] == accessKey:
      return true
    if getCookieValue(request, ACCESS_COOKIE) == accessKey:
      return true
    if request.httpMethod == "POST":
      return request.headers.contains(AUTH_HEADER) and request.headers[AUTH_HEADER] == AUTH_TYPE & " " & accessKey
    return false

proc parseUrlEncoded(body: string): Table[string, string] =
  for pair in body.split('&'):
    if pair == "":
      continue
    let kv = pair.split('=', 1)
    let key = decodeQueryComponent(kv[0])
    let value = if kv.len > 1: decodeQueryComponent(kv[1]) else: ""
    result[key] = value

proc jsonResponse(request: Request, statusCode: httpcore.HttpCode, payload: JsonNode) =
  var headers: mummy.HttpHeaders
  headers["Content-Type"] = "application/json"
  request.respond(int(statusCode), headers, $payload)

proc makeWebsocketHandler(publicState: ConnectionsState, adminState: ConnectionsState): WebSocketHandler =
  result = proc(websocket: WebSocket, event: WebSocketEvent, message: Message) {.closure, gcsafe.} =
    case event:
    of OpenEvent:
      log(%*{"event": "websocket:connect"})
    of MessageEvent:
      log(%*{"event": "websocket:message", "message": message.data})
    of ErrorEvent, CloseEvent:
      log(%*{"event": "websocket:disconnect"})
      removeConnection(publicState, websocket)
      removeConnection(adminState, websocket)

proc buildRouter(connectionsState: ConnectionsState, adminConnectionsState: ConnectionsState): Router =
  result.get("/", proc(request: Request) =
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.path})
        request.respond(Http200, body = netportal.setupHtml(globalFrameOS))
      else:
        let accessKey = globalFrameConfig.frameAccessKey
        if accessKey != "" and request.queryParams.contains("k") and request.queryParams["k"] == accessKey:
          var headers: mummy.HttpHeaders
          headers["Location"] = "/"
          headers["Set-Cookie"] = ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax"
          request.respond(Http302, headers)
        elif not hasAccess(request, Read):
          request.respond(Http401, body = "Unauthorized")
        else:
          let scalingMode = case globalFrameConfig.scalingMode:
            of "cover", "center": globalFrameConfig.scalingMode
            of "stretch": "100% 100%"
            else: "contain"
          request.respond(Http200, body = frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode))
  )

  result.get("/admin", proc(request: Request) =
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.path})
        request.respond(Http200, body = netportal.setupHtml(globalFrameOS))
      elif not hasAdminSession(request):
        var headers: mummy.HttpHeaders
        headers["Location"] = "/login"
        request.respond(Http302, headers)
      else:
        let accessKey = globalFrameConfig.frameAccessKey
        if accessKey != "" and request.queryParams.contains("k") and request.queryParams["k"] == accessKey:
          var headers: mummy.HttpHeaders
          headers["Location"] = "/admin"
          headers["Set-Cookie"] = ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax"
          request.respond(Http302, headers)
        else:
          let scalingMode = case globalFrameConfig.scalingMode:
            of "cover", "center": globalFrameConfig.scalingMode
            of "stretch": "100% 100%"
            else: "contain"
          request.respond(Http200, body = frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode))
  )

  result.get("/control", proc(request: Request) =
    var headers: mummy.HttpHeaders
    headers["Location"] = "/admin"
    request.respond(Http302, headers)
  )

  result.get("/login", proc(request: Request) =
    {.gcsafe.}:
      let scalingMode = case globalFrameConfig.scalingMode:
        of "cover", "center": globalFrameConfig.scalingMode
        of "stretch": "100% 100%"
        else: "contain"
      request.respond(Http200, body = frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode))
  )

  result.get("/logout", proc(request: Request) =
    var headers: mummy.HttpHeaders
    headers["Location"] = "/login"
    headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=; Path=/; Max-Age=0; SameSite=Lax"
    request.respond(Http302, headers)
  )

  result.get("/static/@asset", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let assetPath = "assets/compiled/frame_web/static/" & request.pathParams["asset"]
      try:
        let asset = frameWebAssets.getAsset(assetPath)
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = contentTypeForAsset(assetPath)
        request.respond(Http200, headers, asset)
      except KeyError:
        request.respond(Http404, body = "Not found!")
  )

  result.post("/setup", proc(request: Request) =
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        request.respond(Http400, body = "Not in setup mode")
        return
      let params = parseUrlEncoded(request.body)
      log(%*{"event": "portal:http", "post": request.path, "params": params})
      if not params.hasKey("ssid"):
        request.respond(Http400, body = "Missing ssid")
        return
      spawn netportal.connectToWifi(
        globalFrameOS,
        params["ssid"],
        params.getOrDefault("password", ""),
        params.getOrDefault("serverHost", globalFrameOS.frameConfig.serverHost),
        params.getOrDefault("serverPort", $globalFrameOS.frameConfig.serverPort),
      )
      request.respond(Http200, body = netportal.confirmHtml())
  )

  result.get("/ping", proc(request: Request) =
    request.respond(Http200, body = "pong")
  )

  result.get("/setup", proc(request: Request) =
    var headers: mummy.HttpHeaders
    headers["Location"] = "/"
    request.respond(Http302, headers)
  )

  result.get("/wifi", proc(request: Request) =
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        request.respond(Http400, body = "Not in setup mode")
      else:
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = "application/json"
        let nets = netportal.availableNetworks(globalFrameOS)
        request.respond(Http200, headers, $(%*{"networks": nets}))
  )

  result.get("/ws", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      let websocket = request.upgradeToWebSocket()
      addConnection(connectionsState, websocket)
    except CatchableError:
      request.respond(Http500, body = "WebSocket upgrade failed")
  )

  result.get("/ws/admin", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Read) or not hasAdminSession(request):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      let websocket = request.upgradeToWebSocket()
      addConnection(adminConnectionsState, websocket)
    except CatchableError:
      request.respond(Http500, body = "WebSocket upgrade failed")
  )

  result.get("/image", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let (status, headers, body) = buildFrameImageResponse(request)
      request.respond(status, headers, body)
  )

  result.get("/api/apps", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      request.respond(Http200, headers, appsAsset.getAppsJson())
  )

  result.get("/api/frames", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let framePayload = frameApiPayload(connectionsState)
      jsonResponse(request, Http200, %*{"frames": @[framePayload]})
  )

  result.get("/api/frames/@id", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let framePayload = frameApiPayload(connectionsState)
        jsonResponse(request, Http200, %*{"frame": framePayload})
  )

  result.get("/api/frames/@id/ping", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{
          "ok": true,
          "mode": "http",
          "target": "frame",
          "elapsed_ms": 0,
          "status": 200,
          "message": "pong"
        })
  )

  result.get("/api/frames/@id/state", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let (sceneId, state, _, _) = getLastPublicState()
        jsonResponse(request, Http200, %*{"sceneId": $sceneId, "state": state})
  )

  result.get("/api/frames/@id/states", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let (sceneId, states) = getAllPublicStates()
        jsonResponse(request, Http200, %*{"sceneId": $sceneId, "states": states})
  )

  result.get("/api/frames/@id/uploaded_scenes", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"scenes": getUploadedScenePayload()})
  )

  result.get("/api/frames/@id/logs", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"logs": getUiLogs()})
  )

  result.get("/api/frames/@id/metrics", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"metrics": %*[]})
  )

  result.get("/api/frames/@id/assets", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"assets": frameAssetsPayload()})
  )

  result.get("/api/frames/@id/asset", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let path = request.queryParams.getOrDefault("path", "")
        let thumb = request.queryParams.getOrDefault("thumb", "") == "1"
        let (status, headers, body) = getAssetPayload(path, thumb)
        request.respond(status, headers, body)
  )

  result.get("/api/frames/@id/image_token", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let token = if globalFrameConfig.frameAccessKey.len > 0: globalFrameConfig.frameAccessKey else: "frame"
        jsonResponse(request, Http200, %*{"token": token, "expires_in": 3600})
  )

  result.get("/api/frames/@id/image", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let (status, headers, body) = buildFrameImageResponse(request)
        request.respond(status, headers, body)
  )

  result.get("/api/frames/@id/scene_images/@sceneId", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let (status, headers, body) = buildFrameImageResponse(request)
        request.respond(status, headers, body)
  )

  result.get("/api/admin/session", proc(request: Request) =
    let authenticated = hasAdminSession(request)
    jsonResponse(request, Http200, %*{"authenticated": authenticated})
  )

  result.post("/api/admin/login", proc(request: Request) =
    if not adminAuthEnabled():
      jsonResponse(request, Http200, %*{"status": "ok"})
      return
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    let username = payload{"username"}.getStr("")
    let password = payload{"password"}.getStr("")
    if username == adminAuthUser() and password == adminAuthPass() and username.len > 0:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=" & $(hash(globalAdminSessionSalt & ":" & adminAuthUser() &
        ":" & adminAuthPass())) & "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" & $ADMIN_SESSION_TTL_SECONDS
      request.respond(Http200, headers, $(%*{"status": "ok"}))
    else:
      jsonResponse(request, Http401, %*{"detail": "Invalid credentials"})
  )

  result.post("/api/admin/logout", proc(request: Request) =
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    request.respond(Http200, headers, $(%*{"status": "ok"}))
  )

  result.post("/api/frames/@id/event/@name", proc(request: Request) =
    if not hasAdminSession(request):
      request.respond(Http401, body = "Unauthorized")
      return
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        log(%*{"event": "http", "post": request.path})
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        sendEvent(request.pathParams["name"], payload)
        jsonResponse(request, Http200, %*{"status": "ok"})
  )

  result.post("/api/frames/@id/event", proc(request: Request) =
    if not hasAdminSession(request):
      request.respond(Http401, body = "Unauthorized")
      return
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      let requestedId = parseFrameApiId(request.pathParams["id"])
      if requestedId != frameApiId():
        request.respond(Http404, body = "Not found!")
      else:
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        let eventName = payload{"event"}.getStr("")
        if eventName.len == 0:
          jsonResponse(request, Http400, %*{"detail": "Missing event"})
        else:
          let eventPayload = payload{"payload"}
          log(%*{"event": "http", "post": request.path, "eventName": eventName})
          sendEvent(eventName, if eventPayload.kind == JNull: %*{} else: eventPayload)
          jsonResponse(request, Http200, %*{"status": "ok"})
  )

  result.post("/event/@name", proc(request: Request) =
    if not hasAdminSession(request):
      request.respond(Http401, body = "Unauthorized")
      return
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(request.pathParams["name"], payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  result.post("/uploadScenes", proc(request: Request) =
    if not hasAdminSession(request):
      request.respond(Http401, body = "Unauthorized")
      return
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent("uploadScenes", payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  result.post("/reload", proc(request: Request) =
    if not hasAdminSession(request):
      request.respond(Http401, body = "Unauthorized")
      return
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      {.gcsafe.}:
        let newConfig = loadConfig()
        updateFrameConfigFrom(globalFrameOS.frameConfig, newConfig)
      sendEvent("reload", %*{})
      jsonResponse(request, Http200, %*{"status": "ok"})
    except CatchableError as e:
      log(%*{"event": "reload:error", "error": e.msg})
      jsonResponse(request, Http500, %*{"status": "error", "error": e.msg})
  )

  result.get("/states", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let (sceneId, states) = getAllPublicStates()
      jsonResponse(request, Http200, %*{"sceneId": $sceneId, "states": states})
  )

  result.get("/getUploadedScenes", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let payload = %*{"scenes": getUploadedScenePayload()}
      jsonResponse(request, Http200, payload)
  )

  result.get("/state", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let (sceneId, state, _, _) = getLastPublicState()
      jsonResponse(request, Http200, %*{"sceneId": $sceneId, "state": state})
  )

  result.get("/c", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
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
      let controlHtml = webAssets.getAsset("assets/compiled/web/control.html").
        replace("/*$$fieldsHtml$$*/", fieldsHtml).
        replace("/*$$fieldsSubmitHtml$$*/", fieldsSubmitHtml).
        replace("/*$$sceneOptionsHtml$$*/", sceneOptionsHtml).
        replace("Frame Control", if globalFrameConfig.name != "": h(globalFrameConfig.name) else: "Frame Control")
      request.respond(Http200, body = controlHtml)
  )

  result.notFoundHandler = proc(request: Request) =
    log(%*{"event": "404", "path": request.path})
    request.respond(Http404, body = "Not found!")

proc listenForRenderThread(args: tuple[publicState: ConnectionsState, adminState: ConnectionsState]) {.thread.} =
  while true:
    if hasConnections(args.publicState) or hasConnections(args.adminState):
      let (dataAvailable, _) = serverChannel.tryRecv()
      if dataAvailable:
        if hasConnections(args.publicState):
          sendToAll(args.publicState, "render")
        if hasConnections(args.adminState):
          sendToAll(args.adminState, "render")
        log(%*{"event": "websocket:send", "message": "render"})
      sleep(10)
    else:
      sleep(100)

proc listenForLogThread(connectionsState: ConnectionsState) {.thread.} =
  while true:
    let (success, payload) = logBroadcastChannel.tryRecv()
    if success:
      let uiLog = toUiLog(payload)
      storeUiLog(uiLog)
      if hasConnections(connectionsState):
        sendToAll(connectionsState, $(%*{"event": "new_log", "data": uiLog}))
    else:
      sleep(10)

var renderThread: Thread[tuple[publicState: ConnectionsState, adminState: ConnectionsState]]
var logThread: Thread[ConnectionsState]

proc newServer*(frameOS: FrameOS): types.Server =
  globalFrameOS = frameOS
  globalFrameConfig = frameOS.frameConfig
  globalRunner = frameOS.runner
  globalAdminSessionSalt = getOrCreateAdminSessionSalt(getConfigFilename())
  initLock(globalRecentLogsLock)
  globalRecentLogs = @[]
  globalRecentLogId = 0

  let connectionsState = initConnectionsState()
  let adminConnectionsState = initConnectionsState()
  globalAdminConnectionsState = adminConnectionsState
  let router = buildRouter(connectionsState, adminConnectionsState)
  let routerHandler = router.toHandler()
  let loggingHandler = proc(request: Request) {.gcsafe.} =
    log(%*{"event": "http", "method": request.httpMethod, "path": request.path})
    routerHandler(request)
  let mummyServer = mummy.newServer(loggingHandler, makeWebsocketHandler(connectionsState, adminConnectionsState))

  result = types.Server(
    frameConfig: frameOS.frameConfig,
    runner: frameOS.runner,
    mummy: mummyServer,
    connectionsState: connectionsState,
  )

proc startServer*(self: types.Server) =
  log(%*{"event": "http:start", "message": "Starting web server"})
  # mummy.serve blocks this thread, so run render notifications in a background thread.
  createThread(renderThread, listenForRenderThread, (self.connectionsState, globalAdminConnectionsState))
  createThread(logThread, listenForLogThread, globalAdminConnectionsState)

  let port = (if self.frameConfig.framePort == 0: 8787 else: self.frameConfig.framePort).Port
  let bindAddr = if self.frameConfig.httpsProxy.enable and self.frameConfig.httpsProxy.exposeOnlyPort: "127.0.0.1" else: "0.0.0.0"
  self.mummy.serve(port = port, address = bindAddr)
