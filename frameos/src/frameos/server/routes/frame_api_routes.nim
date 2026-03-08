import json
import mummy
import mummy/routers
import httpcore
import frameos/types
import ../state
import ../auth
import ../api
import ./common

proc ensureFrameApiReadAccess(request: Request): bool =
  if not hasAuthenticatedAdminSession(request):
    request.respond(Http401, body = "Unauthorized")
    return false
  if not hasAccess(request, Read):
    request.respond(Http401, body = "Unauthorized")
    return false
  true

proc addFrameApiRoutes*(router: var Router, connectionsState: ConnectionsState) =
  router.get("/api/apps", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      request.respond(Http200, headers, appsPayload())
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

  router.get("/api/frames/@id/image_token", proc(request: Request) {.gcsafe.} =
    if not ensureFrameApiReadAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let token =
          if canAccessFrameSecrets(request) and globalFrameConfig.frameAccessKey.len > 0:
            globalFrameConfig.frameAccessKey
          else:
            "frame"
        jsonResponse(request, Http200, %*{"token": token, "expires_in": 3600})
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
        let (status, headers, body) = buildFrameImageResponse(request)
        request.respond(status, headers, body)
  )
