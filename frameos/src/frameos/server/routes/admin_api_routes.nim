import json
import strutils
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/upgrade
import ../auth
import ../api
import ../rate_limit
import ./admin_api_assets_routes
import ./common

const
  ADMIN_LOGIN_LIMIT = 10
  ADMIN_LOGIN_WINDOW = 300.0

proc addAdminApiRoutes*(router: var Router) =
  router.get("/api/admin/session", proc(request: Request) {.gcsafe.} =
    let authenticated = hasAuthenticatedAdminSession(request)
    jsonResponse(request, Http200, %*{"authenticated": authenticated})
  )

  router.post("/api/admin/login", proc(request: Request) {.gcsafe.} =
    if not adminAuthEnabled():
      jsonResponse(request, Http401, %*{"detail": "Admin auth disabled"})
      return
    # The admin password is the only thing between the LAN and this frame, and
    # sessions are stateless, so an unthrottled login is an offline-speed guess
    # loop over the network.
    if rateLimitExceeded(request, "admin:login", ADMIN_LOGIN_LIMIT, ADMIN_LOGIN_WINDOW):
      var limited: mummy.HttpHeaders
      limited["Retry-After"] = $retryAfterSeconds(request, "admin:login")
      limited["Content-Type"] = "application/json"
      request.respond(429, limited, $(%*{"detail": "Too many login attempts"}))
      return
    let payload = try:
        parseJson(if request.body == "": "{}" else: request.body)
      except CatchableError:
        jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
        return
    let username = payload{"username"}.getStr("")
    let password = payload{"password"}.getStr("")
    if validateAdminCredentials(username, password):
      let sessionToken = createAdminSession()
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      headers["Set-Cookie"] = adminSessionCookieHeader(request, sessionToken)
      request.respond(Http200, headers, $(%*{"status": "ok"}))
    else:
      jsonResponse(request, Http401, %*{"detail": "Invalid credentials"})
  )

  router.post("/api/admin/logout", proc(request: Request) {.gcsafe.} =
    invalidateAdminSession(request)
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    headers["Set-Cookie"] = clearAdminSessionCookieHeader(request)
    request.respond(Http200, headers, $(%*{"status": "ok"}))
  )

  router.get("/api/settings", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      jsonResponse(request, Http200, frameAdminEditableSettingsPayload())
  )

  router.post("/api/settings", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      var payload: JsonNode
      try:
        payload = parseJson(if request.body.strip().len == 0: "{}" else: request.body)
      except JsonParsingError:
        jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
        return
      try:
        jsonResponse(request, Http200, persistFrameAdminSettingsUpdate(payload))
      except ValueError as error:
        jsonResponse(request, Http400, %*{"detail": error.msg})
      except CatchableError as error:
        jsonResponse(request, Http500, %*{"detail": error.msg})
  )

  router.get("/api/upgrade/status", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      let checkLatest = request.queryParams.getOrDefault("check", "") in ["1", "true", "yes"]
      jsonResponse(request, Http200, frameOSUpgradeStatusPayload(checkLatest))
  )

  router.post("/api/upgrade", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      var payload: JsonNode
      try:
        payload = parseJson(if request.body.strip().len == 0: "{}" else: request.body)
      except JsonParsingError:
        jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
        return

      try:
        if payload{"dry_run"}.getBool(false):
          jsonResponse(request, Http200, performFrameOSUpgrade(FrameOSUpgradeOptions(dryRun: true)))
        else:
          jsonResponse(request, Http202, scheduleFrameOSUpgrade())
      except ValueError as error:
        jsonResponse(request, Http400, %*{"detail": error.msg})
      except CatchableError as error:
        jsonResponse(request, Http500, %*{"detail": error.msg})
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
