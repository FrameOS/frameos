import json
import os
import strutils
import times
import mummy
import mummy/routers
import httpcore
import pixie
import frameos/config
import frameos/types
import frameos/channels
import frameos/utils/font
import frameos/utils/image
import frameos/utils/http_client
import frameos/utils/status_screen
import frameos/hal/files as halFiles
import frameos/scenes
import system/index/scene as indexScene
import ../state
import ../auth
import ../api
import ../embedded_assets
import ../listener_control
import ../settings_apply
import ./admin_api_assets_routes
import ./repository_api_routes
import ./common

const
  # The built-in status screen, `system/index` (system/scenes.nim): the one
  # scene every frame has. The admin panel lists it first, and asks for its
  # picture here like any other scene's.
  StatusScreenSceneId = "system/index"
  # How old the status screen's snapshot may be before a request for it
  # redraws the screen with today's facts (address, scene list, link code).
  # The runner refreshes it once a minute while the screen is on the panel;
  # this bound covers the time it is not.
  StatusScreenSnapshotMaxAgeSeconds = 600.0
  # A scene cover fetched for `POST …/scene_images/{id}/copy`. Store covers
  # are a few hundred kilobytes; the bound is the same one every other
  # device-side fetch has.
  SceneImageCopyMaxBytes = DefaultFetchMaxBytes
  SceneImageCopyTimeoutMs = 15_000

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

proc storedSceneImagePayload(sceneId: string, thumb = false): tuple[status: HttpCode, headers: mummy.HttpHeaders, body: string] =
  var headers: mummy.HttpHeaders
  headers["Cache-Control"] = "no-cache"
  let assetsPath = configuredAssetsPath()
  let path = sceneImagePath(assetsPath, sceneId)
  if not fileExists(path):
    headers["Content-Type"] = "application/json"
    return (Http404, headers, $(%*{"detail": "Scene image not found"}))

  if thumb:
    # `?thumb=1` used to be accepted and ignored, so every scene tile pulled
    # the full panel-size snapshot — three megabytes for a photo scene at
    # 1080p. The assets thumbnailer already caches under `.thumbs/`; a file
    # it cannot decode (a snapshot someone posted that is not an image)
    # falls back to the bytes as stored, which is what the tile got before.
    let (status, thumbHeaders, body) = getAssetPayload(sceneImageRelativePath(assetsPath, path), thumb = true)
    if status == Http200:
      var merged = thumbHeaders
      merged["Cache-Control"] = "no-cache"
      return (Http200, merged, body)

  headers["Content-Type"] = contentTypeForFilePath(path)
  headers["Content-Disposition"] = "inline; filename=\"" & sceneImageFilename(sceneId) & "\""
  (Http200, headers, readFile(path))

proc renderStatusScreenPng(): string =
  ## The status screen as it would render right now, on this frame's panel
  ## size — the same builder and painter the runner uses for `system/index`.
  let frameConfig = globalFrameConfig
  let logger = if globalFrameOS != nil: globalFrameOS.logger else: nil
  let scene = indexScene.init(SceneId(StatusScreenSceneId), frameConfig, logger, %*{})
  let image = case frameConfig.rotate:
    of 90, 270: newImage(frameConfig.height, frameConfig.width)
    else: newImage(frameConfig.width, frameConfig.height)
  drawStatusScreen(image, indexScene.Scene(scene).buildStatusScreen())
  image.encodeImage(PngFormat)

proc statusScreenImagePayload(thumb: bool): tuple[status: HttpCode, headers: mummy.HttpHeaders, body: string] =
  ## The status screen's snapshot: the runner's own when it is fresh, else a
  ## redraw saved in its place so the next request (and the runner's stale
  ## check) find it. An actual picture of the screen, never a placeholder.
  let assetsPath = configuredAssetsPath()
  let age = storedFileAgeSeconds(sceneImagePath(assetsPath, StatusScreenSceneId))
  if age < 0 or age >= StatusScreenSnapshotMaxAgeSeconds:
    discard saveSceneImagePng(assetsPath, StatusScreenSceneId, renderStatusScreenPng())
  storedSceneImagePayload(StatusScreenSceneId, thumb)

proc saveStoredSceneImagePayload(sceneId: string, body: string): JsonNode =
  let savedImage = saveSceneImagePng(configuredAssetsPath(), sceneId, body)
  %*{
    "scene_id": savedImage.sceneId,
    "path": sceneImageRelativePath(configuredAssetsPath(), savedImage.path),
    "size": savedImage.size,
  }

proc sceneCoverPngFromBytes(content: string): string =
  ## Any image the decoder knows (PNG, JPEG, GIF, BMP, QOI, SVG) becomes the
  ## PNG the snapshot store serves, decoded at no more than the panel's size:
  ## a store cover is a picture of the scene, and a scene is the panel.
  let frameConfig = globalFrameConfig
  let image = decodeImageBounded(content, max(1, frameConfig.width), max(1, frameConfig.height))
  image.encodeImage(PngFormat)

proc sceneCoverFromUrl(url: string): tuple[ok: bool, status: HttpCode, detail: string, png: string] =
  ## The bytes behind a cover URL the picker rendered: a repository cover on
  ## the provider's origin (absolute http(s)), or one of the embedded system
  ## templates' covers by its same-origin path. Nothing else is fetched — the
  ## browser cannot pull those bytes itself (the store serves covers without
  ## CORS headers), which is why the copy runs on the frame at all.
  let trimmed = url.strip()
  if trimmed.len == 0:
    return (false, Http400, "Provide source_scene_id, template_id or url", "")
  const systemPrefix = "/api/repositories/system/"
  if trimmed.startsWith(systemPrefix):
    let parts = trimmed[systemPrefix.len .. ^1].split('/')
    if parts.len != 4 or parts[1] != "templates" or parts[3] != "image":
      return (false, Http400, "Unsupported repository image path", "")
    let imagePath = systemTemplateImagePath(decodePathSegment(parts[0]), decodePathSegment(parts[2]))
    if imagePath.len == 0:
      return (false, Http404, "Template image not found", "")
    return (true, Http201, "", sceneCoverPngFromBytes(getRepoSceneAsset(imagePath)))
  if not (trimmed.startsWith("http://") or trimmed.startsWith("https://")):
    return (false, Http400, "Only http(s) image URLs can be copied", "")
  let content =
    try:
      boundedGetContent(trimmed, timeoutMs = SceneImageCopyTimeoutMs, maxBytes = SceneImageCopyMaxBytes)
    except CatchableError as e:
      return (false, Http502, "Could not fetch the image: " & e.msg, "")
  if content.len == 0:
    return (false, Http502, "The image URL answered with an empty body", "")
  try:
    (true, Http201, "", sceneCoverPngFromBytes(content))
  except CatchableError as e:
    (false, Http400, "Not an image the frame can decode: " & e.msg, "")

proc copySceneImagePayload(sceneId: string, body: JsonNode): tuple[status: HttpCode, payload: JsonNode] =
  ## `POST /api/frames/1/scene_images/{id}/copy` — the same request the
  ## backend answers for a freshly installed scene (backend
  ## app/api/scene_images.py). Until the device answered it too, every
  ## store install from the on-device panel toasted "failed to copy the
  ## cover" and the tile stayed blank until the first render.
  if body == nil or body.kind != JObject:
    return (Http400, %*{"detail": "Provide source_scene_id, template_id or url"})
  let assetsPath = configuredAssetsPath()
  let sourceSceneId = body{"source_scene_id"}.getStr("")
  if sourceSceneId.len > 0:
    let sourcePath = sceneImagePath(assetsPath, sourceSceneId)
    if not fileExists(sourcePath):
      return (Http404, %*{"detail": "Source scene has no image"})
    return (Http201, saveStoredSceneImagePayload(sceneId, readFile(sourcePath)))
  if body{"template_id"}.getStr("").len > 0:
    # Saved templates live in the backend's database; the frame keeps none.
    return (Http404, %*{"detail": "Template image not found"})
  let fetched = sceneCoverFromUrl(body{"url"}.getStr(""))
  if not fetched.ok:
    return (fetched.status, %*{"detail": fetched.detail})
  (Http201, saveStoredSceneImagePayload(sceneId, fetched.png))

proc queueRuntimeControl(request: Request, action: string, eventName: string) {.gcsafe.} =
  try:
    {.gcsafe.}:
      discard loadConfig()
    sendEvent(eventName, %*{})
    jsonResponse(request, Http200, %*{"status": "ok", "action": action})
  except CatchableError as e:
    log(%*{"event": action & ":error", "error": e.msg})
    jsonResponse(request, Http500, %*{"status": "error", "error": "Failed to queue " & action})

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

  router.head("/api/frames/@id/image", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let (status, headers, body) = buildFrameImageHeadResponse(request)
        request.respond(status, headers, body)
  )

  # Before the `@sceneId` route: that one matches a single path segment, and
  # the status screen's id has a slash in it.
  router.get("/api/frames/@id/scene_images/system/index", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      try:
        let (status, headers, body) = statusScreenImagePayload(request.queryParams.getOrDefault("thumb", "") == "1")
        request.respond(status, headers, body)
      except CatchableError as e:
        respondInternalError(request, "scene_images:status_screen:error", e, "Failed to render the status screen")
  )

  router.get("/api/frames/@id/scene_images/@sceneId", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let thumb = request.queryParams.getOrDefault("thumb", "") == "1"
        let (status, headers, body) = storedSceneImagePayload(request.pathParams["sceneId"], thumb)
        request.respond(status, headers, body)
  )

  router.post("/api/frames/@id/scene_images/@sceneId/copy", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      let body =
        try:
          parseJson(if request.body.strip().len == 0: "{}" else: request.body)
        except JsonParsingError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return
      try:
        let (status, payload) = copySceneImagePayload(request.pathParams["sceneId"], body)
        jsonResponse(request, status, payload)
      except CatchableError as e:
        respondInternalError(request, "scene_images:copy:error", e, "Failed to copy the scene image")
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
        # A save applies, it does not just write frame.json: the sockets are
        # rebound first (and a port or certificate the frame cannot serve on
        # refuses the whole save), then the file is written, then the
        # runtime reloads — or restarts, for values a driver only reads at
        # init — and the system steps `frameos setup` would run (time zone,
        # Samba mounts, driver setup) are queued on their own thread. The
        # response says what happened under `apply`, which is how the admin
        # page knows to follow the frame to a new port or scheme.
        let preview = previewFrameApiUpdate(payload)
        var listenerResult = ListenerApplyResult(ok: true, listeners: activeListenerSpecs())
        if preview.change.listeners:
          listenerResult = applyListenerPlan(parseFrameConfig($preview.next))
          if not listenerResult.ok:
            log(%*{"event": "frame:update:listeners:error", "error": listenerResult.error})
            jsonResponse(request, Http409, %*{"detail": listenerResult.error,
              "apply": {"listeners": listenerSpecsJson(listenerResult.listeners)}})
            return
        # A save that re-points the frame at another backend (a second
        # backend adopting it) tells the one being left what happened, while
        # this runtime still holds that server's address and key.
        let serverNotice = backendChangeNotice(preview.existing, preview.next)
        if serverNotice != nil:
          log(serverNotice)
          discard notifyPreviousBackend(preview.existing, serverNotice)
        persistFrameApiUpdate(payload)
        let skipRuntimeReload = payload{"skip_runtime_reload"}.getBool(false)
        let jobs = settingsJobsFor(preview.change, preview.next{"mode"}.getStr(""))
        var runtimeAction = "none"
        if payload.hasKey("scenes") or preview.change.any:
          if preview.change.restart:
            runtimeAction = "restart"
          elif not skipRuntimeReload:
            runtimeAction = "reload"
        if runtimeAction == "restart":
          # Driver setup restarts the runtime itself once it is done (it may
          # even reboot); a restart queued here would race it.
          if sjDriverSetup notin jobs:
            sendEvent("restart", %*{})
        elif runtimeAction == "reload":
          sendEvent("reload", %*{})
        queueSettingsJobs(jobs, $preview.next)
        let nextAction = payload{"next_action"}.getStr("")
        if nextAction == "render" and runtimeAction != "restart":
          sendEvent("render", %*{})
        let framePayload = frameApiPayload(connectionsState, exposeSecrets = canAccessFrameSecrets(request))
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = "application/json"
        if adminPanelEnabled():
          headers["Set-Cookie"] = adminSessionCookieHeader(request, createAdminSession())
        request.respond(Http200, headers, $(%*{
          "message": "Frame updated successfully",
          "frame": framePayload,
          "apply": {
            "runtime": runtimeAction,
            "listeners": listenerSpecsJson(listenerResult.listeners),
            "listeners_changed": listenerResult.changed,
            "system": settingsJobNames(jobs),
          },
        }))
      except CatchableError as e:
        respondInternalError(request, "frame:update:error", e, "Failed to update the frame")
  )

  router.post("/api/frames/@id/reload", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
        return
      touchFrameSyncRevision()
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
