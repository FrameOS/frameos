import json
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/config
import ../auth
import ../api
import ../state
import ./admin_api_assets_routes
import ./common

proc addAdminApiRoutes*(router: var Router) =
  router.get("/api/admin/session", proc(request: Request) {.gcsafe.} =
    let authenticated = hasAuthenticatedAdminSession(request)
    jsonResponse(request, Http200, %*{"authenticated": authenticated})
  )

  router.post("/api/admin/login", proc(request: Request) {.gcsafe.} =
    if not adminAuthEnabled():
      jsonResponse(request, Http401, %*{"detail": "Admin auth disabled"})
      return
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    let username = payload{"username"}.getStr("")
    let password = payload{"password"}.getStr("")
    if validateAdminCredentials(username, password):
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=" & adminSessionCookieValue() &
        "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" & $ADMIN_SESSION_TTL_SECONDS
      request.respond(Http200, headers, $(%*{"status": "ok"}))
    else:
      jsonResponse(request, Http401, %*{"detail": "Invalid credentials"})
  )

  router.post("/api/admin/logout", proc(request: Request) {.gcsafe.} =
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    request.respond(Http200, headers, $(%*{"status": "ok"}))
  )

  addAdminApiAssetRoutes(router)

  router.post("/api/frames/@id/event/@name", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        log(%*{"event": "http", "post": request.path})
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        sendEvent(request.pathParams["name"], payload)
        jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/api/frames/@id/event", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
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

  router.post("/event/@name", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(request.pathParams["name"], payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/uploadScenes", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent("uploadScenes", payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/reload", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
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
