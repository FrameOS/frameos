## Linking this frame directly to FrameOS Cloud (no backend in between).
##
## Mirrors the backend's /api/cloud/* endpoints (backend/app/api/cloud.py) so
## the shared React settings section works against either server. Protocol
## documented in docs/cloud-link.md: OAuth 2.0 Device Authorization Grant,
## outbound-only, scoped tokens. Link state lives in ./state/cloud_link.json.

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
              "account_id", "account_email", "scope", "poll_error"]:
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

proc localOrigin(request: Request): string =
  var host = ""
  if request.headers.contains("Host"):
    host = request.headers["Host"]
  if host.len == 0:
    host = "localhost"
  "http://" & host

proc syncAfterConnect(state: JsonNode, providerUrl, accessToken: string) =
  ## Best effort: report inventory and learn which account owns us.
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
      try:
        (startCode, startResponse) = cloudRequest(providerUrl, "/api/device/start", body = %*{
          "public_display_name": displayName,
          "local_origin": localOrigin(request),
          "reported_frameos_version": installedFrameOSVersion(),
          "capabilities": {"localFallback": true, "frame": true},
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
          syncAfterConnect(state, providerUrl, accessToken)
          saveCloudLinkState(state)
          jsonResponse(request, Http200, cloudStatusPayload(state))
          return
        resetLinkState(state, pollError = (if error.len > 0: error else: "unexpected status " & $pollCode))
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
        resetLinkState(state)
        saveCloudLinkState(state)
        jsonResponse(request, Http200, cloudStatusPayload(state))
  )
