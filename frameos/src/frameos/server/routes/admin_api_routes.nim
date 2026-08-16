import json
import strutils
import mummy
import mummy/routers
import httpcore
import locks
import frameos/channels
import frameos/local_access
import frameos/upgrade
import frameos/cloud/link_state
import ../auth
import ../api
import ../rate_limit
import ./admin_api_assets_routes
import ./common

const
  ADMIN_LOGIN_LIMIT = 10
  ADMIN_LOGIN_WINDOW = 300.0
  # The panel code is six digits and single-use, but the endpoint should not be
  # a place to grind guesses either; the challenge itself only allows five.
  LOCAL_ACCESS_LIMIT = 10
  LOCAL_ACCESS_WINDOW = 300.0

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
    # The owner can switch the password off in favour of cloud login. The flag
    # only bites while cloud login can actually take over (localAdminLoginEnabled),
    # so a frame whose link is gone still opens with a password.
    var localLoginEnabled = true
    {.gcsafe.}:
      withLock cloudLinkLock:
        localLoginEnabled = localAdminLoginEnabled(loadCloudLinkState())
    if not localLoginEnabled:
      jsonResponse(request, Http403, %*{
        "detail": "Local password login is disabled on this frame. Sign in with FrameOS Cloud."})
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

  # ---- private-network elevation (local-presence ceremony) -----------------
  # cloud/docs/cloud-frames.md, "sandbox posture": lifting the LAN deny on a
  # cloud-managed frame takes more than an admin session, which is only a
  # password on a LAN-reachable page. Ask for a challenge, read the six digits
  # off the panel, send them back.

  router.get("/api/network/local-access", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      jsonResponse(request, Http200, localNetworkAccessPayload())
  )

  router.post("/api/network/local-access/challenge", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    if rateLimitExceeded(request, "network:local-access", LOCAL_ACCESS_LIMIT, LOCAL_ACCESS_WINDOW):
      jsonResponse(request, Http429, %*{"detail": "Too many attempts"})
      return
    {.gcsafe.}:
      try:
        let challenge = startLocalAccessChallenge()
        # A sleeping scene renders on its own schedule, and the code is useless
        # until it is actually on the panel, so ask for a frame now.
        sendEvent("render", %*{})
        # No "code" in the response on purpose: a caller who could read it
        # without seeing the panel is precisely who this keeps out.
        jsonResponse(request, Http200, %*{
          "status": "ok",
          "codeLength": challenge.code.len,
          "expiresInSeconds": LocalAccessChallengeTtlSeconds,
        })
      except CatchableError as error:
        jsonResponse(request, Http500, %*{"detail": error.msg})
  )

  router.post("/api/network/local-access", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    if rateLimitExceeded(request, "network:local-access", LOCAL_ACCESS_LIMIT, LOCAL_ACCESS_WINDOW):
      jsonResponse(request, Http429, %*{"detail": "Too many attempts"})
      return
    {.gcsafe.}:
      let payload = try:
          parseJson(if request.body.strip().len == 0: "{}" else: request.body)
        except JsonParsingError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return
      let verdict = consumeLocalAccessCode(payload{"code"}.getStr(""))
      if not verdict.ok:
        # Repaint either way: a spent or failed ceremony must not leave a live
        # code on the panel for the next person walking past.
        sendEvent("render", %*{})
        jsonResponse(request, Http403, %*{"detail": verdict.detail})
        return
      try:
        let updated = setLocalNetworkAccess(payload{"enabled"}.getBool(true))
        sendEvent("render", %*{})
        jsonResponse(request, Http200, updated)
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
