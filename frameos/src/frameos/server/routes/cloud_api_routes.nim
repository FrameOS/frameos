## Linking this frame directly to FrameOS Cloud (no backend in between).
##
## Mirrors the backend's /api/cloud/* endpoints (backend/app/api/cloud.py) so
## the shared React settings section works against either server. Protocol
## documented in docs/cloud-link.md: OAuth 2.0 Device Authorization Grant,
## outbound-only, scoped tokens. Link state lives in ./state/cloud_link.json.

import algorithm
import json
import locks
import os
import strutils
import times
import mummy
import mummy/routers
import httpcore
import std/httpclient
import frameos/upgrade
import frameos/utils/http_client
import ../api
import ../auth
import ../state

const
  CLOUD_LINK_STATE_PATH = "./state/cloud_link.json"
  DEFAULT_CLOUD_PROVIDER_URL = "https://cloud.frameos.net"
  CLOUD_REQUEST_TIMEOUT_MS = 15000

# Scopes a frame link may request; must stay in sync with docs/cloud-link.md.
const KNOWN_FRAME_SCOPES = [
  "frame:link",
  "auth:login",
  "backup:assets",
  "remote:access",
  "telemetry:logs",
  "telemetry:metrics",
]
const DEFAULT_FRAME_SCOPES = @["frame:link"]

var cloudLinkLock: Lock
initLock(cloudLinkLock)

proc isoTimestamp(epoch: int64): string =
  format(fromUnix(epoch), "yyyy-MM-dd'T'HH:mm:ss'Z'", utc())

proc loadCloudLinkState(): JsonNode =
  if fileExists(CLOUD_LINK_STATE_PATH):
    try:
      let parsed = parseJson(readFile(CLOUD_LINK_STATE_PATH))
      if parsed.kind == JObject:
        return parsed
    except CatchableError:
      discard
  %*{"status": "disconnected"}

proc saveCloudLinkState(state: JsonNode) =
  let dir = splitFile(CLOUD_LINK_STATE_PATH).dir
  if dir.len > 0 and not dirExists(dir):
    createDir(dir)
  let tempPath = CLOUD_LINK_STATE_PATH & ".tmp"
  writeFile(tempPath, pretty(state, indent = 2) & "\n")
  setFilePermissions(tempPath, {fpUserRead, fpUserWrite})
  if fileExists(CLOUD_LINK_STATE_PATH):
    removeFile(CLOUD_LINK_STATE_PATH)
  moveFile(tempPath, CLOUD_LINK_STATE_PATH)

proc normalizeProviderUrl(value: string): string =
  ## Empty string means "invalid"; callers fall back or reject.
  var url = value.strip()
  if url.len == 0:
    return ""
  if not (url.startsWith("http://") or url.startsWith("https://")):
    return ""
  while url.endsWith("/"):
    url = url[0 ..< url.len - 1]
  url

proc providerUrlFromState(state: JsonNode): string =
  let stored = normalizeProviderUrl(state{"provider_url"}.getStr(""))
  if stored.len > 0: stored else: DEFAULT_CLOUD_PROVIDER_URL

proc resetLinkState(state: JsonNode, pollError: string = "") =
  let providerUrl = providerUrlFromState(state)
  for key in ["device_code", "user_code", "verification_uri", "verification_uri_complete",
              "expires_epoch", "access_token", "token_reference", "linked_client_id",
              "account_id", "account_email", "scope", "poll_error", "local_origin",
              "connected_at", "last_inventory_sync_at", "login_states"]:
    if state.hasKey(key):
      state.delete(key)
  state["provider_url"] = %providerUrl
  state["status"] = %"disconnected"
  if pollError.len > 0:
    state["poll_error"] = %pollError

proc expireIfNeeded(state: JsonNode): bool =
  if state{"status"}.getStr("") == "connecting" and
      state{"expires_epoch"}.getInt(0) > 0 and
      int64(state{"expires_epoch"}.getInt(0)) <= int64(epochTime()):
    resetLinkState(state, pollError = "expired")
    return true
  false

proc cloudStatusPayload(state: JsonNode): JsonNode =
  let status = state{"status"}.getStr("disconnected")
  result = %*{
    "enabled": true,
    "provider_url": providerUrlFromState(state),
    "default_provider_url": DEFAULT_CLOUD_PROVIDER_URL,
    "status": status,
    "can_edit_provider": status == "disconnected",
    "poll_error": state{"poll_error"},
    "connection": newJNull(),
    "link": newJNull(),
  }
  if status == "connecting":
    result["connection"] = %*{
      "user_code": state{"user_code"},
      "verification_uri": state{"verification_uri"},
      "verification_uri_complete": state{"verification_uri_complete"},
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
      "linked_client_id": state{"linked_client_id"},
      "scopes": scopes,
      "account_id": state{"account_id"},
      "account_email": state{"account_email"},
      "connected_at": state{"connected_at"},
      "last_inventory_sync_at": state{"last_inventory_sync_at"},
    }

proc cloudRequest(providerUrl, path: string, httpMethod = HttpPost,
                  accessToken = "", body: JsonNode = nil): (int, JsonNode) =
  var headers = newHttpHeaders({"Accept": "application/json"})
  if body != nil:
    headers["Content-Type"] = "application/json"
  if accessToken.len > 0:
    headers["Authorization"] = "Bearer " & accessToken
  let url = providerUrl & "/" & path.strip(leading = true, chars = {'/'})
  let response = boundedRequest(
    url,
    httpMethod = httpMethod,
    body = (if body != nil: $body else: ""),
    headers = headers,
    timeoutMs = CLOUD_REQUEST_TIMEOUT_MS,
  )
  var payload: JsonNode = nil
  try:
    payload = parseJson(response.body)
  except CatchableError:
    discard
  if payload == nil or payload.kind != JObject:
    payload = %*{}
  (response.code, payload)

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

proc linkHasScope(state: JsonNode, scope: string): bool =
  scope in state{"scope"}.getStr("").splitWhitespace()

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

proc fetchConnectSync(providerUrl, accessToken: string): JsonNode =
  ## Best effort: report inventory and learn which account owns us. Returns the
  ## fields to merge into the link state rather than mutating it: both requests
  ## below can take tens of seconds, so callers MUST run this WITHOUT holding
  ## cloudLinkLock and merge the result afterwards.
  var state = newJObject()
  try:
    let (inventoryCode, _) = cloudRequest(providerUrl, "/api/backends/inventory",
      accessToken = accessToken, body = %*{
        "reported_frameos_version": installedFrameOSVersion(),
        "capabilities": {"localFallback": true, "frame": true},
        "health": {"status": "ok"},
      })
    if inventoryCode == 200:
      state["last_inventory_sync_at"] = %isoTimestamp(int64(epochTime()))
  except CatchableError:
    discard
  try:
    let (grantsCode, grants) = cloudRequest(providerUrl, "/api/backends/grants",
      httpMethod = HttpGet, accessToken = accessToken)
    if grantsCode == 200 and grants{"grants"} != nil and grants{"grants"}.kind == JArray:
      for grant in grants{"grants"}:
        if grant.kind == JObject and grant{"role"}.getStr("") == "owner":
          state["account_id"] = grant{"account_id"}
          state["account_email"] = grant{"account_email"}
          break
  except CatchableError:
    discard
  return state

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
      if globalFrameConfig != nil and globalFrameConfig.name.len > 0:
        displayName = "FrameOS frame (" & globalFrameConfig.name & ")"

      let scopes = requestedScopes(payload)
      var scopesJson = newJArray()
      for scope in scopes:
        scopesJson.add(%scope)
      var startResponse: JsonNode
      var startCode = 0
      let origin = localOrigin(request)
      try:
        (startCode, startResponse) = cloudRequest(providerUrl, "/api/device/start", body = %*{
          "public_display_name": displayName,
          "local_origin": origin,
          "reported_frameos_version": installedFrameOSVersion(),
          "capabilities": {"localFallback": true, "frame": true},
          "client_kind": "frame",
          "scopes": scopesJson,
        })
      except CatchableError as error:
        jsonResponse(request, Http502, %*{"detail": "Could not reach " & providerUrl & ": " & error.msg})
        return
      if startCode != 200 or startResponse{"device_code"}.getStr("") == "":
        let detail = startResponse{"error"}.getStr("unexpected status " & $startCode)
        jsonResponse(request, Http502, %*{"detail": "FrameOS Cloud rejected the request: " & detail})
        return

      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        resetLinkState(state)
        state["provider_url"] = %providerUrl
        state["status"] = %"connecting"
        # The provider only accepts login-handoff redirects on this origin.
        state["local_origin"] = %origin
        state["device_code"] = startResponse{"device_code"}
        state["user_code"] = startResponse{"user_code"}
        state["verification_uri"] = startResponse{"verification_uri"}
        state["verification_uri_complete"] = startResponse{"verification_uri_complete"}
        state["interval_seconds"] = %startResponse{"interval"}.getInt(5)
        state["scope"] = %scopes.join(" ")
        let expiresIn = startResponse{"expires_in"}.getInt(0)
        if expiresIn > 0:
          state["expires_epoch"] = %int(epochTime() + float(expiresIn))
        saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )

  router.post("/api/cloud/poll", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request):
      jsonResponse(request, Http401, %*{"detail": "Unauthorized"})
      return
    {.gcsafe.}:
      var providerUrl = ""
      var deviceCode = ""
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        if expireIfNeeded(state):
          saveCloudLinkState(state)
        if state{"status"}.getStr("") != "connecting" or state{"device_code"}.getStr("") == "":
          jsonResponse(request, Http200, cloudStatusPayload(state))
          return
        providerUrl = providerUrlFromState(state)
        deviceCode = state{"device_code"}.getStr("")

      var pollCode = 0
      var pollResponse: JsonNode = %*{}
      var networkError = false
      try:
        (pollCode, pollResponse) = cloudRequest(providerUrl, "/api/device/poll",
          body = %*{"device_code": deviceCode})
      except CatchableError:
        networkError = true

      var syncAccessToken = ""
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        if state{"status"}.getStr("") != "connecting" or state{"device_code"}.getStr("") != deviceCode:
          jsonResponse(request, Http200, cloudStatusPayload(state))
          return
        if networkError:
          state["poll_error"] = %"network_error"
          saveCloudLinkState(state)
          jsonResponse(request, Http200, cloudStatusPayload(state))
          return
        let error = pollResponse{"error"}.getStr("")
        if error == "authorization_pending":
          if state.hasKey("poll_error"):
            state.delete("poll_error")
          saveCloudLinkState(state)
          jsonResponse(request, Http200, cloudStatusPayload(state))
          return
        if pollCode == 200 and pollResponse{"access_token"}.getStr("") != "":
          let accessToken = pollResponse{"access_token"}.getStr("")
          state["status"] = %"connected"
          state["access_token"] = %accessToken
          state["token_reference"] = pollResponse{"token_reference"}
          state["linked_client_id"] = pollResponse{"linked_client_id"}
          if pollResponse{"scope"}.getStr("") != "":
            state["scope"] = pollResponse{"scope"}
          for key in ["device_code", "user_code", "verification_uri",
                      "verification_uri_complete", "expires_epoch", "poll_error"]:
            if state.hasKey(key):
              state.delete(key)
          state["connected_at"] = %isoTimestamp(int64(epochTime()))
          saveCloudLinkState(state)
          # The inventory/grants sync is two more cloud round trips; do it
          # after releasing the lock (below) so a slow or unreachable provider
          # cannot hold cloudLinkLock — and with it every cloud route — for
          # minutes.
          syncAccessToken = accessToken
        else:
          resetLinkState(state, pollError = (if error.len > 0: error else: "unexpected status " & $pollCode))
          saveCloudLinkState(state)
          jsonResponse(request, Http200, cloudStatusPayload(state))
          return

      let synced = fetchConnectSync(providerUrl, syncAccessToken)
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        for key, value in synced:
          state[key] = value
        if synced.len > 0:
          saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )

  # ---- cloud login for the on-device admin -----------------------------------
  # Open endpoints: the user is not logged in yet. The provider only mints a
  # login code for the cloud account that owns this frame's link, so a
  # completed handoff is proof of ownership.

  router.get("/api/cloud/login/options", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        let available = state{"status"}.getStr("") == "connected" and
          linkHasScope(state, "auth:login") and adminAuthEnabled()
        jsonResponse(request, Http200, %*{
          "available": available,
          "provider_url": providerUrlFromState(state),
          "local_login_enabled": true,
          "setup_mode": false,
        })
  )

  router.post("/api/cloud/login/start", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
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
        resetLinkState(state)
        saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )
