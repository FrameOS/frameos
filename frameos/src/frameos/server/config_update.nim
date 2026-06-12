## Applies config updates coming from the on-device admin UI.
##
## The on-device admin has no backend to persist to: the release's own
## frame.json (e.g. /srv/frameos/releases/release_*/frame.json via the
## /srv/frameos/current symlink) is the single source of truth. Every save
## first copies the current frame.json to a timestamped .bak file in the same
## release folder, then writes the new config atomically and asks the runner
## to reload.
##
## The incoming payload uses the backend's snake_case frame fields (the same
## body the backend's POST /api/frames/{id} accepts), and is mapped onto the
## camelCase keys of frame.json. Only runtime-editable keys are accepted;
## anything that requires a rebuild or a redeploy (mode, device, scenes,
## SSH settings, ...) is ignored.

import algorithm, json, os, strutils, times, zippy

import frameos/config

const maxConfigBackups* = 10

type ConfigUpdateResult* = object
  config*: JsonNode
  changedKeys*: seq[string]
  adminAuthChanged*: bool

proc configBackupPaths*(configPath: string): seq[string] =
  result = @[]
  for path in walkFiles(configPath & ".bak.*"):
    result.add(path)
  sort(result)

proc pruneConfigBackups*(configPath: string, keep = maxConfigBackups) =
  var backups = configBackupPaths(configPath)
  while backups.len > keep:
    try:
      removeFile(backups[0])
    except CatchableError:
      discard
    backups.delete(0)

proc backupConfigFile*(configPath: string): string =
  ## Copies frame.json to frame.json.bak.<utc timestamp> next to it (i.e. into
  ## the same release folder) and prunes old backups. Returns the backup path.
  if not fileExists(configPath):
    return ""
  let stamp = now().utc.format("yyyyMMdd'T'HHmmss")
  var candidate = configPath & ".bak." & stamp
  var counter = 1
  while fileExists(candidate):
    candidate = configPath & ".bak." & stamp & "-" & $counter
    inc counter
  copyFile(configPath, candidate)
  pruneConfigBackups(configPath)
  candidate

proc deepEquals(a, b: JsonNode): bool =
  if a.isNil and b.isNil: return true
  if a.isNil or b.isNil: return false
  a == b

proc setKey(result: var ConfigUpdateResult, key: string, value: JsonNode) =
  if not deepEquals(result.config{key}, value):
    result.config[key] = value
    result.changedKeys.add(key)

proc copyString(result: var ConfigUpdateResult, payload: JsonNode, fromKey, toKey: string) =
  if payload.hasKey(fromKey) and payload[fromKey].kind == JString:
    setKey(result, toKey, payload[fromKey])

proc copyInt(result: var ConfigUpdateResult, payload: JsonNode, fromKey, toKey: string) =
  if payload.hasKey(fromKey) and payload[fromKey].kind in {JInt, JFloat}:
    setKey(result, toKey, %payload[fromKey].getInt())

proc copyFloat(result: var ConfigUpdateResult, payload: JsonNode, fromKey, toKey: string) =
  if payload.hasKey(fromKey) and payload[fromKey].kind in {JInt, JFloat}:
    setKey(result, toKey, %payload[fromKey].getFloat())

proc copyBool(result: var ConfigUpdateResult, payload: JsonNode, fromKey, toKey: string) =
  if payload.hasKey(fromKey) and payload[fromKey].kind == JBool:
    setKey(result, toKey, payload[fromKey])

proc copyRaw(result: var ConfigUpdateResult, payload: JsonNode, fromKey, toKey: string) =
  if payload.hasKey(fromKey):
    setKey(result, toKey, payload[fromKey])

proc parseJsonNumber(node: JsonNode, fallback: float): float =
  if node.isNil:
    return fallback
  case node.kind
  of JInt, JFloat: node.getFloat(fallback)
  of JString:
    try: parseFloat(node.getStr())
    except CatchableError: fallback
  else: fallback

proc frameAdminAuthJson(payload: JsonNode): JsonNode =
  ## Mirrors the backend's frameAdminAuth serialization: user/pass only when set.
  result = %*{"enabled": payload{"enabled"}.getBool(false)}
  let user = payload{"user"}.getStr("")
  let pass = payload{"pass"}.getStr("")
  if user.len > 0: result["user"] = %user
  if pass.len > 0: result["pass"] = %pass

proc controlCodeJson(payload: JsonNode): JsonNode =
  ## The UI sends the backend's storage format (string booleans/numbers);
  ## frame.json stores real booleans and numbers.
  let enabledNode = payload{"enabled"}
  let enabled =
    if enabledNode.isNil: false
    elif enabledNode.kind == JBool: enabledNode.getBool(false)
    else: enabledNode.getStr("false") == "true"
  if not enabled:
    return %*{"enabled": false}
  %*{
    "enabled": true,
    "position": payload{"position"}.getStr("top-right"),
    "size": parseJsonNumber(payload{"size"}, 2),
    "padding": int(parseJsonNumber(payload{"padding"}, 1)),
    "offsetX": int(parseJsonNumber(payload{"offsetX"}, 0)),
    "offsetY": int(parseJsonNumber(payload{"offsetY"}, 0)),
    "qrCodeColor": payload{"qrCodeColor"}.getStr("#000000"),
    "backgroundColor": payload{"backgroundColor"}.getStr("#ffffff"),
  }

proc timeZoneUpdatesJson(payload: JsonNode): JsonNode =
  if payload.kind != JObject:
    return %*{"enabled": true, "hour": 3, "url": "https://tz.frameos.net/tzdata.json.gz"}
  %*{
    "enabled": payload{"enabled"}.getBool(true),
    "hour": payload{"hour"}.getInt(3),
    "url": payload{"url"}.getStr("https://tz.frameos.net/tzdata.json.gz"),
  }

proc errorBehaviorJson(payload: JsonNode): JsonNode =
  %*{
    "mode": payload{"mode"}.getStr("show_error_retry"),
    "retrySeconds": parseJsonNumber(payload{"retry_seconds"}, 60),
    "silentRetrySeconds": parseJsonNumber(payload{"silent_retry_seconds"}, 60),
    "silentRetryForever": payload{"silent_retry_forever"}.getBool(false),
    "silentWindowMinutes": parseJsonNumber(payload{"silent_window_minutes"}, 10),
    "showErrorRetrySeconds": parseJsonNumber(payload{"show_error_retry_seconds"}, 60),
  }

proc applyFrameConfigUpdate*(current: JsonNode, payload: JsonNode): ConfigUpdateResult =
  ## Returns a new config JSON with the whitelisted payload fields applied.
  result = ConfigUpdateResult(config: current.copy(), changedKeys: @[])
  if payload.kind != JObject:
    return

  copyString(result, payload, "name", "name")
  copyString(result, payload, "frame_access", "frameAccess")
  copyString(result, payload, "frame_access_key", "frameAccessKey")
  copyInt(result, payload, "width", "width")
  copyInt(result, payload, "height", "height")
  copyInt(result, payload, "rotate", "rotate")
  copyString(result, payload, "flip", "flip")
  copyString(result, payload, "scaling_mode", "scalingMode")
  copyString(result, payload, "image_engine", "imageEngine")
  copyFloat(result, payload, "interval", "interval")
  copyFloat(result, payload, "metrics_interval", "metricsInterval")
  copyInt(result, payload, "max_http_response_bytes", "maxHttpResponseBytes")
  copyString(result, payload, "background_color", "backgroundColor")
  copyRaw(result, payload, "color", "color")
  copyBool(result, payload, "debug", "debug")
  copyString(result, payload, "log_to_file", "logToFile")
  copyString(result, payload, "assets_path", "assetsPath")
  copyRaw(result, payload, "save_assets", "saveAssets")
  copyString(result, payload, "timezone", "timeZone")
  copyRaw(result, payload, "schedule", "schedule")
  copyRaw(result, payload, "gpio_buttons", "gpioButtons")
  copyRaw(result, payload, "palette", "palette")
  copyRaw(result, payload, "network", "network")
  copyRaw(result, payload, "agent", "agent")
  copyString(result, payload, "server_host", "serverHost")
  copyInt(result, payload, "server_port", "serverPort")
  copyString(result, payload, "server_api_key", "serverApiKey")
  copyBool(result, payload, "server_send_logs", "serverSendLogs")

  if payload.hasKey("timezone_updater"):
    setKey(result, "timeZoneUpdates", timeZoneUpdatesJson(payload["timezone_updater"]))
  if payload.hasKey("control_code") and payload["control_code"].kind == JObject:
    setKey(result, "controlCode", controlCodeJson(payload["control_code"]))
  if payload.hasKey("error_behavior") and payload["error_behavior"].kind == JObject:
    setKey(result, "errorBehavior", errorBehaviorJson(payload["error_behavior"]))
  if payload.hasKey("frame_admin_auth") and payload["frame_admin_auth"].kind == JObject:
    let previous = result.config{"frameAdminAuth"}
    setKey(result, "frameAdminAuth", frameAdminAuthJson(payload["frame_admin_auth"]))
    result.adminAuthChanged = not deepEquals(previous, result.config{"frameAdminAuth"})

## Scene updates from the on-device admin.
##
## Scenes live next to the binary in two files (see setup.nim's
## writeSetupReleasePayload and the backend's deploy workflow):
##   - all_scenes.json[.gz]: the full scene payload, served back through
##     GET /api/frames so editors (and backend drift checks) see every scene.
##   - scenes.json[.gz]: only scenes with settings.execution == "interpreted";
##     this is what the runner (re)loads and executes.
## A save rewrites both with the same backup/atomic-write treatment as
## frame.json. Scenes compiled into the binary can't be rebuilt here: their
## edits persist to all_scenes.json but only take effect once the scene runs
## interpreted (or is redeployed from a backend).

proc scenesFilePath(envVar: string, plainPath, gzPath: string): string =
  let configured = getEnv(envVar)
  if configured.len > 0:
    return configured
  if fileExists(plainPath) and not fileExists(gzPath):
    return plainPath
  gzPath

proc allScenesJsonPath*(): string =
  scenesFilePath("FRAMEOS_ALL_SCENES_JSON", "./all_scenes.json", "./all_scenes.json.gz")

proc interpretedScenesJsonPath*(): string =
  scenesFilePath("FRAMEOS_SCENES_JSON", "./scenes.json", "./scenes.json.gz")

proc readScenesArray*(path: string): JsonNode =
  ## Returns the JSON array stored at path (handling .gz), or nil.
  if not fileExists(path):
    return nil
  try:
    let encoded = readFile(path)
    let data = if path.endsWith(".gz"): uncompress(encoded) else: encoded
    let parsed = parseJson(data)
    if parsed.kind == JArray:
      return parsed
  except CatchableError:
    discard
  nil

proc filterInterpretedScenes*(scenes: JsonNode): JsonNode =
  ## Mirrors setup.nim's setupExportScenes: only interpreted-execution scenes
  ## are handed to the runner.
  result = newJArray()
  if scenes == nil or scenes.kind != JArray:
    return
  for scene in scenes.items:
    if scene == nil or scene.kind != JObject:
      continue
    if scene{"settings"}{"execution"}.getStr("compiled") == "interpreted":
      result.add(scene)

proc writeScenesFile(path: string, scenes: JsonNode) =
  let rendered = pretty(scenes, indent = 4) & "\n"
  let data = if path.endsWith(".gz"): compress(rendered, dataFormat = dfGzip) else: rendered
  let tmpPath = path & ".tmp"
  writeFile(tmpPath, data)
  discard backupConfigFile(path)
  moveFile(tmpPath, path)

proc applyScenesUpdate*(scenes: JsonNode): bool =
  ## Persists a new scene payload coming from the admin UI. Returns true when
  ## anything changed (the caller should then send a "reload" event so the
  ## runner hot-swaps the interpreted scenes).
  if scenes == nil or scenes.kind != JArray:
    raise newException(ValueError, "Scenes must be a JSON array")
  let allPath = allScenesJsonPath()
  let current = readScenesArray(allPath)
  if current != nil and current == scenes:
    return false
  writeScenesFile(allPath, scenes)
  writeScenesFile(interpretedScenesJsonPath(), filterInterpretedScenes(scenes))
  true

proc agentConfigPathFor*(configPath: string): string =
  ## The agent keeps its own copy of frame.json; on a standard install both
  ## live under /srv/frameos. Returns "" when this doesn't look like a device.
  const agentConfigPath = "/srv/frameos/agent/current/frame.json"
  if configPath.startsWith("/srv/frameos/") and fileExists(agentConfigPath):
    return agentConfigPath
  ""

proc writeFrameConfig*(configPath: string, config: JsonNode): string =
  ## Backs up and atomically replaces frame.json. Validates that the new
  ## config still loads before activating it. Returns the backup path.
  config["configUpdatedAt"] = %epochTime()
  let rendered = config.pretty() & "\n"

  let tmpPath = configPath & ".tmp"
  writeFile(tmpPath, rendered)
  try:
    discard loadConfig(tmpPath) # raises if the new config can't be parsed
  except CatchableError:
    removeFile(tmpPath)
    raise

  result = backupConfigFile(configPath)
  moveFile(tmpPath, configPath)

  # Keep the agent's copy in sync so serverHost/apiKey/agent changes reach it.
  let agentPath = agentConfigPathFor(configPath)
  if agentPath.len > 0 and agentPath != configPath:
    try:
      discard backupConfigFile(agentPath)
      writeFile(agentPath & ".tmp", rendered)
      moveFile(agentPath & ".tmp", agentPath)
    except CatchableError:
      discard # the frame's own config saved fine; agent copy is best-effort
