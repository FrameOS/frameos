import json
import os
import strutils
import threadpool
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/config
import frameos/device_setup
import frameos/types
import frameos/utils/process
import ../state
import ../auth
import ../api
import ../backend_client
import ../config_update
import ./admin_api_assets_routes
import ./common

proc ensureFrameApiReadAccess(request: Request): bool =
  if not hasAdminAccess(request):
    request.respond(Http401, body = "Unauthorized")
    return false
  true

proc delayedSelfRestart() =
  # Give mummy time to flush the response; systemd (Restart=always) brings
  # the service back up.
  sleep(500)
  quit(0)

proc delayedReboot() =
  sleep(500)
  discard runShellWithParentStreams(privilegedCommand("reboot"), timeoutMs = 30_000)

proc delayedAgentRestart() =
  # Best effort: the agent only re-reads frame.json on startup, so restart it
  # after adoption hands it new credentials. No-op outside a device install.
  sleep(500)
  if fileExists("/etc/systemd/system/frameos_agent.service"):
    discard runShellWithParentStreams(
      privilegedCommand("systemctl restart frameos_agent"), timeoutMs = 30_000)

proc addFrameApiRoutes*(router: var Router, connectionsState: ConnectionsState) =
  router.get("/api/apps", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      request.respond(Http200, headers, appsPayload())
  )

  router.get("/api/apps/source", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      let keyword = request.queryParams.getOrDefault("keyword", "")
      let sources = appSourcePayload(keyword)
      if sources == nil:
        jsonResponse(request, Http404, %*{"detail": "App sources not found"})
      else:
        jsonResponse(request, Http200, sources)
  )

  router.post("/api/apps/validate_source", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      # The device has no Nim/JS toolchain to lint with; JSON is checked
      # locally and everything else passes through. Saved app sources are
      # still parsed (and errors reported) when the scene actually runs.
      try:
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        let file = payload{"file"}.getStr("")
        let source = payload{"source"}.getStr("")
        var errors: seq[JsonNode] = @[]
        if file.endsWith(".json"):
          try:
            discard parseJson(source)
          except JsonParsingError as e:
            errors.add(%*{"line": 1, "column": 1, "error": e.msg})
        jsonResponse(request, Http200, %*{"errors": errors})
      except CatchableError as e:
        jsonResponse(request, Http400, %*{"detail": e.msg})
  )

  router.get("/api/frames", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      let framePayload = frameApiPayload(connectionsState, exposeSecrets = canAccessFrameSecrets(request))
      jsonResponse(request, Http200, %*{"frames": @[framePayload]})
  )

  router.get("/api/frames/@id", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let framePayload = frameApiPayload(connectionsState, exposeSecrets = canAccessFrameSecrets(request))
        jsonResponse(request, Http200, %*{"frame": framePayload})
  )

  router.post("/api/frames/@id", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      try:
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        let configPath = getConfigFilename()
        let current = parseJson(readFile(configPath))
        let update = applyFrameConfigUpdate(current, payload)
        var changedKeys = update.changedKeys
        var backupPath = ""
        var scenesChanged = false
        if payload.hasKey("scenes") and payload["scenes"].kind == JArray:
          scenesChanged = applyScenesUpdate(payload["scenes"])
          if scenesChanged:
            changedKeys.add("scenes")
        if update.changedKeys.len > 0:
          backupPath = writeFrameConfig(configPath, update.config)
          if update.adminAuthChanged:
            clearAdminSessions()
        if changedKeys.len > 0:
          log(%*{"event": "config:update", "keys": %changedKeys, "backup": backupPath})
          # The runner's reload handler re-reads frame.json and the
          # interpreted scenes from disk, so saved scenes go live immediately.
          sendEvent("reload", %*{})

        case payload{"next_action"}.getStr("")
        of "render": sendEvent("render", %*{})
        of "restart": spawn delayedSelfRestart()
        of "reboot": spawn delayedReboot()
        else: discard

        jsonResponse(request, Http200, %*{
          "status": "ok",
          "changed": %changedKeys,
          "backup": backupPath,
        })
      except CatchableError as e:
        log(%*{"event": "config:update:error", "error": e.msg})
        jsonResponse(request, Http400, %*{"detail": e.msg})
  )

  router.post("/api/frames/@id/adopt", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      try:
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        let serverHost = payload{"serverHost"}.getStr("").strip()
        let serverPort = payload{"serverPort"}.getInt(8989)
        let code = payload{"code"}.getStr("").strip()
        if serverHost.len == 0 or code.len == 0:
          jsonResponse(request, Http400, %*{"detail": "Backend host and adoption code are required"})
          return

        let adoptUrl = backendBaseUrl(serverHost, serverPort) & "/api/frame_device/adopt"
        let adoptPayload = %*{
          "code": code,
          "name": globalFrameConfig.name,
          "mode": globalFrameConfig.mode,
          "device": globalFrameConfig.device,
          "width": globalFrameConfig.width,
          "height": globalFrameConfig.height,
          "framePort": globalFrameConfig.framePort,
          "frameAccess": globalFrameConfig.frameAccess,
          "frameAccessKey": globalFrameConfig.frameAccessKey,
          "frameosVersion": frameosVersionString(),
        }
        log(%*{"event": "adopt:request", "url": adoptUrl})
        let (status, body) = postBackendJson(adoptUrl, adoptPayload)
        if status != 200:
          log(%*{"event": "adopt:error", "status": status, "detail": body{"detail"}.getStr("")})
          jsonResponse(request, Http400, %*{
            "detail": "Backend rejected the adoption request: " & body{"detail"}.getStr($status)
          })
          return

        let serverApiKey = body{"serverApiKey"}.getStr("")
        let agentSharedSecret = body{"agentSharedSecret"}.getStr("")
        if serverApiKey.len == 0 or agentSharedSecret.len == 0:
          jsonResponse(request, Http400, %*{"detail": "Backend response was missing credentials"})
          return

        let configPath = getConfigFilename()
        var config = parseJson(readFile(configPath))
        config["serverHost"] = %serverHost
        config["serverPort"] = %serverPort
        config["serverApiKey"] = %serverApiKey
        config["serverSendLogs"] = %true
        var agent = if config.hasKey("agent") and config["agent"].kind == JObject: config["agent"]
                    else: newJObject()
        agent["agentEnabled"] = %true
        agent["agentRunCommands"] = %true
        agent["agentSharedSecret"] = %agentSharedSecret
        config["agent"] = agent
        let backupPath = writeFrameConfig(configPath, config)
        log(%*{"event": "adopt:success", "backend": serverHost & ":" & $serverPort, "backup": backupPath})
        sendEvent("reload", %*{})
        spawn delayedAgentRestart()
        jsonResponse(request, Http200, %*{
          "status": "ok",
          "frameId": body{"frameId"}.getInt(0),
          "backend": serverHost & ":" & $serverPort,
        })
      except CatchableError as e:
        log(%*{"event": "adopt:error", "error": e.msg})
        jsonResponse(request, Http400, %*{"detail": e.msg})
  )

  router.post("/api/frames/@id/request_update", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      try:
        if globalFrameConfig.serverHost.len == 0 or globalFrameConfig.serverApiKey.len == 0:
          jsonResponse(request, Http400, %*{
            "detail": "This frame is not connected to a backend. Connect it to a backend to install updates."
          })
          return
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        let target = payload{"target"}.getStr("frameos")
        let url = backendBaseUrl(globalFrameConfig.serverHost, globalFrameConfig.serverPort) &
          "/api/frame_device/request_update"
        log(%*{"event": "update:request", "target": target})
        let (status, body) = postBackendJson(url, %*{"target": target}, globalFrameConfig.serverApiKey)
        if status != 200:
          jsonResponse(request, Http400, %*{
            "detail": "Backend rejected the update request: " & body{"detail"}.getStr($status)
          })
          return
        jsonResponse(request, Http200, body)
      except CatchableError as e:
        log(%*{"event": "update:request:error", "error": e.msg})
        jsonResponse(request, Http400, %*{"detail": e.msg})
  )

  router.post("/api/frames/@id/restart", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        log(%*{"event": "admin:restart"})
        spawn delayedSelfRestart()
        jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/api/frames/@id/reboot", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        log(%*{"event": "admin:reboot"})
        spawn delayedReboot()
        jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.get("/api/frames/@id/ping", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
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

  router.get("/api/frames/@id/state", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let payload = frameStatePayload()
        jsonResponse(request, Http200, %*{"sceneId": $payload.sceneId, "state": payload.state})
  )

  router.get("/api/frames/@id/states", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let payload = frameStatesPayload()
        jsonResponse(request, Http200, %*{"sceneId": $payload.sceneId, "states": payload.states})
  )

  router.get("/api/frames/@id/uploaded_scenes", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"scenes": uploadedScenesPayload()})
  )

  router.get("/api/frames/@id/logs", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"logs": getUiLogs()})
  )

  router.get("/api/frames/@id/metrics", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"metrics": getUiMetrics()})
  )

  router.get("/api/frames/@id/metrics/recent", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        # The on-device buffer only keeps the most recent entries, so the
        # backend's limit/since parameters are satisfied by construction.
        jsonResponse(request, Http200, %*{"metrics": getUiMetrics()})
  )

  router.get("/api/frames/@id/assets", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"assets": frameAssetsPayload()})
  )

  router.get("/api/frames/@id/asset", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let path = request.queryParams.getOrDefault("path", "")
        let thumb = request.queryParams.getOrDefault("thumb", "") == "1"
        let (status, headers, body) = getAssetPayload(path, thumb)
        request.respond(status, headers, body)
  )

  router.get("/api/frames/@id/image", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let (status, headers, body) = buildFrameImageResponse(request)
        request.respond(status, headers, body)
  )

  router.head("/api/frames/@id/image", proc(request: Request) {.gcsafe.} =
    # The UI probes images with HEAD to decide whether to refresh placeholders.
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let (status, headers, _) = buildFrameImageResponse(request)
        request.respond(status, headers, "")
  )

  router.get("/api/frames/@id/scene_images/@sceneId", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let (status, headers, body) = buildFrameImageResponse(request)
        request.respond(status, headers, body)
  )
