## Linking this frame directly to FrameOS Cloud (no backend in between).
##
## Mirrors the backend's /api/cloud/* endpoints (backend/app/api/cloud.py) so
## the shared React settings section works against either server. Protocol
## documented in docs/cloud-link.md: OAuth 2.0 Device Authorization Grant,
## outbound-only, scoped tokens. Link state lives in ./state/cloud_link.json
## (helpers shared with the managed-mode modules in frameos/cloud/).
##
## Cloud-managed frames (docs/cloud-frames.md) add POST /api/cloud/enroll
## (claim-token flow A) here, and the device-flow poll below upgrades a link
## whose granted scopes include frame:managed (flow B).

import algorithm
import json
import locks
import strutils
import times
import mummy
import mummy/routers
import httpcore
import std/httpclient
import frameos/channels
import frameos/cloud/link_state
import frameos/cloud/device_flow
import frameos/cloud/enrollment
import frameos/cloud/hub_client
import ../api
import ../auth
import ../rate_limit
import ../state

proc cloudStatusPayload(state: JsonNode): JsonNode =
  let status = state{"status"}.getStr("disconnected")
  # Lets the admin UI know whether asking for frame:managed can succeed: a
  # frame owned by a self-hosted backend refuses managed enrollment.
  var backendManaged = false
  {.gcsafe.}:
    backendManaged = otherControlPlaneActive(globalFrameConfig)
  result = %*{
    "enabled": true,
    "provider_url": providerUrlFromState(state),
    "default_provider_url": DEFAULT_CLOUD_PROVIDER_URL,
    "status": status,
    "can_edit_provider": status == "disconnected",
    "poll_error": jsonOrNull(state{"poll_error"}),
    "connection": newJNull(),
    "link": newJNull(),
    "backend_managed": backendManaged,
    # Effective, not stored: see localAdminLoginEnabled. The panel should show
    # what actually happens at the login screen.
    "local_fallback_enabled": localAdminLoginEnabled(state),
  }
  if status == "connecting":
    result["connection"] = %*{
      "user_code": jsonOrNull(state{"user_code"}),
      "verification_uri": jsonOrNull(state{"verification_uri"}),
      "verification_uri_complete": jsonOrNull(state{"verification_uri_complete"}),
      "expires_at": (
        if state{"expires_epoch"}.getInt(0) > 0:
          %isoTimestamp(int64(state{"expires_epoch"}.getInt(0)))
        else:
          newJNull()
      ),
      "interval_seconds": state{"interval_seconds"}.getInt(5),
    }
  if status == "connected":
    var scopes = newJArray()
    for scope in state{"scope"}.getStr("").splitWhitespace():
      scopes.add(%scope)
    result["link"] = %*{
      "linked_client_id": jsonOrNull(state{"linked_client_id"}),
      "scopes": scopes,
      "account_id": jsonOrNull(state{"account_id"}),
      "account_email": jsonOrNull(state{"account_email"}),
      "connected_at": jsonOrNull(state{"connected_at"}),
      "last_inventory_sync_at": jsonOrNull(state{"last_inventory_sync_at"}),
    }
    if state{"mode"}.getStr("") == "managed":
      result["mode"] = %"managed"
      result["link"]["frame_id"] = jsonOrNull(state{"frame_id"})

proc requestedScopes(payload: JsonNode): seq[string] =
  if payload{"scopes"} != nil and payload{"scopes"}.kind == JArray:
    for scope in payload{"scopes"}:
      if scope.kind == JString and scope.getStr() in KNOWN_FRAME_SCOPES:
        result.add(scope.getStr())
  if result.len == 0:
    result = DEFAULT_FRAME_SCOPES

proc requestHeader(request: Request, name: string): string =
  for (headerName, value) in request.headers:
    if cmpIgnoreCase(headerName, name) == 0:
      return value
  ""

proc localOrigin*(request: Request): string =
  let forwardedProto = requestHeader(request, "x-forwarded-proto")
    .split(",", 1)[0].strip().toLowerAscii()
  let scheme = if forwardedProto == "https": "https" else: "http"
  var host = requestHeader(request, "host")
  if host.len == 0:
    host = "localhost"
  scheme & "://" & host

const CLOUD_LOGIN_STATE_TTL_SECONDS = 600
const MAX_LOGIN_STATES = 16

# The login routes below are open by necessity, and /login/start turns one
# anonymous request into an authenticated call to the provider. Budgets are
# per client address, sized for a person signing in (a handful of attempts)
# rather than for a script.
const
  LOGIN_START_LIMIT = 10
  LOGIN_START_WINDOW = 300.0
  LOGIN_CALLBACK_LIMIT = 30
  LOGIN_CALLBACK_WINDOW = 300.0
  LOGIN_OPTIONS_LIMIT = 60
  LOGIN_OPTIONS_WINDOW = 60.0

proc rateLimitedResponse(request: Request, bucket: string): bool {.gcsafe.} =
  ## Answers 429 and reports whether the caller should stop.
  var headers: mummy.HttpHeaders
  headers["Retry-After"] = $retryAfterSeconds(request, bucket)
  headers["Content-Type"] = "application/json"
  request.respond(429, headers, $(%*{"detail": "Too many requests"}))
  true

proc pruneLoginStates(state: JsonNode): bool {.discardable.} =
  ## Drop expired pending login-handoff states (stored under login_states), then
  ## enforce MAX_LOGIN_STATES by evicting the oldest. /api/cloud/login/start is
  ## open (the user is not logged in yet), so without the cap anyone on the LAN
  ## could grow this file unboundedly and make every later cloud request pay for
  ## parsing and rewriting it while holding cloudLinkLock.
  ## Returns true when something was removed, so callers can skip a needless
  ## rewrite of the state file.
  result = false
  if state{"login_states"} == nil or state{"login_states"}.kind != JObject:
    return
  var expired: seq[string]
  for key, value in state{"login_states"}:
    if int64(value{"expires_epoch"}.getInt(0)) <= int64(epochTime()):
      expired.add(key)
  for key in expired:
    state["login_states"].delete(key)
    result = true

  if state["login_states"].len <= MAX_LOGIN_STATES:
    return
  # Oldest first, by the expiry we stamped at creation.
  var byAge: seq[(int64, string)]
  for key, value in state{"login_states"}:
    byAge.add((int64(value{"expires_epoch"}.getInt(0)), key))
  byAge.sort(proc(a, b: (int64, string)): int = cmp(a[0], b[0]))
  for i in 0 ..< (byAge.len - MAX_LOGIN_STATES):
    state["login_states"].delete(byAge[i][1])
    result = true

proc redirectResponse(request: Request, location: string) =
  var headers: mummy.HttpHeaders
  headers["Location"] = location
  request.respond(303, headers, "")

const CLOUD_LOGIN_STATE_COOKIE = "frameos_cloud_login_state"

proc loginStateCookieHeader(request: Request, value: string): string =
  CLOUD_LOGIN_STATE_COOKIE & "=" & value &
    "; Path=/api/cloud/login; HttpOnly; SameSite=Lax; Max-Age=" &
    $CLOUD_LOGIN_STATE_TTL_SECONDS &
    (if shouldUseSecureCookie(request): "; Secure" else: "")

  # Not cleared on success: mummy sends one Set-Cookie per response and the
  # session cookie takes that slot. Harmless — the cookie is path-scoped to
  # /api/cloud/login, expires in CLOUD_LOGIN_STATE_TTL_SECONDS, is overwritten
  # by the next /start, and its server-side state entry is single-use.

proc addCloudApiRoutes*(router: var Router) =
  router.get("/api/cloud/status", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        if expireIfNeeded(state):
          saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )

  router.post("/api/cloud/provider", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      let payload = try:
          parseJson(if request.body.strip().len == 0: "{}" else: request.body)
        except JsonParsingError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return
      let providerUrl = normalizeProviderUrl(payload{"provider_url"}.getStr(""))
      if providerUrl.len == 0:
        jsonResponse(request, Http400, %*{"detail": "The FrameOS Cloud server must be an http(s) URL"})
        return
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        discard expireIfNeeded(state)
        if state{"status"}.getStr("disconnected") != "disconnected":
          jsonResponse(request, Http409,
            %*{"detail": "Disconnect from FrameOS Cloud before changing the server URL"})
          return
        state["provider_url"] = %providerUrl
        if state.hasKey("poll_error"):
          state.delete("poll_error")
        saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )

  router.post("/api/cloud/connect", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      let payload = try:
          parseJson(if request.body.strip().len == 0: "{}" else: request.body)
        except JsonParsingError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return

      var providerUrl = ""
      var displayName = "FrameOS frame"
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        discard expireIfNeeded(state)
        if state{"status"}.getStr("") == "connected":
          jsonResponse(request, Http409, %*{"detail": "Already connected to FrameOS Cloud"})
          return
        let fromBody = normalizeProviderUrl(payload{"provider_url"}.getStr(""))
        providerUrl = if fromBody.len > 0: fromBody else: providerUrlFromState(state)
      let ownName = frameDisplayName(globalFrameConfig)
      if ownName.len > 0:
        displayName = "FrameOS frame (" & ownName & ")"

      # The shared start (cloud/device_flow.nim) also puts the code on the
      # panel and lets the hub thread poll, so closing this browser tab no
      # longer strands the flow.
      let outcome = startDeviceFlow(providerUrl, displayName, localOrigin(request),
        requestedScopes(payload))
      if not outcome.ok:
        jsonResponse(request, Http502, %*{"detail": outcome.error})
        return
      withLock cloudLinkLock:
        jsonResponse(request, Http200, cloudStatusPayload(loadCloudLinkState()))
  )

  router.post("/api/cloud/poll", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      # Shared with the hub thread's background tick; both sides are safe to
      # run concurrently (the poll is a no-op unless the link is connecting,
      # and the provider treats a duplicate poll as authorization_pending).
      let poll = pollDeviceFlow(globalFrameConfig)
      if poll.startHub:
        startCloudHubClient(globalFrameConfig)
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )

  router.post("/api/cloud/enroll", proc(request: Request) {.gcsafe.} =
    ## Flow A (docs/cloud-frames.md): enroll this frame as cloud-managed with
    ## a claim token pasted into the local admin page or setup portal. Local
    ## admin session required — enrollment is a local ceremony, never a
    ## provider verb.
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      let payload = try:
          parseJson(if request.body.strip().len == 0: "{}" else: request.body)
        except JsonParsingError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return
      let claimToken = payload{"claim_token"}.getStr("").strip()
      if claimToken.len == 0:
        jsonResponse(request, Http400, %*{"detail": "Missing claim_token"})
        return
      # One control plane at a time: refuse while a self-hosted backend is
      # configured, and while already enrolled with a provider.
      if otherControlPlaneActive(globalFrameConfig):
        jsonResponse(request, Http409,
          %*{"detail": "This frame is managed by a self-hosted backend. " &
                       "Remove serverHost from frame.json before enrolling with FrameOS Cloud."})
        return
      var providerUrl = ""
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        discard expireIfNeeded(state)
        if state{"status"}.getStr("") == "connected":
          jsonResponse(request, Http409,
            %*{"detail": "Already connected to FrameOS Cloud; disconnect first"})
          return
        let fromBody = normalizeProviderUrl(payload{"provider_url"}.getStr(""))
        providerUrl = if fromBody.len > 0: fromBody else: providerUrlFromState(state)

      let outcome = enrollManagedFrame(
        providerUrl, claimToken, "", payload{"name"}.getStr(""), globalFrameConfig)
      if not outcome.ok:
        let status =
          if outcome.status == 400: Http400
          elif outcome.status == 409: Http409
          elif outcome.status == 429: Http429
          elif outcome.status == 0: Http502
          else: Http502
        jsonResponse(request, status, %*{
          "detail": "Enrollment failed: " & outcome.error,
          "error": outcome.error,
        })
        return
      startCloudHubClient(globalFrameConfig)
      # Managed mode activates the private-network HTTP deny immediately.
      refreshLocalNetworkPolicy(globalFrameConfig)
      withLock cloudLinkLock:
        jsonResponse(request, Http200, cloudStatusPayload(loadCloudLinkState()))
  )

  # ---- cloud login for the on-device admin -----------------------------------
  # Open endpoints: the user is not logged in yet. The provider only mints a
  # login code for the cloud account that owns this frame's link, so a
  # completed handoff is proof of ownership.

  router.get("/api/cloud/login/options", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      # Open, and it takes the global cloud lock plus a state-file read on every
      # hit, so it is worth capping before any of that work happens.
      if rateLimitExceeded(request, "cloud:login:options", LOGIN_OPTIONS_LIMIT,
                           LOGIN_OPTIONS_WINDOW):
        discard rateLimitedResponse(request, "cloud:login:options")
        return
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        let available = cloudLoginPossible(state) and adminAuthEnabled()
        # Anonymous callers learn only whether the cloud button should render.
        # The provider URL follows only when it should, since that is the one
        # case where the browser has to be sent there anyway.
        jsonResponse(request, Http200, %*{
          "available": available,
          "provider_url": (if available: %providerUrlFromState(state) else: newJNull()),
          # The same answer /api/admin/login enforces, so the screen never
          # offers a password field that the frame will refuse.
          "local_login_enabled": localAdminLoginEnabled(state) or not adminAuthEnabled(),
          "setup_mode": false,
        })
  )

  router.post("/api/cloud/login/start", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      # One call here costs an authenticated round trip to the provider; without
      # a cap any LAN client can amplify against the cloud indefinitely.
      if rateLimitExceeded(request, "cloud:login:start", LOGIN_START_LIMIT,
                           LOGIN_START_WINDOW):
        discard rateLimitedResponse(request, "cloud:login:start")
        return
      if not adminAuthEnabled():
        jsonResponse(request, Http409, %*{"detail": "The admin panel is disabled on this frame"})
        return
      var providerUrl = ""
      var accessToken = ""
      var origin = ""
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        if state{"status"}.getStr("") != "connected" or state{"access_token"}.getStr("") == "":
          jsonResponse(request, Http409, %*{"detail": "This frame is not linked to FrameOS Cloud"})
          return
        if not linkHasScope(state, "auth:login"):
          jsonResponse(request, Http403,
            %*{"detail": "The cloud link is missing the auth:login permission; reconnect with it enabled"})
          return
        providerUrl = providerUrlFromState(state)
        accessToken = state{"access_token"}.getStr("")
        origin = state{"local_origin"}.getStr("")
      if origin.len == 0:
        origin = localOrigin(request)

      let loginState = secureRandomToken(32)
      var startCode = 0
      var startResponse: JsonNode = %*{}
      try:
        (startCode, startResponse) = cloudRequest(providerUrl, "/api/frameos/login/start",
          accessToken = accessToken, body = %*{
            "redirect_uri": origin & "/api/cloud/login/callback",
            "state": loginState,
            "intent": "login",
          })
      except CatchableError as error:
        jsonResponse(request, Http502, %*{"detail": "Could not reach " & providerUrl & ": " & error.msg})
        return
      if startCode != 200 or startResponse{"authorization_url"}.getStr("") == "":
        let detail = startResponse{"error"}.getStr("unexpected status " & $startCode)
        jsonResponse(request, Http502, %*{"detail": "FrameOS Cloud rejected the login request: " & detail})
        return

      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        if state{"login_states"} == nil or state{"login_states"}.kind != JObject:
          state["login_states"] = %*{}
        pruneLoginStates(state)
        state["login_states"][loginState] = %*{
          "expires_epoch": int(epochTime() + float(CLOUD_LOGIN_STATE_TTL_SECONDS)),
        }
        saveCloudLinkState(state)
      # Bind the handoff to THIS browser. Without it, knowing a live state plus
      # a code is enough for anyone to complete the login: an attacker could
      # start a handoff for their own cloud account and feed the resulting
      # callback URL to the owner's browser (logging them into the attacker's
      # account), or replay a leaked code from their own browser to take over
      # the owner's session.
      var headers: mummy.HttpHeaders
      headers["Set-Cookie"] = loginStateCookieHeader(request, loginState)
      headers["Content-Type"] = "application/json"
      request.respond(200, headers, $(%*{
        "authorization_url": startResponse{"authorization_url"}.getStr(""),
      }))
  )

  router.get("/api/cloud/login/callback", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      if rateLimitExceeded(request, "cloud:login:callback", LOGIN_CALLBACK_LIMIT,
                           LOGIN_CALLBACK_WINDOW):
        discard rateLimitedResponse(request, "cloud:login:callback")
        return
      let stateParam = request.queryParams.getOrDefault("state", "")
      let code = request.queryParams.getOrDefault("code", "")
      let errorParam = request.queryParams.getOrDefault("error", "")

      # The state must match the cookie we set on /api/cloud/login/start, so
      # only the browser that began the handoff can finish it. Checked before
      # any state-file work, which also keeps forged callbacks off the lock.
      let stateCookie = getCookieValue(request, CLOUD_LOGIN_STATE_COOKIE)
      if stateParam.len == 0 or stateCookie.len == 0 or stateCookie != stateParam:
        redirectResponse(request, "/login?cloudError=invalid_state")
        return

      var providerUrl = ""
      var accessToken = ""
      var ownerAccountId = ""
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        let pruned = pruneLoginStates(state)
        if stateParam.len == 0 or state{"login_states"} == nil or
            state{"login_states"}{stateParam} == nil:
          # This endpoint is open, so an unknown state is the common case for
          # junk traffic: only rewrite the state file when pruning actually
          # changed it, otherwise every bogus request costs an SD-card write
          # while holding cloudLinkLock.
          if pruned:
            saveCloudLinkState(state)
          redirectResponse(request, "/login?cloudError=invalid_state")
          return
        state["login_states"].delete(stateParam)
        saveCloudLinkState(state)
        if state{"status"}.getStr("") != "connected" or state{"access_token"}.getStr("") == "":
          redirectResponse(request, "/login?cloudError=not_connected")
          return
        providerUrl = providerUrlFromState(state)
        accessToken = state{"access_token"}.getStr("")
        ownerAccountId = state{"account_id"}.getStr("")

      if errorParam.len > 0:
        redirectResponse(request, "/login?cloudError=" & errorParam)
        return
      if code.len == 0 or not adminAuthEnabled():
        redirectResponse(request, "/login?cloudError=exchange_failed")
        return

      var tokenCode = 0
      var tokenResponse: JsonNode = %*{}
      try:
        (tokenCode, tokenResponse) = cloudRequest(providerUrl, "/api/frameos/login/token",
          accessToken = accessToken, body = %*{"code": code})
      except CatchableError:
        redirectResponse(request, "/login?cloudError=network_error")
        return
      let claims = tokenResponse{"claims"}
      if tokenCode != 200 or claims == nil or claims.kind != JObject:
        redirectResponse(request, "/login?cloudError=exchange_failed")
        return
      # The provider only completes a handoff for the account that owns this
      # link, but verify it ourselves rather than trusting the response. We
      # learn the owner from /api/backends/grants during connect; if that call
      # failed we have nothing to compare against, and minting an admin session
      # on the provider's word alone would let a network hiccup during linking
      # silently weaken this check — so refuse and re-sync instead.
      let claimedAccountId = claims{"account_id"}.getStr("")
      if ownerAccountId.len == 0 or claimedAccountId.len == 0 or claimedAccountId != ownerAccountId:
        if ownerAccountId.len == 0:
          # Fill in the owner we never got, so the next attempt can verify.
          let synced = fetchConnectSync(providerUrl, accessToken)
          if synced.len > 0:
            withLock cloudLinkLock:
              let state = loadCloudLinkState()
              for key, value in synced:
                state[key] = value
              saveCloudLinkState(state)
        redirectResponse(request, "/login?cloudError=linked_client_required")
        return

      let sessionToken = createAdminSession()
      var headers: mummy.HttpHeaders
      headers["Set-Cookie"] = adminSessionCookieHeader(request, sessionToken)
      headers["Location"] = "/admin"
      request.respond(303, headers, "")
  )

  router.post("/api/cloud/local-fallback", proc(request: Request) {.gcsafe.} =
    ## Turn the admin password off (or back on) for this frame, mirroring the
    ## self-hosted backend's `/api/cloud/local-fallback`. Turning it off is the
    ## direction that needs care, so it is the direction with all the checks;
    ## turning it back on is always allowed, from any admin session.
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      let payload = try:
          parseJson(if request.body == "": "{}" else: request.body)
        except CatchableError:
          jsonResponse(request, Http400, %*{"detail": "Invalid JSON"})
          return
      if payload{"enabled"} == nil or payload{"enabled"}.kind != JBool:
        jsonResponse(request, Http400, %*{"detail": "Send {\"enabled\": true|false}"})
        return
      let enabled = payload{"enabled"}.getBool()

      if enabled:
        withLock cloudLinkLock:
          let state = loadCloudLinkState()
          state["local_fallback_enabled"] = %true
          saveCloudLinkState(state)
          jsonResponse(request, Http200, cloudStatusPayload(state))
        return

      if not adminAuthEnabled():
        jsonResponse(request, Http409, %*{"detail": "The admin panel is disabled on this frame"})
        return
      var providerUrl = ""
      var accessToken = ""
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        if not cloudLoginPossible(state):
          jsonResponse(request, Http409,
            %*{"detail": "Connect this frame to FrameOS Cloud with the auth:login permission first"})
          return
        providerUrl = providerUrlFromState(state)
        accessToken = state{"access_token"}.getStr("")
      if accessToken.len == 0:
        jsonResponse(request, Http409, %*{"detail": "This frame is not linked to FrameOS Cloud"})
        return

      # A link that says "connected" in a state file is not a link that works.
      # Ask the provider now, without the lock: disabling the password on the
      # strength of a stale token is how a frame ends up with no way in.
      var grantsCode = 0
      try:
        (grantsCode, _) = cloudRequest(providerUrl, "/api/backends/grants",
          httpMethod = HttpGet, accessToken = accessToken)
      except CatchableError as error:
        jsonResponse(request, Http502,
          %*{"detail": "Could not reach " & providerUrl & ": " & error.msg})
        return
      if grantsCode != 200:
        jsonResponse(request, Http502,
          %*{"detail": "The cloud link did not verify; local login stays enabled"})
        return

      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        # Re-read under the lock: the link can have gone away during the round
        # trip above, and localAdminLoginEnabled would then ignore the flag.
        if not cloudLoginPossible(state):
          jsonResponse(request, Http409,
            %*{"detail": "The cloud link changed while checking; local login stays enabled"})
          return
        state["local_fallback_enabled"] = %false
        saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )

  router.post("/api/cloud/disconnect", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      var providerUrl = ""
      var accessToken = ""
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        providerUrl = providerUrlFromState(state)
        if state{"status"}.getStr("") == "connected":
          accessToken = state{"access_token"}.getStr("")
      if accessToken.len > 0:
        try:
          discard cloudRequest(providerUrl, "/api/backends/unlink", accessToken = accessToken, body = %*{})
        except CatchableError:
          # Local disconnect must work while the cloud is down.
          discard
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        # resetLinkState also clears the managed-mode fields (mode, frame_id,
        # ws_path, scenes_checksum); the hub client thread notices the state
        # generation change and closes its management socket. The last pushed
        # scenes keep rendering.
        resetLinkState(state)
        saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
      # Cancelling a pending panel link must also stop the background tick
      # from starting a fresh one, and take the code off the display.
      clearPendingLinkCode()
      sendEvent("render", %*{})
      # Leaving managed mode lifts the private-network HTTP deny immediately.
      refreshLocalNetworkPolicy(globalFrameConfig)
  )
