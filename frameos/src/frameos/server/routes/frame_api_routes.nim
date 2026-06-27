import json
import os
import strutils
import mummy
import mummy/routers
import httpcore
import frameos/config
import frameos/types
import frameos/channels
import frameos/utils/font
import frameos/scenes
import ../state
import ../auth
import ../api
import ./admin_api_assets_routes
import ./common

proc ensureFrameApiReadAccess(request: Request): bool =
  if not hasAdminAccess(request):
    request.respond(Http401, body = "Unauthorized")
    return false
  true

proc recentMetricsPayload(request: Request): JsonNode {.gcsafe.} =
  let since = request.queryParams.getOrDefault("since", "")
  var limit = 1000
  try:
    limit = parseInt(request.queryParams.getOrDefault("limit", "1000"))
  except ValueError:
    limit = 1000
  limit = max(1, min(limit, 1000))

  let metrics = getUiMetrics()
  var filtered = newJArray()
  for metric in metrics:
    if since.len == 0 or metric{"timestamp"}.getStr("") >= since:
      filtered.add(metric)

  result = newJArray()
  let start = max(0, filtered.len - limit)
  for index in start ..< filtered.len:
    result.add(filtered[index])

proc storedSceneImagePayload(sceneId: string): tuple[status: HttpCode, headers: mummy.HttpHeaders, body: string] =
  var headers: mummy.HttpHeaders
  headers["Cache-Control"] = "no-cache"
  let path = sceneImagePath(configuredAssetsPath(), sceneId)
  if not fileExists(path):
    headers["Content-Type"] = "application/json"
    return (Http404, headers, $(%*{"detail": "Scene image not found"}))

  headers["Content-Type"] = contentTypeForFilePath(path)
  headers["Content-Disposition"] = "inline; filename=\"" & sceneImageFilename(sceneId) & "\""
  (Http200, headers, readFile(path))

proc saveStoredSceneImagePayload(sceneId: string, body: string): JsonNode =
  let savedImage = saveSceneImagePng(configuredAssetsPath(), sceneId, body)
  %*{
    "scene_id": savedImage.sceneId,
    "path": sceneImageRelativePath(configuredAssetsPath(), savedImage.path),
    "size": savedImage.size,
  }

proc queueRuntimeControl(request: Request, action: string, eventName: string) {.gcsafe.} =
  try:
    {.gcsafe.}:
      discard loadConfig()
    sendEvent(eventName, %*{})
    jsonResponse(request, Http200, %*{"status": "ok", "action": action})
  except CatchableError as e:
    log(%*{"event": action & ":error", "error": e.msg})
    jsonResponse(request, Http500, %*{"status": "error", "error": e.msg})

proc addFrameApiRoutes*(router: var Router, connectionsState: ConnectionsState) =
  router.get("/api/apps", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      request.respond(Http200, headers, appsPayload())
  )

  router.get("/api/fonts", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      var fonts: seq[JsonNode] = @[]
      for font in getAvailableFonts(globalFrameConfig.assetsPath):
        if font.len > 0:
          fonts.add(%*{
            "file": font,
            "name": splitFile(font).name,
            "weight": 400,
            "weight_title": "Regular",
            "italic": font.toLowerAscii().contains("italic"),
          })
      jsonResponse(request, Http200, %*{"fonts": fonts})
  )

  router.get("/api/fonts/@font", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      let font = request.pathParams["font"]
      if font.len == 0 or "/" in font or "\\" in font or ".." in font:
        request.respond(Http400, body = "Invalid font filename")
        return
      let path = globalFrameConfig.assetsPath / "fonts" / font
      if not fileExists(path):
        request.respond(Http404, body = "Font not found")
        return
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "font/ttf"
      headers["Cache-Control"] = "max-age=86400"
      request.respond(Http200, headers, readFile(path))
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
        jsonResponse(request, Http200, %*{"metrics": recentMetricsPayload(request)})
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

  router.get("/api/frames/@id/scene_images/@sceneId", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let (status, headers, body) = storedSceneImagePayload(request.pathParams["sceneId"])
        request.respond(status, headers, body)
  )

  router.post("/api/frames/@id/scene_images/@sceneId", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      if request.body.len == 0:
        jsonResponse(request, Http400, %*{"detail": "Missing image payload"})
        return
      jsonResponse(request, Http201, saveStoredSceneImagePayload(request.pathParams["sceneId"], request.body))
  )

  router.post("/api/frames/@id", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      let payload =
        try:
          parseJson(if request.body.strip().len == 0: "{}" else: request.body)
        except JsonParsingError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return
      try:
        persistFrameApiUpdate(payload)
        let skipRuntimeReload = payload{"skip_runtime_reload"}.getBool(false)
        if not skipRuntimeReload:
          sendEvent("reload", %*{})
        let nextAction = payload{"next_action"}.getStr("")
        if nextAction == "render":
          sendEvent("render", %*{})
        let framePayload = frameApiPayload(connectionsState, exposeSecrets = canAccessFrameSecrets(request))
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = "application/json"
        if adminPanelEnabled():
          headers["Set-Cookie"] = adminSessionCookieHeader(request, createAdminSession())
        request.respond(Http200, headers, $(%*{"message": "Frame updated successfully", "frame": framePayload}))
      except CatchableError as e:
        jsonResponse(request, Http500, %*{"detail": e.msg})
  )

  router.post("/api/frames/@id/reload", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      queueRuntimeControl(request, "reload", "reload")
  )

  router.post("/api/frames/@id/restart", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      queueRuntimeControl(request, "restart", "restart")
  )

  router.post("/api/frames/@id/upload_scenes", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      let payload =
        try:
          parseJson(if request.body.strip().len == 0: "{}" else: request.body)
        except JsonParsingError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return
      sendEvent("uploadScenes", payload)
      jsonResponse(request, Http200, %*{"status": "ok"})
  )
