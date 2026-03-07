import json
import base64
import pixie
import chroma
import times
import std/[os, osproc, strformat, strutils, tables, algorithm]
import locks
import checksums/md5
import zippy
import mummy
import httpcore
import assets/web as webAssets
import assets/apps as appsAsset
import drivers/drivers as drivers
import frameos/apps
import frameos/types
import frameos/utils/image
import frameos/utils/font
import frameos/config
from frameos/scenes import getLastImagePng, getLastPublicState, getAllPublicStates, getUploadedScenePayload,
    getDynamicSceneOptions
from scenes/scenes import sceneOptions
import ./state

proc h*(message: string): string =
  message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#039;")

proc s*(message: string): string =
  message.replace("'", "\\'").replace("\n", "\\n")

proc contentTypeForAsset*(path: string): string =
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

proc configuredAssetsPath*(): string =
  normalizedPath(if globalFrameConfig.assetsPath.len > 0: globalFrameConfig.assetsPath else: "/srv/assets")

proc uploadChunkTempRoot(): string =
  normalizedPath(getTempDir() / "frameos-upload-chunks")

proc withinBasePath*(path, basePath: string): bool =
  let normalizedTargetPath = normalizedPath(path)
  let normalizedBasePath = normalizedPath(basePath)
  return normalizedTargetPath == normalizedBasePath or normalizedTargetPath.startsWith(normalizedBasePath & DirSep)

proc sanitizeAssetComponent(value: string, fallback: string, allowDot = false): string =
  result = ""
  for ch in value:
    if ch.isAlphaNumeric() or ch in {'-', '_'} or (allowDot and ch == '.'):
      result.add(ch)
    else:
      result.add('_')
  result = result.strip(chars = {'_', '.'})
  if result.len == 0:
    result = fallback

proc sanitizeAssetExtension(value: string): string =
  result = ""
  for ch in value:
    if ch == '.' or ch.isAlphaNumeric():
      result.add(ch)
  if result.len > 0 and not result.startsWith("."):
    result = "." & result

proc sanitizeUploadId(uploadId: string): string =
  let safeId = sanitizeAssetComponent(uploadId, "")
  if safeId.len == 0:
    raise newException(ValueError, "Missing upload id")
  safeId

proc uploadChunkTempPath(uploadId: string): string =
  normalizedPath(uploadChunkTempRoot() / (sanitizeUploadId(uploadId) & ".part"))

proc resolveAssetPath*(path: string, allowRoot = false): string =
  let assetsPath = configuredAssetsPath()
  let stripped = path.strip()
  if stripped.len == 0:
    if allowRoot:
      return assetsPath
    raise newException(ValueError, "Path is required")

  var relPath = stripped
  while relPath.startsWith("./"):
    relPath = relPath[2 .. ^1]
  while relPath.startsWith("/"):
    relPath = relPath[1 .. ^1]

  let fullPath = normalizedPath(assetsPath / relPath)
  if not withinBasePath(fullPath, assetsPath):
    raise newException(ValueError, "Invalid asset path")
  if not allowRoot and fullPath == assetsPath:
    raise newException(ValueError, "Path is required")
  fullPath

proc relativeAssetPath*(path: string): string =
  let assetsPath = configuredAssetsPath()
  let fullPath = normalizedPath(path)
  if fullPath == assetsPath:
    ""
  else:
    fullPath[(assetsPath.len + 1) .. ^1]

proc resolveAssetUploadPath(subdir: string, filename: string): string =
  let safeFilename = sanitizeAssetComponent(extractFilename(filename), "uploaded_file", allowDot = true)
  if subdir.strip().len == 0:
    resolveAssetPath(safeFilename)
  else:
    resolveAssetPath(subdir / safeFilename)

proc contentTypeForFilePath*(path: string): string =
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

proc assetPayloadForPath*(path: string): JsonNode =
  let fullPath = normalizedPath(path)
  let isDir = dirExists(fullPath)
  let info = getFileInfo(fullPath)
  %*{
    "path": fullPath,
    "size": if isDir: BiggestInt(0) else: info.size,
    "mtime": info.lastWriteTime.toUnix(),
    "is_dir": isDir,
  }

proc decodeDataUrlPayload*(value: string): string =
  let commaIndex = value.find(',')
  if commaIndex < 0:
    raise newException(ValueError, "Invalid upload payload")
  let header = value[0 ..< commaIndex]
  if ";base64" notin header:
    raise newException(ValueError, "Invalid upload payload")
  decode(value[(commaIndex + 1) .. ^1])

proc saveAssetUploadPayload*(subdir: string, filename: string, data: string): JsonNode =
  let targetPath = resolveAssetUploadPath(subdir, filename)
  createDir(parentDir(targetPath))
  writeFile(targetPath, data)
  assetPayloadForPath(targetPath)

proc saveUploadedImagePayload*(filename: string, data: string): JsonNode =
  let originalName = extractFilename(if filename.strip().len > 0: filename else: "image")
  let (_, name, ext) = splitFile(originalName)
  let safeBase = sanitizeAssetComponent(name, "image")
  let safeExt = sanitizeAssetExtension(ext)
  let hashedFilename = &"{safeBase}.{getMD5(data)}{safeExt}"
  let targetPath = resolveAssetPath("uploads" / hashedFilename)
  createDir(parentDir(targetPath))
  let uploaded = not fileExists(targetPath)
  if uploaded:
    writeFile(targetPath, data)
  %*{
    "path": relativeAssetPath(targetPath),
    "filename": hashedFilename,
    "size": data.len,
    "uploaded": uploaded,
  }

proc createAssetDirectory*(path: string) =
  createDir(resolveAssetPath(path))

proc appendUploadChunk*(uploadId: string, chunkIndex: int, data: string) =
  let tempPath = uploadChunkTempPath(uploadId)
  createDir(parentDir(tempPath))
  var fileHandle = open(tempPath, if chunkIndex <= 0: fmWrite else: fmAppend)
  try:
    fileHandle.write(data)
  finally:
    fileHandle.close()

proc discardUploadChunk*(uploadId: string) =
  let tempPath = uploadChunkTempPath(uploadId)
  if fileExists(tempPath):
    removeFile(tempPath)

proc finishChunkedAssetUpload*(uploadId: string, subdir: string, filename: string): JsonNode =
  let tempPath = uploadChunkTempPath(uploadId)
  if not fileExists(tempPath):
    raise newException(OSError, "Upload not found")
  let targetPath = resolveAssetUploadPath(subdir, filename)
  createDir(parentDir(targetPath))
  if dirExists(targetPath):
    raise newException(ValueError, "Invalid asset path")
  if fileExists(targetPath):
    removeFile(targetPath)
  moveFile(tempPath, targetPath)
  assetPayloadForPath(targetPath)

proc finishChunkedImageUpload*(uploadId: string, filename: string): JsonNode =
  let tempPath = uploadChunkTempPath(uploadId)
  if not fileExists(tempPath):
    raise newException(OSError, "Upload not found")
  try:
    saveUploadedImagePayload(filename, readFile(tempPath))
  finally:
    discardUploadChunk(uploadId)

proc deleteAssetEntry*(path: string) =
  let targetPath = resolveAssetPath(path)
  if fileExists(targetPath):
    removeFile(targetPath)
  elif dirExists(targetPath):
    removeDir(targetPath)
  else:
    raise newException(OSError, "Asset not found")

proc renameAssetEntry*(srcPath: string, dstPath: string) =
  let sourcePath = resolveAssetPath(srcPath)
  let targetPath = resolveAssetPath(dstPath)
  if not fileExists(sourcePath) and not dirExists(sourcePath):
    raise newException(OSError, "Asset not found")
  createDir(parentDir(targetPath))
  if dirExists(sourcePath):
    moveDir(sourcePath, targetPath)
  else:
    moveFile(sourcePath, targetPath)

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

proc frameAssetsPayload*(): JsonNode =
  let assetsPath = configuredAssetsPath()
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
        "size": if kind == pcFile: info.size else: BiggestInt(0),
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

proc getAssetPayload*(path: string, thumb: bool): tuple[status: httpcore.HttpCode, headers: mummy.HttpHeaders, body: string] =
  let assetsPath = configuredAssetsPath()
  let relPath = path.strip()
  if relPath.len == 0:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    return (Http400, headers, $(%*{"detail": "Path is required"}))

  let fullPath =
    try:
      resolveAssetPath(relPath)
    except ValueError:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      return (Http400, headers, $(%*{"detail": "Invalid path"}))
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

proc frameApiPayload*(connectionsState: ConnectionsState): JsonNode =
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
    "server_send_logs": globalFrameConfig.serverSendLogs,
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

proc buildFrameImageResponse*(request: Request): tuple[status: httpcore.HttpCode, headers: mummy.HttpHeaders, body: string] =
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
    let controlHtml = webAssets.getAsset("assets/compiled/web/control.html").
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
