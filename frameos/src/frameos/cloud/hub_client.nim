## Management hub client for cloud-managed frames (docs/cloud-frames.md).
##
## When ./state/cloud_link.json says `"mode": "managed"`, a background thread
## dials `wss://{provider}{ws_path}` with the link Bearer token, proves
## possession of the device Ed25519 key (hello → challenge → auth → ready) and
## then serves the restricted verb set.
##
## The restricted profile is structural: this module implements the complete
## verb list from the wire spec and nothing else. There is no shell verb, no
## arbitrary file read/write verb, no SSH anything, no compiled-scene deploy —
## the code for those capabilities simply does not exist here, so no
## provider-side compromise or configuration flag can reach them. The only
## file access is the asset verb family (`assets_list`/`asset_get` plus the
## write verbs `asset_put`/`asset_put_chunk`/`asset_mkdir`/`asset_delete`/
## `asset_rename`):
## resolved and bounded on-device inside the assets directory
## (admin_api_assets_routes' resolveAssetPath — the same guard the local
## Assets panel uses), with writes additionally refused for dot-directories
## (`.frameos`, `.thumbs` — the device's own plumbing). Anything outside the
## verb table is answered with `unknown_verb` and audit-logged through the
## normal log pipeline (`cloud:audit`).
##
## Service API keys are the one thing this socket never carries. A frame
## holding `settings:services` FETCHES them over its own bounded HTTPS request
## (cloud/service_settings.nim) at every `ready`, on the zero-payload
## `refresh_service_settings` nudge, and on a slow staleness timer; the
## provider's `403 insufficient_scope` on that fetch — not the local scope
## list, which is additive and never forgets — is what a revocation means, and
## it deletes all six cloud-owned settings groups from frame.json.
##
## Frames keep working when the provider is down: this thread only ever pushes
## data out and reacts to messages; rendering, schedules and the local admin
## never wait on it. A demoted or unreachable link leaves the last pushed
## scenes rendering. After `HubAuthFailureLimit` consecutive 401/authentication
## rejections the link is reset to disconnected (the provider revoked us) and
## the device returns to standalone — scenes untouched, loud log line emitted.

import base64
import json
import locks
import options
import os
import strutils
import times
import std/atomics
import std/math
import std/random
import std/asyncdispatch
import std/asyncnet
import std/httpclient
import std/net as std_net
import std/uri
import ws

import frameos/channels
import frameos/device_setup
import frameos/interpreter
import frameos/js_runtime/app_runtime
import frameos/scenes
import frameos/server/api
import frameos/setup as frameSetup
import frameos/server/routes/admin_api_assets_routes
import frameos/server/state
import frameos/types
import frameos/upgrade
import frameos/utils/http_client
import ./device_flow
import ./enrollment
import ./identity
import ./link_state
import ./scene_guard
import ./service_settings
import ./verbs

# The verb layer (CloudVerbContext, handleCloudVerb, the allowlists) lives in
# cloud/verbs.nim so the ESP32 firmware can share it; tests and other
# importers keep reaching it — and CLOUD_REFUSED_APP_KEYWORDS /
# refusedCloudAppKeyword — through this module.
export scene_guard
export verbs

const
  HubBackoffMinSeconds = 3.0
  HubBackoffMaxSeconds = 60.0
  HubHandshakeTimeoutMs = 20_000
  HubRecvTickMs = 500
  HubAuthFailureLimit = 3
  HubLogBatchMaxLines = 100
  HubLogBatchMaxSeconds = 2.0
  HubStateCheckSeconds = 2.0
  HubEnrollBackoffMinSeconds = 30.0
  HubEnrollBackoffMaxSeconds = 600.0
  # The hub pings every 30s and drops sockets that miss a pong
  # (cloud/apps/frame-hub/src/hub.ts). A link that has delivered nothing at all
  # — not even a pong — for three heartbeat windows is dead in a way TCP has
  # not noticed yet (NAT rebind, silent middlebox, sleeping provider), so the
  # device gives up on it and reconnects instead of waiting for the kernel.
  HubIdleTimeoutSeconds = 90.0
  HubPingIntervalSeconds = 30.0
  # Largest inbound message we will assemble. A real `set_scenes` push carries
  # the node graphs of at most a handful of scenes (assets live in the store,
  # not in the payload), so 4 MiB is orders of magnitude more than the wire
  # contract needs while still fitting on the smallest supported device.
  HubMaxInboundBytes = 4 * 1024 * 1024
  # Ed25519 challenge: the hub mints 32 raw random bytes.
  HubMinNonceBytes = 32
  # Hub close codes (cloud/apps/frame-hub/src/hub.ts).
  HubCloseAuthFailed = 4401
  # Service settings (docs/cloud-frames.md): the contract's own triggers are a
  # pull at every `ready` and a pull per `refresh_service_settings` nudge. This
  # slow timer is the "whenever the device decides its copy may be stale" leg —
  # it only matters for a frame that stays connected for days and missed a
  # nudge, and each pull is conditional, so a no-op costs one 304.
  HubServiceSettingsIntervalSeconds = 6 * 60 * 60.0
  # A pull that failed for a reason that says nothing about this device (429,
  # 5xx, DNS/TLS hiccup, a full disk) comes back long before the staleness
  # timer would: the frame is otherwise happily connected and may be rendering
  # with a key the owner already replaced.
  HubServiceSettingsRetrySeconds = 300.0
  # How often the session stats upgrade-status.json. `frameos upgrade` runs
  # detached in its own process (scheduleFrameOSUpgrade), so the only thing it
  # shares with this connection is that file — without watching it, a cloud
  # user who pressed "Upgrade FrameOS" sees the `scheduled` line and then
  # nothing at all, whether the upgrade downloaded 40MB, refused as already
  # current, or died on an unsupported target. A stat every few seconds is
  # cheap; the file is only parsed when its mtime moves.
  HubUpgradeCheckSeconds = 5.0
  # A successful upgrade restarts FrameOS, which takes this connection down
  # with it — so the terminal status is written by a process that is gone by
  # the time anyone could see it. Replay a status file younger than this once
  # per session, so the outcome lands in the log of the session that comes
  # back rather than being lost with the one that triggered it.
  HubUpgradeReplaySeconds = 15 * 60.0
  # An upgrade whose status file stops moving is a dead child: systemd-run
  # refused, the binary is missing, the process was OOM-killed. Say so instead
  # of leaving the last line reading `starting` forever.
  HubUpgradeStallSeconds = 45 * 60.0

type
  CloudHubAuthError* = object of CatchableError

  SessionEndReason = enum
    sessionDisconnected
    sessionAuthRejected
    sessionDemoted
    sessionStopped

  HubLinkSnapshot = object
    managed: bool
    providerUrl: string
    wsPath: string
    accessToken: string
    scopes: seq[string]
    scenesChecksum: string
    frameId: string
    generation: int

# ---------------------------------------------------------------------------
# Link state helpers
# ---------------------------------------------------------------------------

proc frameIdFromState(state: JsonNode): string =
  ## The provider mints the frame id; it is a string on every provider we know,
  ## but a numeric id must not silently become "".
  let node = state{"frame_id"}
  if node == nil or node.kind == JNull:
    ""
  elif node.kind == JString:
    node.getStr("")
  else:
    $node

proc snapshotLink(): HubLinkSnapshot {.gcsafe.} =
  {.gcsafe.}:
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      result = HubLinkSnapshot(
        managed: isManagedLink(state),
        providerUrl: providerUrlFromState(state),
        wsPath: state{"ws_path"}.getStr(DEFAULT_MANAGED_WS_PATH),
        accessToken: state{"access_token"}.getStr(""),
        scopes: linkScopes(state),
        scenesChecksum: state{"scenes_checksum"}.getStr(""),
        frameId: frameIdFromState(state),
        generation: currentCloudLinkGeneration(),
      )

proc persistScenesChecksum(checksum: string) {.gcsafe.} =
  {.gcsafe.}:
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["scenes_checksum"] = %checksum
      saveCloudLinkState(state)

proc persistProviderScopes(scopes: seq[string]): bool {.gcsafe.} =
  ## Union the scopes the provider announced in its `ready` message into the
  ## link state. Additive on purpose (removals arrive as a fresh enroll or a
  ## link reset, never silently): older enroll responses under-reported the
  ## grant as just frame:managed, so this is how an already-enrolled frame
  ## learns it may send telemetry. Returns true when anything changed; the
  ## save bumps the link generation, which the session loop already watches.
  {.gcsafe.}:
    if scopes.len == 0:
      return false
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      let existing = state{"scope"}.getStr("")
      let merged = unionScopeString(existing, scopes.join(" "))
      if merged != existing:
        state["scope"] = %merged
        saveCloudLinkState(state)
        result = true

proc providerExemptHostPort(providerUrl: string): string =
  ## "host:port" for the provider's own API endpoint. The local admin linked
  ## this provider deliberately (possibly a dev provider on the LAN), so its
  ## exact endpoint stays reachable while the private-network deny is active.
  let parsed = parseUri(providerUrl)
  if parsed.hostname.len == 0:
    return ""
  let port =
    if parsed.port.len > 0: parsed.port
    elif parsed.scheme.toLowerAscii() == "https": "443"
    else: "80"
  parsed.hostname.toLowerAscii() & ":" & port

var
  ## Cached link half of the policy. The hub thread calls the proc below every
  ## ~2s and the local admin toggle must apply immediately, but the link state
  ## only ever changes with a generation bump — so re-parse cloud_link.json
  ## then, not on every tick.
  policyCacheLock: Lock
  policyCacheGeneration = -1
  policyCacheManaged = false
  policyCacheExempt: seq[string]

initLock(policyCacheLock)

proc refreshLocalNetworkPolicy*(frameConfig: FrameConfig) {.gcsafe.} =
  ## Recomputes the managed-frame private-network HTTP deny
  ## (utils/http_client.nim): active iff the frame is cloud-managed — or
  ## still running provider-pushed scenes after losing the link — and the
  ## local admin has not set `network.allowLocalNetworkAccess` in frame.json.
  ## Called at startup, whenever the hub thread observes link-state or config
  ## changes, and (via uploadedScenesChangedHook) whenever the uploaded scene
  ## set is replaced; standalone and backend-managed frames always end up
  ## with the policy off.
  ##
  ## The scene-origin term closes the demotion hole: demoteManagedLink keeps
  ## rendering the provider's last-pushed scenes, and before origin was
  ## recorded that meant those scenes kept running with the deny switched
  ## off. Now the deny follows the scenes, not the link — replacing them
  ## locally (or via a backend deploy) is what lifts it.
  {.gcsafe.}:
    # Sampled before the (possibly cached) read so a save that races us always
    # leaves the cache key behind the state file, never ahead of it.
    let generation = currentCloudLinkGeneration()
    var managed = false
    var exempt: seq[string] = @[]
    withLock policyCacheLock:
      if generation != policyCacheGeneration:
        let link = snapshotLink()
        policyCacheManaged = link.managed
        policyCacheExempt = @[]
        if link.managed:
          let hostPort = providerExemptHostPort(link.providerUrl)
          if hostPort.len > 0:
            policyCacheExempt.add(hostPort)
        policyCacheGeneration = generation
      managed = policyCacheManaged
      exempt = policyCacheExempt
    let localOverride = frameConfig != nil and frameConfig.network != nil and
      frameConfig.network.allowLocalNetworkAccess
    # Computed outside the generation cache: the uploaded scene set changes
    # independently of the link state.
    let providerScenes = cloudUploadedScenesResident()
    setLocalNetworkPolicy((managed or providerScenes) and not localOverride, exempt)

proc demoteManagedLink(reason: string) {.gcsafe.} =
  ## Persistent 401: the provider revoked this frame. Return to standalone —
  ## keep rendering the last pushed scenes, never touch them. The LAN deny
  ## deliberately survives this: refreshLocalNetworkPolicy keys on the
  ## persisted scene origin, so provider-pushed scenes keep their network
  ## restrictions until the local admin (or a backend deploy) replaces them.
  {.gcsafe.}:
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      resetLinkState(state, pollError = reason)
      saveCloudLinkState(state)
    log(%*{"event": "cloud:hub:demoted", "reason": reason,
           "message": "Cloud link reset after repeated authentication failures; " &
                      "frame returns to standalone and keeps rendering. " &
                      "Re-enroll from the local admin page to reconnect."})

# ---------------------------------------------------------------------------
# Payload builders
# ---------------------------------------------------------------------------

proc helloStatePayload*(frameConfig: FrameConfig, scenesChecksum: string): JsonNode {.gcsafe.} =
  ## The `hello`-shaped body used by hello, `state` messages and get_state.
  {.gcsafe.}:
    let (sceneId, states) = getAllPublicStates()
    result = %*{
      "frameos_version": installedFrameOSVersion(),
      "hardware": hardwarePayload(frameConfig),
      "states": states,
      "active_scene": sceneId.string,
      "scenes_checksum": scenesChecksum,
    }

proc defaultReboot() {.gcsafe.} =
  {.gcsafe.}:
    rebootSystemDetached()

proc logUpgradeStatus(): string {.gcsafe.} =
  ## Forward the detached upgrade's own status file into the frame log — the
  ## only channel a cloud owner can see. Returns the status it logged so the
  ## caller can stop watching once it is terminal.
  {.gcsafe.}:
    let line = upgradeStatusLogLine(readUpgradeStatus())
    result = line{"status"}.getStr("idle")
    log(line)

proc defaultRequestUpgrade() {.gcsafe.} =
  ## The `notify_update_available` implementation on the full/Pi profile:
  ## run the device's own signed upgrade flow, detached, exactly as the local
  ## admin's POST /api/upgrade does (frameos/upgrade.nim). The provider
  ## supplied no URL and none would be used — scheduleFrameOSUpgrade fetches
  ## the configured release archive and verifies the minisign signature
  ## itself. Delivery is at-least-once, so a repeat while one is in flight is
  ## a logged no-op, and an already-current install resolves to `up_to_date`.
  ##
  ## Everything after "scheduled" happens in another process; the session loop
  ## watches upgrade-status.json and logs what that process reports.
  {.gcsafe.}:
    if frameOSUpgradeInFlight():
      log(%*{"event": "cloud:upgrade", "status": "skipped", "detail": "already_in_flight"})
      return
    try:
      discard scheduleFrameOSUpgrade()
      log(%*{"event": "cloud:upgrade", "status": "scheduled",
             "current_version": installedFrameOSVersion()})
    except CatchableError as error:
      log(%*{"event": "cloud:upgrade", "status": "error", "detail": error.msg})

proc defaultListAssets(): JsonNode {.gcsafe.} =
  ## The `assets_list` payload: the admin panel's listing, with paths made
  ## relative to the assets directory — the provider must never learn (or be
  ## asked to echo back) the device's filesystem layout.
  {.gcsafe.}:
    var entries = newJArray()
    var truncated = false
    for item in frameAssetsPayload():
      let relPath = relativeAssetPath(item{"path"}.getStr(""))
      if relPath.len == 0 or hiddenAssetPath(relPath):
        continue
      if entries.len >= HubMaxAssetListEntries:
        truncated = true
        break
      var entry = copy(item)
      entry["path"] = %relPath
      entries.add(entry)
    result = %*{"assets": entries}
    if truncated:
      result["truncated"] = %true

proc defaultReadAsset(path: string, thumb: bool): AssetReadResult {.gcsafe.} =
  {.gcsafe.}:
    var fullPath: string
    try:
      fullPath = resolveAssetPath(path)
    except CatchableError:
      return AssetReadResult(error: "invalid_path")
    if dirExists(fullPath):
      return AssetReadResult(error: "is_directory")
    if not fileExists(fullPath):
      return AssetReadResult(error: "not_found")
    # Pre-read size gate for originals. Thumbnails are generated small, and
    # getAssetPayload's own 50 MiB ceiling still bounds a pathological one.
    if not thumb and getFileSize(fullPath) > HubMaxAssetFileBytes:
      return AssetReadResult(error: "too_large")
    let (status, _, body) = getAssetPayload(path, thumb)
    if status != Http200:
      # The route answers failures as JSON; keep its wording for the log.
      var detail = $status
      try:
        let parsed = parseJson(body)
        if parsed.kind == JObject:
          detail = parsed{"detail"}.getStr(detail) & (
            if parsed{"error"}.getStr("").len > 0: ": " & parsed{"error"}.getStr() else: "")
      except CatchableError:
        discard
      return AssetReadResult(
        error: if status == Http413: "too_large" else: "read_failed",
        detail: detail)
    if body.len > HubMaxAssetFileBytes:
      return AssetReadResult(error: "too_large")
    AssetReadResult(
      data: body,
      # Thumbnails are always the generated 320x320 preview; originals go by
      # extension (same table getAssetPayload uses for its own header).
      contentType: if thumb: ThumbnailContentType else: contentTypeForFilePath(fullPath),
      mtime: getFileInfo(fullPath).lastWriteTime.toUnix())

proc defaultWriteAsset(path: string, data: string): JsonNode {.gcsafe.} =
  ## Store one uploaded file. resolveAssetUploadPath sanitizes the filename
  ## component exactly like the local admin upload does, so the provider
  ## cannot smuggle path tricks through the name; the returned path is the
  ## relative path actually written.
  {.gcsafe.}:
    let (dir, name, ext) = splitFile(path)
    var payload = saveAssetUploadPayload(dir, name & ext, data)
    payload["path"] = %relativeAssetPath(payload{"path"}.getStr(""))
    payload

proc defaultPutAssetChunk(uploadId: string, offset: BiggestInt, data: string,
                          finalPath: string): JsonNode {.gcsafe.} =
  ## One `asset_put_chunk` write. The part lives outside the assets directory
  ## (the admin upload temp root) until the final chunk moves it into place,
  ## so a half-uploaded file is never listable or renderable.
  {.gcsafe.}:
    let received = writeAssetUploadChunk(uploadId, offset, data)
    if finalPath.len == 0:
      return %*{"received": received}
    var payload = finishAssetUploadChunks(uploadId, finalPath)
    payload["path"] = %relativeAssetPath(payload{"path"}.getStr(""))
    payload

var
  ## Set by the `refresh_service_settings` verb (and cleared by the session
  ## loop once the pull starts). The nudge is advisory, so accepting it is
  ## nothing but this flag — the ack goes out immediately and the HTTPS fetch
  ## happens on the session's own schedule.
  serviceSettingsPullRequested: Atomic[bool]
  ## ETag of the copy currently on disk, remembered for the next
  ## If-None-Match. Hub-thread only. Not persisted: a restart costs one full
  ## response, and a stale ETag would be worse than none.
  serviceSettingsEtag = ""

proc requestServiceSettingsPull*() {.gcsafe.} =
  serviceSettingsPullRequested.store(true, moRelaxed)

proc applySystemTimeZone(timeZone: string) {.gcsafe.} =
  ## frame.json's timeZone drives the scheduler and the Nim apps, but QuickJS
  ## `Date` and anything else on libc localtime() read /etc/localtime — which
  ## only `frameos setup` used to write. Keep the two in step whenever the
  ## zone changes at runtime. Best effort: logged, never fatal.
  {.gcsafe.}:
    try:
      discard frameSetup.setupTimezone(timeZone)
      log(%*{"event": "cloud:timezone:system", "timeZone": timeZone})
    except CatchableError as error:
      log(%*{"event": "cloud:timezone:system:error", "timeZone": timeZone, "error": error.msg})

proc applyEnrollmentPersonalization(personalization: JsonNode) {.gcsafe.} =
  {.gcsafe.}:
    try:
      if frameApiUpdateChangesConfig(personalization):
        persistFrameApiUpdate(personalization)
        log(%*{"event": "cloud:enroll:personalization", "applied": personalization})
        sendEvent("reload", %*{})
      if personalization.hasKey("timezone"):
        applySystemTimeZone(personalization["timezone"].getStr(""))
    except CatchableError as error:
      log(%*{"event": "cloud:enroll:personalization:error", "error": error.msg})

proc defaultCloudVerbContext*(frameConfig: FrameConfig, scopes: seq[string],
                              scenesChecksum: string): CloudVerbContext {.gcsafe.} =
  {.gcsafe.}:
    let config = frameConfig
    CloudVerbContext(
      frameConfig: frameConfig,
      scopes: scopes,
      scenesChecksum: scenesChecksum,
      installedVersion: installedFrameOSVersion(),
      sendEventFn: proc(event: string, payload: JsonNode): bool {.gcsafe.} =
        # Same bounded enqueue as channels.sendEvent, but the caller learns
        # whether the event actually made it: a dropped `uploadScenes` must not
        # be acked as a successful deploy (the provider would never re-push).
        {.gcsafe.}:
          result = eventChannel.trySend((none(SceneId), event, payload))
          if not result:
            atomicInc(eventsDroppedCounter),
      persistSettingsFn: proc(payload: JsonNode) {.gcsafe.} =
        {.gcsafe.}:
          persistFrameApiUpdate(payload),
      settingsChangedFn: proc(payload: JsonNode): bool {.gcsafe.} =
        {.gcsafe.}:
          frameApiUpdateChangesConfig(payload),
      applyTimeZoneFn: proc(timeZone: string) {.gcsafe.} =
        applySystemTimeZone(timeZone),
      persistChecksumFn: proc(checksum: string) {.gcsafe.} =
        persistScenesChecksum(checksum),
      getLogsFn: proc(): JsonNode {.gcsafe.} =
        getUiLogs(),
      getMetricsFn: proc(): JsonNode {.gcsafe.} =
        getUiMetrics(),
      getStateFn: proc(): JsonNode {.gcsafe.} =
        helloStatePayload(config, snapshotLink().scenesChecksum),
      listAssetsFn: proc(): JsonNode {.gcsafe.} =
        {.gcsafe.}:
          defaultListAssets(),
      readAssetFn: proc(path: string, thumb: bool): AssetReadResult {.gcsafe.} =
        {.gcsafe.}:
          defaultReadAsset(path, thumb),
      writeAssetFn: proc(path: string, data: string): JsonNode {.gcsafe.} =
        {.gcsafe.}:
          defaultWriteAsset(path, data),
      putAssetChunkFn: proc(uploadId: string, offset: BiggestInt, data: string,
                            finalPath: string): JsonNode {.gcsafe.} =
        {.gcsafe.}:
          defaultPutAssetChunk(uploadId, offset, data, finalPath),
      mkdirAssetFn: proc(path: string) {.gcsafe.} =
        {.gcsafe.}:
          createAssetDirectory(path),
      deleteAssetFn: proc(path: string) {.gcsafe.} =
        {.gcsafe.}:
          deleteAssetEntry(path),
      renameAssetFn: proc(src: string, dst: string) {.gcsafe.} =
        {.gcsafe.}:
          renameAssetEntry(src, dst),
      getImageFn: proc(): AssetReadResult {.gcsafe.} =
        {.gcsafe.}:
          try:
            AssetReadResult(data: getLastImagePng(), contentType: "image/png",
                            mtime: epochTime().BiggestInt)
          except CatchableError:
            AssetReadResult(error: "no_image"),
      refreshServiceSettingsFn: proc() {.gcsafe.} =
        requestServiceSettingsPull(),
      requestUpgradeFn: proc() {.gcsafe.} =
        defaultRequestUpgrade(),
      rebootFn: proc() {.gcsafe.} =
        defaultReboot(),
      auditFn: proc(payload: JsonNode) {.gcsafe.} =
        log(payload),
    )

# ---------------------------------------------------------------------------
# WebSocket session
# ---------------------------------------------------------------------------

type DialHandle = ref object
  ## Lets the caller close the HTTP client of a dial it gave up on. Without it
  ## a timed-out `withTimeout(dialFut, …)` leaves the abandoned future holding
  ## a connected socket that nothing ever closes — one leaked fd per failed
  ## reconnect, forever.
  client: AsyncHttpClient

proc closeClient(handle: DialHandle) =
  if handle != nil and handle.client != nil:
    try:
      handle.client.close() # idempotent: no-ops once disconnected
    except CatchableError:
      discard

proc dialManagementSocket(providerUrl, wsPath, accessToken: string,
                          handle: DialHandle): Future[WebSocket] {.async.} =
  ## Opens the management socket with an Authorization header. The `ws`
  ## package's client cannot send custom headers, so this performs the same
  ## HTTP upgrade itself (TLS iff the provider URL is https, matching the
  ## cloud-link rules for plain-http development providers) and hands the
  ## upgraded socket to `ws` for framing. Raises CloudHubAuthError on 401.
  let uri = parseUri(providerUrl & wsPath)
  # Only build a TLS context for https providers: getDefaultSSL() is eager in
  # newAsyncHttpClient and newContext() is known to crash against the macOS
  # system LibreSSL, which plain-http dev providers (and tests) never need.
  var client =
    when defined(ssl):
      if uri.scheme == "https":
        newAsyncHttpClient(sslContext = std_net.newContext())
      else:
        newAsyncHttpClient(sslContext = nil)
    else:
      newAsyncHttpClient()
  handle.client = client
  var secStr = newString(16)
  for i in 0 ..< secStr.len:
    secStr[i] = char rand(255)
  client.headers = newHttpHeaders({
    "Connection": "Upgrade",
    "Upgrade": "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": base64.encode(secStr),
    "Authorization": "Bearer " & accessToken,
  })
  let response = await client.get($uri)
  if response.code == Http401 or response.code == Http403:
    client.close()
    raise newException(CloudHubAuthError, "Provider rejected the link token: " & $response.code)
  if response.headers.getOrDefault("Upgrade").toLowerAscii() != "websocket":
    client.close()
    raise newException(WebSocketFailedUpgradeError,
      "Provider did not upgrade the management socket (" & $response.code & ")")
  result = WebSocket(tcpSocket: client.getSocket(), readyState: Open, masked: true)

type HubPacket = object
  ## One WebSocket packet as the hub session cares about it. Control frames are
  ## surfaced (rather than swallowed) so the idle deadline can count a pong as
  ## proof of life and a close code can be acted on.
  opcode: Opcode
  data: string
  closeCode: int

proc recvExactly(socket: AsyncSocket, count: int): Future[string] {.async.} =
  ## asyncnet's recv may answer short; keep reading until the field is complete
  ## or the peer goes away.
  var buffer = newStringOfCap(count)
  while buffer.len < count:
    let chunk = await socket.recv(count - buffer.len)
    if chunk.len == 0:
      raise newException(WebSocketClosedError, "Management socket closed")
    buffer.add(chunk)
  buffer

proc recvHubPacket(socket: WebSocket, maxBytes: int): Future[HubPacket] {.async.} =
  ## Bounded replacement for ws 0.5.0's `receivePacket`/`receiveStrPacket`.
  ##
  ## The library reads whatever length a frame header claims and concatenates
  ## continuation frames without any cap, so a hostile or merely broken
  ## provider could make a Pi Zero allocate until the OOM killer fires. It also
  ## discards the close code, which is exactly the byte that tells a revoked
  ## frame to stop reconnecting. Both are properties of the frame loop, not of
  ## anything the package exposes as an option — hence this local reader.
  if cast[int](socket.tcpSocket.getFd) == -1:
    socket.readyState = Closed
    raise newException(WebSocketClosedError, "Management socket closed")
  var payload = ""
  var messageOpcode = Opcode.Cont
  var assembling = false
  while true:
    let header = await recvExactly(socket.tcpSocket, 2)
    let b0 = header[0].uint8
    let b1 = header[1].uint8
    let fin = (b0 and 0b1000_0000'u8) != 0
    if (b0 and 0b0111_0000'u8) != 0:
      raise newException(WebSocketError, "Provider set a reserved WebSocket bit")
    # Mapped rather than converted: Opcode has holes (the reserved ranges), and
    # a reserved opcode is a protocol error, not something to smuggle through.
    let opcode =
      case b0 and 0x0f'u8
      of 0x0'u8: Opcode.Cont
      of 0x1'u8: Opcode.Text
      of 0x2'u8: Opcode.Binary
      of 0x8'u8: Opcode.Close
      of 0x9'u8: Opcode.Ping
      of 0xa'u8: Opcode.Pong
      else:
        raise newException(WebSocketError, "Provider sent a reserved WebSocket opcode")
    if (b1 and 0b1000_0000'u8) != 0:
      # We are the client; a conforming server never masks (RFC 6455 §5.1).
      raise newException(WebSocketError, "Provider sent a masked frame")
    var length = int(b1 and 0b0111_1111'u8)
    if length == 126:
      let extended = await recvExactly(socket.tcpSocket, 2)
      length = (int(extended[0].uint8) shl 8) or int(extended[1].uint8)
    elif length == 127:
      let extended = await recvExactly(socket.tcpSocket, 8)
      var wide = 0'u64
      for index in 0 .. 7:
        wide = (wide shl 8) or uint64(extended[index].uint8)
      # Refuse before allocating anything, and before the value can overflow an
      # int on a 32-bit device.
      if wide > uint64(maxBytes):
        raise newException(WebSocketError,
          "Inbound message exceeds " & $maxBytes & " bytes")
      length = int(wide)
    let control = opcode in {Close, Ping, Pong}
    if control:
      if length > 125 or not fin:
        raise newException(WebSocketError, "Provider sent a malformed control frame")
    elif payload.len + length > maxBytes:
      raise newException(WebSocketError,
        "Inbound message exceeds " & $maxBytes & " bytes")
    let data = if length > 0: await recvExactly(socket.tcpSocket, length) else: ""
    if control:
      case opcode
      of Close:
        socket.readyState = Closed
        var code = 0
        if data.len >= 2:
          code = (int(data[0].uint8) shl 8) or int(data[1].uint8)
        return HubPacket(opcode: Close, data: data, closeCode: code)
      of Ping:
        if assembling:
          # Mid-message: handing this to the caller would lose the partial
          # payload, so answer it here. ws 0.5.0 answers *every* ping from
          # inside the receive future, which can interleave with a send the
          # main loop already has in flight; confining that to this rare path
          # is the point of returning pings below.
          await socket.send(data, Pong)
      else:
        discard
      # A control frame between fragments must not break reassembly; only
      # report it when no message is in flight (the caller answers pings and
      # counts any frame as proof of life).
      if assembling:
        continue
      return HubPacket(opcode: opcode, data: data)
    if opcode == Cont:
      if not assembling:
        raise newException(WebSocketError, "Provider sent a stray continuation frame")
    else:
      if assembling:
        raise newException(WebSocketError, "Provider interleaved a new message")
      messageOpcode = opcode
    payload.add(data)
    if fin:
      return HubPacket(opcode: messageOpcode, data: payload)
    assembling = true

proc recvJsonWithin(socket: WebSocket, timeoutMs: int): Future[JsonNode] {.async.} =
  let recvFut = recvHubPacket(socket, HubMaxInboundBytes)
  if not await withTimeout(recvFut, timeoutMs):
    # A stalled handshake is a network problem, not an authentication
    # rejection — it must not count toward the demotion threshold.
    raise newException(WebSocketError, "Timed out waiting for the provider")
  let packet = recvFut.read()
  if packet.opcode == Close:
    if packet.closeCode == HubCloseAuthFailed:
      raise newException(CloudHubAuthError,
        "Provider closed the management socket with 4401 (authentication rejected)")
    raise newException(WebSocketClosedError,
      "Provider closed the management socket during the handshake")
  if packet.opcode == Ping:
    # Nothing else is sending on this socket during the handshake.
    await socket.send(packet.data, Pong)
    return %*{}
  if packet.opcode != Text:
    return %*{}
  try:
    result = parseJson(packet.data)
  except JsonParsingError:
    result = %*{}

proc runHandshake(socket: WebSocket, ctx: CloudVerbContext): Future[JsonNode] {.async.} =
  ## hello → challenge → auth → ready. Raises CloudHubAuthError when the
  ## provider rejects the signature or the handshake stalls. Returns the
  ## `ready` message — it carries `pending_commands` and (newer hubs) the
  ## link's granted `scopes`.
  var hello = helloStatePayload(ctx.frameConfig, ctx.scenesChecksum)
  hello["type"] = %"hello"
  await socket.send($hello)
  var challenge: JsonNode
  while true:
    challenge = await recvJsonWithin(socket, HubHandshakeTimeoutMs)
    let msgType = challenge{"type"}.getStr("")
    if msgType == "challenge":
      break
    if msgType == "error":
      raise newException(CloudHubAuthError,
        "Provider error during handshake: " & challenge{"error"}.getStr(""))
    # Tolerate unknown pre-auth chatter (forward compatibility).
  # The hub mints 32 raw random bytes, sends them base64-encoded, and verifies
  # the signature over the RAW bytes (cloud/apps/frame-hub/src/hub.ts,
  # verifyFrameSignature). Signing the base64 text would never verify.
  let encodedNonce = challenge{"nonce"}.getStr("")
  if encodedNonce.len == 0:
    raise newException(CloudHubAuthError, "Provider sent an empty challenge nonce")
  var nonce = ""
  try:
    nonce = base64.decode(encodedNonce)
  except CatchableError:
    raise newException(CloudHubAuthError,
      "Provider sent a challenge nonce that is not base64")
  if nonce.len < HubMinNonceBytes:
    # base64.decode is lenient enough to "succeed" on plain text, so the length
    # is what actually enforces the wire contract (>= 32 bytes of entropy).
    raise newException(CloudHubAuthError,
      "Provider sent a " & $nonce.len & "-byte challenge nonce; the wire " &
      "contract requires at least " & $HubMinNonceBytes & " bytes")
  let signature = signBase64(nonce)
  await socket.send($(%*{"type": "auth", "signature": signature}))
  while true:
    let ready = await recvJsonWithin(socket, HubHandshakeTimeoutMs)
    let msgType = ready{"type"}.getStr("")
    if msgType == "ready":
      return ready
    if msgType == "error":
      raise newException(CloudHubAuthError,
        "Provider rejected device authentication: " & ready{"error"}.getStr(""))

proc drainCloudLogChannel(buffer: var seq[SerializedLog]) =
  while buffer.len < HubLogBatchMaxLines * 2:
    let (success, payload) = cloudLogChannel.tryRecv()
    if not success:
      break
    buffer.add(payload)

proc logBatchMessage(buffer: seq[SerializedLog]): JsonNode =
  var logs = newJArray()
  for entry in buffer:
    var parsedLine: JsonNode
    try:
      parsedLine = parseJson(entry.line)
    except JsonParsingError:
      parsedLine = %entry.line
    logs.add(%*{"timestamp": entry.timestamp, "payload": parsedLine})
  %*{"type": "log_batch", "logs": logs}

proc latestMetricsSample(): JsonNode =
  let metrics = getUiMetrics()
  if metrics != nil and metrics.kind == JArray and metrics.len > 0:
    let last = metrics[metrics.len - 1]
    if last.kind == JObject and last{"metrics"} != nil:
      return last["metrics"]
  nil

var hubStopRequested: Atomic[bool]

proc hubIdleTimeoutSeconds(): float =
  ## Overridable so the liveness path can be exercised without a 90 s test.
  let override = getEnv("FRAMEOS_CLOUD_HUB_IDLE_SECONDS")
  if override.len > 0:
    try:
      return parseFloat(override)
    except ValueError:
      discard
  HubIdleTimeoutSeconds

proc pullServiceSettings(link: HubLinkSnapshot, ctx: CloudVerbContext): ServiceSettingsSync =
  ## One conditional service-settings pull (docs/cloud-frames.md). Runs on the
  ## hub thread, bounded to ServiceSettingsTimeoutMs, and never logs a value:
  ## the log line carries the status and the two flags, nothing else.
  ##
  ## Raises CloudHubAuthError on 401 so the thread's existing demotion counter
  ## — the same one the WebSocket handshake feeds — sees it. 429 and 5xx are
  ## explicitly not demotion signals: they keep the current copy and retry.
  result = syncServiceSettings(
    link.providerUrl, link.frameId, link.accessToken, serviceSettingsEtag,
    proc(settings: JsonNode): bool {.gcsafe.} =
      {.cast(gcsafe).}:
        persistCloudServiceSettingsUpdate(settings))
  let outcome = result
  serviceSettingsEtag = outcome.etag
  log(%*{"event": "cloud:serviceSettings", "status": outcome.status,
         "changed": outcome.changed, "cleared": outcome.cleared,
         "error": outcome.error})
  if outcome.cleared:
    log(%*{"event": "cloud:serviceSettings:revoked",
           "message": "The provider refused the service-settings fetch " &
                      "(insufficient_scope); all cloud-owned service settings " &
                      "were removed from this frame."})
  if outcome.changed:
    # Only when something really changed on disk — a 304 or an identical
    # payload must not restart the scenes.
    discard ctx.sendEventFn("reload", %*{})
  if outcome.authFailed:
    raise newException(CloudHubAuthError,
      "Provider rejected the link token on the service-settings fetch")

proc runHubSession(frameConfig: FrameConfig, link: HubLinkSnapshot):
    Future[SessionEndReason] {.async.} =
  var socket: WebSocket
  let handle = DialHandle()
  try:
    let dialFut = dialManagementSocket(link.providerUrl, link.wsPath,
                                       link.accessToken, handle)
    if not await withTimeout(dialFut, HubHandshakeTimeoutMs):
      # Close the client we are walking away from, and again if the dial ever
      # finishes: either way the socket it opened does not outlive this call.
      dialFut.addCallback(proc() {.gcsafe.} =
        {.cast(gcsafe).}:
          try:
            discard dialFut.read()
          except CatchableError:
            discard
          handle.closeClient())
      handle.closeClient()
      raise newException(WebSocketError, "Timed out connecting to the provider")
    socket = dialFut.read()
  except CatchableError:
    # Includes CloudHubAuthError, which the thread counts toward demotion; the
    # re-raise keeps its type.
    handle.closeClient()
    raise
  let ctx = defaultCloudVerbContext(frameConfig, link.scopes, link.scenesChecksum)
  var generation = link.generation
  var logBuffer: seq[SerializedLog] = @[]
  var logBufferSince = 0.0
  var lastMetricsSentAt = 0.0
  var lastStateCheckAt = 0.0
  var lastActiveScene = ""
  # The display geometry last reported (hello sends the first). A framebuffer
  # frame learns its real mode from the panel — sometimes only after hello on
  # a Pi 5 — and the workspace showed the image default (800x480) until the
  # next reconnect.
  var lastReportedDisplay = $frameConfig.width & "x" & $frameConfig.height
  # Starts at the current value, so a reconnect does not announce a render that
  # happened while the link was down: the provider's own staleness check covers
  # that, and a fleet reconnecting after a hub restart must not all ask to be
  # scraped at once.
  var lastSceneImageGeneration = sceneImageGenerationValue()
  var logsGranted = "telemetry:logs" in link.scopes
  var metricsGranted = "telemetry:metrics" in link.scopes
  # Read live each pass, not once here: a `set_settings` push may change (or
  # zero, i.e. disable) metrics_interval while this session is up.
  proc metricsPushInterval(): float =
    if frameConfig == nil or frameConfig.metricsInterval <= 0: 0.0
    else: max(frameConfig.metricsInterval, 5.0)
  let idleTimeout = hubIdleTimeoutSeconds()
  let pingInterval = min(HubPingIntervalSeconds, idleTimeout / 3)
  result = sessionDisconnected
  try:
    let ready = await runHandshake(socket, ctx)
    log(%*{"event": "cloud:hub:connected", "provider": link.providerUrl})
    # Parts of chunked uploads that never completed (the provider gave up,
    # or the previous session died mid-file) are only ever finished by the
    # session that started them; sweep the stale ones on every fresh start.
    try:
      cleanupStaleAssetUploadChunks()
    except CatchableError:
      discard
    # The hub announces the link's granted scopes in `ready`. Merge anything
    # new into the local link state — this is how frames whose enroll response
    # under-reported the grant (older providers said only frame:managed)
    # finally learn they may push telemetry. The generation-watch below picks
    # up the persisted change; the in-memory flags update here so the very
    # first session already forwards logs.
    let readyScopes = ready{"scopes"}
    if readyScopes != nil and readyScopes.kind == JArray:
      var announced: seq[string] = @[]
      for scope in readyScopes:
        if scope.kind == JString and scope.getStr("").len > 0:
          announced.add(scope.getStr(""))
      if persistProviderScopes(announced):
        generation = currentCloudLinkGeneration()
        for scope in announced:
          if scope notin ctx.scopes:
            ctx.scopes.add(scope)
        logsGranted = "telemetry:logs" in ctx.scopes
        metricsGranted = "telemetry:metrics" in ctx.scopes
        log(%*{"event": "cloud:hub:scopesUpdated", "scopes": ctx.scopes.join(" ")})
    # Service settings are fetched, never pushed. Pull once per session that
    # reaches `ready` — before the first render this session drives — so a
    # reconnect is self-healing: a key the owner changed (or revoked) while
    # this frame was offline lands now, without waiting for a nudge.
    var serviceSettingsGranted = ServiceSettingsScope in ctx.scopes
    # 0.0 means "pull as soon as the loop runs", which is what a scope granted
    # mid-session should do.
    var nextServiceSettingsPullAt = 0.0
    if serviceSettingsGranted:
      serviceSettingsPullRequested.store(false, moRelaxed)
      let outcome = pullServiceSettings(link, ctx)
      nextServiceSettingsPullAt = epochTime() +
        (if outcome.retryLater: HubServiceSettingsRetrySeconds
         else: HubServiceSettingsIntervalSeconds)
    if logsGranted:
      # Drop anything queued before this session so the provider only gets
      # lines from its own watch window.
      var stale: seq[SerializedLog] = @[]
      drainCloudLogChannel(stale)
      cloudLogForwardingEnabled.store(true, moRelaxed)
    # ---- upgrade watch ---------------------------------------------------
    # `frameos upgrade` runs in a process this one cannot see; the status file
    # is the whole channel. Replay a recent one first (the upgrade that
    # succeeded took the previous session down before it could report), then
    # follow the file for as long as it keeps moving.
    var lastUpgradeStatusMtime = upgradeStatusMtime()
    var lastUpgradeCheckAt = epochTime()
    var upgradeWatchingSince = 0.0
    if lastUpgradeStatusMtime > 0 and
        epochTime() - lastUpgradeStatusMtime <= HubUpgradeReplaySeconds:
      if logUpgradeStatus() notin UpgradeTerminalStatuses:
        upgradeWatchingSince = epochTime()
    var recvFut: Future[HubPacket] = nil
    var lastReceivedAt = epochTime()
    var lastPingSentAt = epochTime()
    while true:
      if hubStopRequested.load(moRelaxed):
        result = sessionStopped
        break
      # React to local link changes (disconnect route, scope updates) without
      # re-reading the state file on every tick. Scope removals apply
      # immediately, including to the telemetry push loops below.
      if currentCloudLinkGeneration() != generation:
        let fresh = snapshotLink()
        generation = fresh.generation
        refreshLocalNetworkPolicy(frameConfig)
        if not fresh.managed or fresh.accessToken != link.accessToken:
          result = sessionDemoted
          break
        ctx.scopes = fresh.scopes
        metricsGranted = "telemetry:metrics" in fresh.scopes
        serviceSettingsGranted = ServiceSettingsScope in fresh.scopes
        let logsNow = "telemetry:logs" in fresh.scopes
        if logsNow != logsGranted:
          logsGranted = logsNow
          cloudLogForwardingEnabled.store(logsNow, moRelaxed)
          if not logsNow:
            logBuffer.setLen(0)
      if recvFut == nil:
        recvFut = recvHubPacket(socket, HubMaxInboundBytes)
      if await withTimeout(recvFut, HubRecvTickMs):
        let packet = recvFut.read()
        recvFut = nil
        # Any frame at all — pong included — proves the link is still there.
        lastReceivedAt = epochTime()
        if packet.opcode == Close:
          if packet.closeCode == HubCloseAuthFailed:
            log(%*{"event": "cloud:hub:authRejected", "closeCode": packet.closeCode,
                   "reason": packet.data[min(2, packet.data.len) .. ^1]})
            result = sessionAuthRejected
          else:
            log(%*{"event": "cloud:hub:closed", "closeCode": packet.closeCode})
            result = sessionDisconnected
          break
        if packet.opcode == Ping:
          # Answered here rather than inside the receive future, so a pong can
          # never interleave with a log batch or ack already being written.
          await socket.send(packet.data, Pong)
        if packet.opcode == Text and packet.data.len > 0:
          var msg: JsonNode
          try:
            msg = parseJson(packet.data)
          except JsonParsingError:
            msg = nil
          let reply = handleCloudVerb(ctx, msg)
          if reply.ack != nil:
            await socket.send($reply.ack)
          for extra in reply.extra:
            await socket.send($extra)
      # ---- periodic pushes ------------------------------------------------
      let now = epochTime()
      # ---- liveness --------------------------------------------------------
      # The hub heartbeats every 30s, so silence past HubIdleTimeoutSeconds
      # means the socket is dead even though TCP has not said so yet. Prod it
      # once per heartbeat window first: a pong resets the deadline, and a
      # broken link fails the send instead of idling on.
      if now - lastReceivedAt >= idleTimeout:
        log(%*{"event": "cloud:hub:idleTimeout",
               "silentSeconds": round(now - lastReceivedAt, 1)})
        result = sessionDisconnected
        break
      if now - lastReceivedAt >= pingInterval and
          now - lastPingSentAt >= pingInterval:
        lastPingSentAt = now
        await socket.ping()
      if logsGranted:
        let before = logBuffer.len
        drainCloudLogChannel(logBuffer)
        if before == 0 and logBuffer.len > 0:
          logBufferSince = now
        if logBuffer.len >= HubLogBatchMaxLines or
            (logBuffer.len > 0 and now - logBufferSince >= HubLogBatchMaxSeconds):
          await socket.send($logBatchMessage(logBuffer))
          logBuffer.setLen(0)
      # A `refresh_service_settings` nudge was accepted (its ack already went
      # out), or the slow staleness timer came round. Both are conditional
      # fetches: unchanged settings cost one 304 and change nothing.
      if serviceSettingsGranted and
          (serviceSettingsPullRequested.load(moRelaxed) or
           now >= nextServiceSettingsPullAt):
        serviceSettingsPullRequested.store(false, moRelaxed)
        let outcome = pullServiceSettings(link, ctx)
        nextServiceSettingsPullAt = now +
          (if outcome.retryLater: HubServiceSettingsRetrySeconds
           else: HubServiceSettingsIntervalSeconds)
      let metricsInterval = metricsPushInterval()
      if metricsGranted and metricsInterval > 0 and now - lastMetricsSentAt >= metricsInterval:
        let sample = latestMetricsSample()
        if sample != nil:
          lastMetricsSentAt = now
          await socket.send($(%*{"type": "metrics", "metrics": sample}))
      if now - lastUpgradeCheckAt >= HubUpgradeCheckSeconds:
        lastUpgradeCheckAt = now
        let upgradeMtime = upgradeStatusMtime()
        if upgradeMtime > lastUpgradeStatusMtime:
          lastUpgradeStatusMtime = upgradeMtime
          upgradeWatchingSince =
            if logUpgradeStatus() in UpgradeTerminalStatuses: 0.0
            elif upgradeWatchingSince > 0.0: upgradeWatchingSince
            else: now
        elif upgradeWatchingSince > 0.0 and
            now - upgradeWatchingSince >= HubUpgradeStallSeconds:
          # Nothing has written the file for the whole stall window: the child
          # is gone. Say so once and stop watching, rather than leaving the log
          # ending on a `running` line that will never be followed up.
          upgradeWatchingSince = 0.0
          log(%*{"event": "cloud:upgrade", "status": "stalled",
                 "detail": "the upgrade process stopped reporting; check " &
                           frameosInstallDir() / "logs" / "upgrade.log"})
      if now - lastStateCheckAt >= HubStateCheckSeconds:
        lastStateCheckAt = now
        # Pick up local settings changes (allowLocalNetworkAccess toggled on
        # the admin page) without waiting for a link-state generation bump.
        refreshLocalNetworkPolicy(frameConfig)
        let (sceneId, _) = getAllPublicStates()
        let display = $frameConfig.width & "x" & $frameConfig.height
        if sceneId.string != lastActiveScene or display != lastReportedDisplay:
          lastActiveScene = sceneId.string
          if display != lastReportedDisplay:
            log(%*{"event": "cloud:hardware:changed", "display": display,
                   "previous": lastReportedDisplay})
          lastReportedDisplay = display
          var stateMessage = helloStatePayload(frameConfig, ctx.scenesChecksum)
          stateMessage["type"] = %"state"
          await socket.send($stateMessage)
        # "There is a fresh preview of this scene on disk." Not the preview
        # itself: the provider decides whether anyone is looking before it
        # spends the frame's uplink on an asset_get, and a frame nobody has
        # open costs one small JSON message per snapshot write (at most one a
        # minute, SCENE_IMAGE_MAX_AGE_SECONDS). docs/cloud-frames.md.
        let sceneImageGeneration = sceneImageGenerationValue()
        if sceneImageGeneration != lastSceneImageGeneration:
          lastSceneImageGeneration = sceneImageGeneration
          await socket.send($(%*{"type": "render",
                                 "active_scene": sceneId.string}))
  except CloudHubAuthError:
    # Handshake-level rejection: let the thread count it toward demotion.
    raise
  except WebSocketError as error:
    # Includes the oversize/protocol refusals from recvHubPacket, which are
    # worth seeing in the log rather than silently reconnecting forever.
    log(%*{"event": "cloud:hub:socketError", "error": error.msg})
    result = sessionDisconnected
  except CatchableError as error:
    log(%*{"event": "cloud:hub:error", "error": error.msg})
    result = sessionDisconnected
  finally:
    cloudLogForwardingEnabled.store(false, moRelaxed)
    try:
      socket.close()
    except CatchableError:
      discard

# ---------------------------------------------------------------------------
# Background thread
# ---------------------------------------------------------------------------

var
  hubThread: Thread[FrameConfig]
  hubThreadStarted = false

proc sleepInterruptible(seconds: float) =
  var remainingMs = int(seconds * 1000)
  while remainingMs > 0 and not hubStopRequested.load(moRelaxed):
    let chunk = min(remainingMs, 200)
    sleep(chunk)
    remainingMs -= chunk

proc cloudHubThreadMain(frameConfig: FrameConfig) {.thread.} =
  {.cast(gcsafe).}:
    randomize()
    var backoff = HubBackoffMinSeconds
    var authFailures = 0
    var enrollBackoff = HubEnrollBackoffMinSeconds
    var nextEnrollAttemptAt = 0.0
    while not hubStopRequested.load(moRelaxed):
      # Keep the private-network HTTP policy in sync with the link state and
      # the local override on every pass (idle pass = every ~2s).
      refreshLocalNetworkPolicy(frameConfig)
      # ---- claim-token handoff -------------------------------------------
      # Checked every pass so a pending file written after boot (setup portal,
      # flasher handoff) is picked up too; fileExists keeps the idle cost nil.
      if takeEnrollmentNudge():
        # The portal just brought the network up (or queued a fresh claim
        # token); the current backoff was earned by attempts that could never
        # have succeeded, so start over.
        nextEnrollAttemptAt = 0.0
        enrollBackoff = HubEnrollBackoffMinSeconds
      # ---- device-flow ("link code") handoff -----------------------------
      # Polls a pending flow so a link started from the admin page (or queued
      # by the setup portal for the panel) completes without a browser tab
      # driving it; starts a queued panel link once the network is up. When
      # managed enrollment succeeds this thread IS the hub client, so the
      # next pass picks the new link state up by itself.
      if deviceFlowTick(frameConfig):
        log(%*{"event": "cloud:enroll:linkCode", "ok": true})
      if epochTime() >= nextEnrollAttemptAt and fileExists(pendingEnrollmentPath()):
        # Announced BEFORE the attempt, because the attempt is what changes
        # state: a successful or permanently-rejected enrollment deletes the
        # pending file, and if the process dies between that and the outcome
        # log, the card is left unable to retry with nothing on record saying
        # it ever tried. A Pi 5 crash-looping on its display driver lost its
        # enrollment exactly that way — token redeemed, pending file gone,
        # not one line about it in a 300 KB log.
        log(%*{"event": "cloud:enroll:boot:attempt"})
        let (resolved, attempted, outcome, personalization) = processPendingCloudEnrollment(frameConfig)
        if attempted:
          log(%*{"event": "cloud:enroll:boot", "ok": outcome.ok,
                 "resolved": resolved, "error": outcome.error})
        if outcome.ok and personalization.len > 0:
          # The card's name and time zone belong in frame.json too: the
          # panel otherwise keeps the image's "FrameOS Setup" name and its
          # UTC clock until someone pushes settings from the cloud.
          applyEnrollmentPersonalization(personalization)
        else:
          # No request went out, and until now nothing said so. An expired
          # claim token deletes the pending file and gives up on enrollment
          # for the life of the card, and an unreadable one retries into a
          # growing backoff — both in total silence, which reads from the
          # logs exactly like a frame that never tried to enroll at all.
          # (Cost: a Pi 5 that came up healthy and simply never appeared in
          # the cloud, with no line anywhere to say why.)
          log(%*{"event": "cloud:enroll:boot:skipped",
                 "resolved": resolved,
                 "error": if outcome.error.len > 0: outcome.error
                          else: "no_pending_enrollment_readable"})
        if resolved:
          enrollBackoff = HubEnrollBackoffMinSeconds
          nextEnrollAttemptAt = 0.0
        else:
          nextEnrollAttemptAt = epochTime() + enrollBackoff
          enrollBackoff = min(enrollBackoff * 2, HubEnrollBackoffMaxSeconds)
      # ---- managed session ------------------------------------------------
      let link = snapshotLink()
      if not link.managed:
        sleepInterruptible(2.0)
        continue
      var reason = sessionDisconnected
      var authRejected = false
      let sessionStartedAt = epochTime()
      try:
        reason = waitFor runHubSession(frameConfig, link)
      except CloudHubAuthError as error:
        authRejected = true
        log(%*{"event": "cloud:hub:authFailed", "error": error.msg,
               "failures": authFailures + 1, "limit": HubAuthFailureLimit})
      except CatchableError as error:
        log(%*{"event": "cloud:hub:error", "error": error.msg})
      if authRejected or reason == sessionAuthRejected:
        authFailures += 1
        if authFailures >= HubAuthFailureLimit:
          demoteManagedLink("invalid_link_token")
          authFailures = 0
          continue
      else:
        authFailures = 0
      case reason
      of sessionStopped:
        break
      of sessionDemoted:
        log(%*{"event": "cloud:hub:linkChanged"})
        continue
      else:
        discard
      # A session that lived for a while resets the backoff.
      if epochTime() - sessionStartedAt > HubBackoffMaxSeconds:
        backoff = HubBackoffMinSeconds
      let jittered = backoff / 2 + rand(backoff / 2)
      log(%*{"event": "cloud:hub:reconnect", "inSeconds": round(jittered, 1)})
      sleepInterruptible(jittered)
      backoff = min(backoff * 2, HubBackoffMaxSeconds)

proc startCloudManagement*(frameConfig: FrameConfig) {.gcsafe.} =
  ## Starts the cloud hub thread. Idempotent; the thread idles cheaply until
  ## the frame is enrolled (mode=managed in cloud_link.json) or a pending
  ## claim-token enrollment file appears at boot.
  {.gcsafe.}:
    # A local upload replacing provider scenes must lift (or a rehydrate must
    # raise) the deny without waiting for a hub tick — the hub thread idles
    # on a standalone or demoted frame.
    uploadedScenesChangedHook = proc() {.gcsafe.} =
      refreshLocalNetworkPolicy(frameConfig)
    # Policy is correct from the first render onwards, not only once the
    # thread has spun up.
    refreshLocalNetworkPolicy(frameConfig)
    if hubThreadStarted:
      return
    hubThreadStarted = true
    hubStopRequested.store(false, moRelaxed)
    createThread(hubThread, cloudHubThreadMain, frameConfig)

proc startCloudHubClient*(frameConfig: FrameConfig) {.gcsafe.} =
  ## Alias used by the enrollment routes; the managed session starts as soon
  ## as the thread observes the new link state.
  startCloudManagement(frameConfig)

proc stopCloudHubClient*() {.gcsafe.} =
  ## Asks the hub thread to wind down (used on shutdown; the disconnect route
  ## does not need it — the thread notices the state change and idles).
  hubStopRequested.store(true, moRelaxed)
