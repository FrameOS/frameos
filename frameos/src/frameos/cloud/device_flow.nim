## The device-flow ("link code") half of this frame's direct link to FrameOS
## Cloud (docs/cloud-link.md, docs/cloud-frames.md "B. Link code on the
## device").
##
## Three callers share it:
## - the local admin routes (`POST /api/cloud/connect` / `/poll`) — the
##   browser-driven flow the shared settings page uses;
## - the hub thread's idle pass (`deviceFlowTick`) — a background poller, so a
##   flow started from the admin page keeps advancing after the tab is closed,
##   and a flow queued by the setup portal ("show a link code on the display")
##   starts by itself once the network is up and restarts when it expires;
## - the runner (`activeLinkCode`) — while a flow is pending the user code and
##   a QR of `verification_uri_complete` are drawn over whatever the frame is
##   showing, the same way `local_access.nim` puts the presence code on the
##   panel. Someone who can see the panel can claim the frame; that is the
##   ownership proof the consent screen then records.
##
## Concurrency: link state read-modify-writes hold `cloudLinkLock` and never
## span a network call (link_state.nim). The background tick's own timers live
## in module-level vars touched only by the hub thread.

import json
from frameos/cloud/enrollment import frameDisplayName
import locks
import os
import strutils
import std/httpclient
import times

import frameos/channels
import frameos/types
import frameos/upgrade
import frameos/utils/http_client
import frameos/cloud/enrollment
import frameos/cloud/link_state

const
  CLOUD_REQUEST_TIMEOUT_MS = 15000
  CLOUD_REQUEST_MAX_SECONDS = 20.0
  CLOUD_REQUEST_MAX_REDIRECTS = 1
  CLOUD_LINK_CODE_PENDING_PATH = "./state/cloud_link_code_pending.json"
  # Scopes a panel-initiated link asks for: the managed profile plus cloud
  # login, i.e. what the portal's "cloud" control mode means.
  LINK_CODE_DEFAULT_SCOPES* = @["frame:link", "frame:managed", "auth:login"]
  # A queued link code restarts when its 10-minute window lapses unclaimed;
  # after this many starts the frame stops asking (each start is a provider
  # row) and waits for a reboot or the admin page.
  LINK_CODE_MAX_STARTS* = 12
  LINK_CODE_START_BACKOFF_MIN_SECONDS = 10.0
  LINK_CODE_START_BACKOFF_MAX_SECONDS = 300.0

proc jsonOrNull*(node: JsonNode): JsonNode =
  ## `state{...}` yields nil for missing keys, and a nil embedded in `%*`
  ## segfaults std/json's serializer.
  if node == nil: newJNull() else: node

proc cloudRequest*(providerUrl, path: string, httpMethod = HttpPost,
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
    maxSeconds = CLOUD_REQUEST_MAX_SECONDS,
    # A provider's API answers directly; every extra hop is another connect
    # (and another resolution) charged to a worker thread, so allow one for a
    # host or scheme move and no more.
    maxRedirects = CLOUD_REQUEST_MAX_REDIRECTS,
  )
  var payload: JsonNode = nil
  try:
    payload = parseJson(response.body)
  except CatchableError:
    discard
  if payload == nil or payload.kind != JObject:
    payload = %*{}
  (response.code, payload)

proc fetchConnectSync*(providerUrl, accessToken: string): JsonNode =
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

proc requestRender() {.gcsafe.} =
  ## A sleeping scene renders on its own schedule; every state change that
  ## puts a code on the panel or takes one off asks for a frame right away.
  {.gcsafe.}:
    sendEvent("render", %*{})

# ---------------------------------------------------------------------------
# Start

type DeviceFlowStart* = object
  ok*: bool
  status*: int          # HTTP status from the provider (0 = unreachable)
  error*: string        # human-readable, for the admin route's 502 detail
  networkError*: bool   # retry later rather than give up

proc startDeviceFlow*(providerUrl, displayName, localOrigin: string,
                      scopes: seq[string]): DeviceFlowStart {.gcsafe.} =
  ## Asks the provider for a device code and puts the link into `connecting`.
  ## Replaces any pending flow. Callers check for `connected` first (the admin
  ## route answers 409; the background tick never starts over a live link).
  {.gcsafe.}:
    var scopesJson = newJArray()
    for scope in scopes:
      scopesJson.add(%scope)
    var startResponse: JsonNode
    var startCode = 0
    try:
      (startCode, startResponse) = cloudRequest(providerUrl, "/api/device/start", body = %*{
        "public_display_name": displayName,
        "local_origin": localOrigin,
        "reported_frameos_version": installedFrameOSVersion(),
        "capabilities": {"localFallback": true, "frame": true},
        "client_kind": "frame",
        "scopes": scopesJson,
      })
    except CatchableError as error:
      return DeviceFlowStart(ok: false, status: 0, networkError: true,
        error: "Could not reach " & providerUrl & ": " & error.msg)
    if startCode != 200 or startResponse{"device_code"}.getStr("") == "":
      let detail = startResponse{"error"}.getStr("unexpected status " & $startCode)
      return DeviceFlowStart(ok: false, status: startCode,
        networkError: startCode == 429 or startCode >= 500,
        error: "FrameOS Cloud rejected the request: " & detail)

    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      resetLinkState(state)
      state["provider_url"] = %providerUrl
      state["status"] = %"connecting"
      # The provider only accepts login-handoff redirects on this origin.
      state["local_origin"] = %localOrigin
      state["device_code"] = jsonOrNull(startResponse{"device_code"})
      state["user_code"] = jsonOrNull(startResponse{"user_code"})
      state["verification_uri"] = jsonOrNull(startResponse{"verification_uri"})
      state["verification_uri_complete"] = jsonOrNull(startResponse{"verification_uri_complete"})
      state["interval_seconds"] = %startResponse{"interval"}.getInt(5)
      state["scope"] = %scopes.join(" ")
      # Remember what THIS device asked for. The poll response reports what
      # the provider says it granted, and managed mode — the one scope that
      # hands a provider remote control of the frame — is only entered when
      # both agree (managedEnrollmentRequested).
      state["requested_scope"] = %scopes.join(" ")
      let expiresIn = startResponse{"expires_in"}.getInt(0)
      if expiresIn > 0:
        state["expires_epoch"] = %int(epochTime() + float(expiresIn))
      saveCloudLinkState(state)
    requestRender()
    DeviceFlowStart(ok: true, status: startCode)

# ---------------------------------------------------------------------------
# Poll

type DeviceFlowPoll* = object
  polled*: bool     # a request went to the provider
  changed*: bool    # the link left `connecting` (connected, denied, expired)
  startHub*: bool   # managed enrollment succeeded: the caller starts the hub

proc clearPendingLinkCode*() {.gcsafe.}

proc pollDeviceFlow*(frameConfig: FrameConfig): DeviceFlowPoll {.gcsafe.} =
  ## One poll of a pending device flow. No-op unless the link is `connecting`.
  ## On approval: stores the token, syncs inventory/grants, and — when
  ## frame:managed was both requested and granted — registers the device key
  ## with the provider (flow B) so the hub thread can take over.
  {.gcsafe.}:
    var providerUrl = ""
    var deviceCode = ""
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      if expireIfNeeded(state):
        saveCloudLinkState(state)
        requestRender()
        return DeviceFlowPoll(changed: true)
      if state{"status"}.getStr("") != "connecting" or state{"device_code"}.getStr("") == "":
        return DeviceFlowPoll()
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
    result.polled = true

    var syncAccessToken = ""
    var grantedManagedScope = false
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      if state{"status"}.getStr("") != "connecting" or state{"device_code"}.getStr("") != deviceCode:
        return
      if networkError:
        state["poll_error"] = %"network_error"
        saveCloudLinkState(state)
        return
      let error = pollResponse{"error"}.getStr("")
      if error == "authorization_pending":
        if state.hasKey("poll_error"):
          state.delete("poll_error")
          saveCloudLinkState(state)
        return
      if pollCode == 200 and pollResponse{"access_token"}.getStr("") != "":
        let accessToken = pollResponse{"access_token"}.getStr("")
        state["status"] = %"connected"
        state["access_token"] = %accessToken
        state["token_reference"] = jsonOrNull(pollResponse{"token_reference"})
        state["linked_client_id"] = jsonOrNull(pollResponse{"linked_client_id"})
        if pollResponse{"scope"}.getStr("") != "":
          state["scope"] = pollResponse{"scope"}
        for key in ["device_code", "user_code", "verification_uri",
                    "verification_uri_complete", "expires_epoch", "poll_error"]:
          if state.hasKey(key):
            state.delete(key)
        state["connected_at"] = %isoTimestamp(int64(epochTime()))
        saveCloudLinkState(state)
        # The inventory/grants sync is two more cloud round trips; do it
        # after releasing the lock so a slow or unreachable provider cannot
        # hold cloudLinkLock — and with it every cloud route — for minutes.
        syncAccessToken = accessToken
        # Granted AND locally requested: a provider cannot upgrade a
        # backups-only link into cloud-managed mode by claiming the scope.
        grantedManagedScope = managedEnrollmentRequested(state)
        if linkHasScope(state, "frame:managed") and not grantedManagedScope:
          log(%*{"event": "cloud:enroll:refused", "reason": "scope_not_requested",
                 "message": "The provider granted frame:managed but this frame " &
                            "never asked for it; not entering managed mode."})
      else:
        resetLinkState(state, pollError = (if error.len > 0: error else: "unexpected status " & $pollCode))
        saveCloudLinkState(state)
        result.changed = true
        requestRender()
        return
    result.changed = true
    # The code is off the panel from here on, whatever the sync below does.
    requestRender()

    let synced = fetchConnectSync(providerUrl, syncAccessToken)

    # Flow B (docs/cloud-frames.md): a device-flow link granted the
    # frame:managed scope registers the device keypair with the provider and
    # becomes cloud-managed. Runs without cloudLinkLock — it is another
    # provider round trip — and persists mode/frame_id/ws_path itself.
    if grantedManagedScope:
      if otherControlPlaneActive(frameConfig):
        log(%*{"event": "cloud:enroll:refused", "reason": "backend_managed",
               "message": "This frame is managed by a self-hosted backend; " &
                          "remove serverHost from frame.json before enrolling with a cloud provider"})
      else:
        let outcome = enrollManagedFrame(providerUrl, "", syncAccessToken, "", frameConfig)
        if outcome.ok:
          result.startHub = true
          # The queued panel code is spent. This thread becomes the hub
          # session from here, so no later tick would retire the marker —
          # and a marker left behind restarts the code on a managed frame
          # the next time its socket is down (2026-09-04, uus2w).
          clearPendingLinkCode()
        else:
          log(%*{"event": "cloud:enroll:error", "flow": "device_flow",
                 "status": outcome.status, "error": outcome.error})
          withLock cloudLinkLock:
            let state = loadCloudLinkState()
            state["managed_enroll_error"] = %outcome.error
            saveCloudLinkState(state)

    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      for key, value in synced:
        state[key] = value
      if synced.len > 0:
        saveCloudLinkState(state)

# ---------------------------------------------------------------------------
# A link code queued for the display (setup portal "cloud" mode without a
# claim token). The marker survives reboots; the hub thread starts the flow
# once the provider is reachable and restarts it when a window lapses.

proc pendingLinkCodePath*(): string =
  let override = getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH")
  if override.len > 0: override else: CLOUD_LINK_CODE_PENDING_PATH

proc loadPendingLinkCode*(): JsonNode {.gcsafe.} =
  ## nil when no link code is queued.
  {.gcsafe.}:
    let path = pendingLinkCodePath()
    if not fileExists(path):
      return nil
    try:
      let parsed = parseJson(readFile(path))
      if parsed.kind == JObject:
        return parsed
    except CatchableError:
      discard
    # Unreadable marker: drop it so the thread never loops on junk.
    try:
      removeFile(path)
    except CatchableError:
      discard
    nil

proc savePendingLinkCode(pending: JsonNode) {.gcsafe.} =
  {.gcsafe.}:
    let path = pendingLinkCodePath()
    createDir(parentDir(path))
    let tmp = path & ".tmp"
    writeFile(tmp, $pending & "\n")
    moveFile(tmp, path)

proc writePendingLinkCode*(providerUrl: string): bool {.gcsafe.} =
  ## Queues a panel-displayed link: the next hub pass starts the device flow
  ## and the runner draws the code. Entry point for the setup portal.
  {.gcsafe.}:
    var url = normalizeProviderUrl(providerUrl)
    if url.len == 0:
      url = DEFAULT_CLOUD_PROVIDER_URL
    try:
      savePendingLinkCode(%*{"provider_url": url, "starts": 0})
      true
    except CatchableError:
      false

proc clearPendingLinkCode*() {.gcsafe.} =
  {.gcsafe.}:
    try:
      removeFile(pendingLinkCodePath())
    except CatchableError:
      discard

proc pendingLinkCodeQueued*(): bool {.gcsafe.} =
  {.gcsafe.}:
    fileExists(pendingLinkCodePath())

# ---------------------------------------------------------------------------
# Background tick (hub thread, idle pass every ~2 s)

var
  nextDeviceFlowPollAt = 0.0
  nextLinkCodeStartAt = 0.0
  linkCodeStartBackoff = LINK_CODE_START_BACKOFF_MIN_SECONDS

proc headlessLocalOrigin*(frameConfig: FrameConfig): string =
  ## The origin the provider may redirect cloud-login handoffs to when no
  ## browser request started the flow: the frame's own admin page.
  let host = if frameConfig != nil and frameConfig.frameHost.len > 0: frameConfig.frameHost
             else: "localhost"
  let port = if frameConfig != nil and frameConfig.framePort > 0: frameConfig.framePort
             else: 8787
  "http://" & host & ":" & $port

proc deviceFlowTick*(frameConfig: FrameConfig): bool {.gcsafe.} =
  ## Advances a pending device flow without a browser: polls while
  ## `connecting`, starts (and restarts) a queued panel link while
  ## `disconnected`. Returns true when managed enrollment just succeeded and
  ## the caller should make sure the hub session starts.
  {.gcsafe.}:
    var status = ""
    var mode = ""
    var intervalSeconds = 5
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      if expireIfNeeded(state):
        saveCloudLinkState(state)
        requestRender()
      status = state{"status"}.getStr("disconnected")
      mode = state{"mode"}.getStr("")
      intervalSeconds = max(1, state{"interval_seconds"}.getInt(5))
    let now = epochTime()
    case status
    of "connecting":
      if now >= nextDeviceFlowPollAt:
        nextDeviceFlowPollAt = now + float(intervalSeconds)
        let poll = pollDeviceFlow(frameConfig)
        if poll.changed:
          nextDeviceFlowPollAt = 0.0
        return poll.startHub
    of "connected":
      if pendingLinkCodeQueued():
        clearPendingLinkCode()
    else:
      nextDeviceFlowPollAt = 0.0
      if mode == "managed":
        # Already enrolled, socket merely down: a link code here would offer
        # the frame to whoever reads the panel. Retire any stale marker.
        if pendingLinkCodeQueued():
          clearPendingLinkCode()
        return false
      if now < nextLinkCodeStartAt:
        return false
      let pending = loadPendingLinkCode()
      if pending == nil:
        return false
      let starts = pending{"starts"}.getInt(0)
      if starts >= LINK_CODE_MAX_STARTS:
        log(%*{"event": "cloud:linkCode:gaveUp", "starts": starts,
               "message": "No one claimed the link code shown on the display; " &
                          "restart the link from the admin page or reboot to show it again."})
        clearPendingLinkCode()
        return false
      var displayName = "FrameOS frame"
      let ownName = frameDisplayName(frameConfig)
      if ownName.len > 0:
        displayName = "FrameOS frame (" & ownName & ")"
      let outcome = startDeviceFlow(
        pending{"provider_url"}.getStr(DEFAULT_CLOUD_PROVIDER_URL),
        displayName, headlessLocalOrigin(frameConfig), LINK_CODE_DEFAULT_SCOPES)
      if outcome.ok:
        pending["starts"] = %(starts + 1)
        try:
          savePendingLinkCode(pending)
        except CatchableError:
          discard
        linkCodeStartBackoff = LINK_CODE_START_BACKOFF_MIN_SECONDS
        nextLinkCodeStartAt = 0.0
        log(%*{"event": "cloud:linkCode:shown", "start": starts + 1})
      elif outcome.networkError:
        # Wi-Fi not up yet, or the provider is away: try again, more slowly.
        nextLinkCodeStartAt = now + linkCodeStartBackoff
        linkCodeStartBackoff = min(linkCodeStartBackoff * 2, LINK_CODE_START_BACKOFF_MAX_SECONDS)
      else:
        log(%*{"event": "cloud:linkCode:refused", "status": outcome.status, "error": outcome.error})
        clearPendingLinkCode()
    false

# ---------------------------------------------------------------------------
# What the panel should be showing

type LinkCodeView* = object
  active*: bool
  userCode*: string
  verificationUri*: string
  verificationUriComplete*: string
  secondsLeft*: int

var
  linkCodeCache: LinkCodeView
  linkCodeCacheGeneration = -1
  linkCodeCacheLock: Lock
initLock(linkCodeCacheLock)

proc activeLinkCode*(): LinkCodeView {.gcsafe.} =
  ## The pending link code, or `active = false`. Re-read only when the link
  ## state changed (generation counter), so the render loop pays one atomic
  ## load per frame, not a file parse.
  {.gcsafe.}:
    let generation = currentCloudLinkGeneration()
    withLock linkCodeCacheLock:
      if generation != linkCodeCacheGeneration:
        var view = LinkCodeView()
        withLock cloudLinkLock:
          let state = loadCloudLinkState()
          if state{"status"}.getStr("") == "connecting" and
              state{"user_code"}.getStr("").len > 0:
            view.active = true
            view.userCode = state{"user_code"}.getStr("")
            view.verificationUri = state{"verification_uri"}.getStr("")
            view.verificationUriComplete = state{"verification_uri_complete"}.getStr("")
            view.secondsLeft = state{"expires_epoch"}.getInt(0)
        linkCodeCache = view
        linkCodeCacheGeneration = generation
      result = linkCodeCache
    if result.active:
      # secondsLeft caches the deadline; turn it into a countdown here, and
      # take the code down the moment the window lapses even if nothing has
      # rewritten the state file yet.
      let left = result.secondsLeft - int(epochTime())
      if result.secondsLeft > 0 and left <= 0:
        return LinkCodeView()
      result.secondsLeft = max(0, left)
