## Management hub client for cloud-managed frames (docs/cloud-frames.md).
##
## When ./state/cloud_link.json says `"mode": "managed"`, a background thread
## dials `wss://{provider}{ws_path}` with the link Bearer token, proves
## possession of the device Ed25519 key (hello → challenge → auth → ready) and
## then serves the restricted verb set.
##
## The restricted profile is structural: this module implements the complete
## verb list from the wire spec and nothing else. There is no shell verb, no
## file read/write verb, no SSH anything, no compiled-scene deploy — the code
## for those capabilities simply does not exist here, so no provider-side
## compromise or configuration flag can reach them. Anything outside the verb
## table is answered with `unknown_verb` and audit-logged through the normal
## log pipeline (`cloud:audit`).
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
import std/httpclient
import std/net as std_net
import std/uri
import ws

import frameos/channels
import frameos/device_setup
import frameos/hal/processes
import frameos/interpreter
import frameos/js_runtime/app_runtime
import frameos/scenes
import frameos/server/api
import frameos/server/state
import frameos/types
import frameos/upgrade
import frameos/utils/http_client
import ./enrollment
import ./identity
import ./link_state

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
  HubGetLogsDefaultLimit = 200
  HubGetLogsMaxLimit = 1000

# Declarative settings a provider may push; every key maps onto an existing
# frame.json field through the same persist path the local admin uses. Must
# stay in sync with docs/cloud-frames.md (`set_settings`).
const CLOUD_SETTINGS_ALLOWLIST* = [
  "name", "rotate", "interval", "scaling_mode", "timezone", "debug",
]

type
  CloudHubAuthError* = object of CatchableError

  CloudVerbContext* = ref object
    ## Everything handleCloudVerb needs, injected so tests can stub the side
    ## effects and assert on them.
    frameConfig*: FrameConfig
    scopes*: seq[string]
    scenesChecksum*: string
    sendEventFn*: proc(event: string, payload: JsonNode) {.gcsafe.}
    persistSettingsFn*: proc(payload: JsonNode) {.gcsafe.}
    persistChecksumFn*: proc(checksum: string) {.gcsafe.}
    getLogsFn*: proc(): JsonNode {.gcsafe.}
    getMetricsFn*: proc(): JsonNode {.gcsafe.}
    getStateFn*: proc(): JsonNode {.gcsafe.}
    rebootFn*: proc() {.gcsafe.}
    auditFn*: proc(payload: JsonNode) {.gcsafe.}

  CloudVerbReply* = object
    ack*: JsonNode
    extra*: seq[JsonNode]

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
    generation: int

# ---------------------------------------------------------------------------
# Link state helpers
# ---------------------------------------------------------------------------

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
        generation: currentCloudLinkGeneration(),
      )

proc persistScenesChecksum(checksum: string) {.gcsafe.} =
  {.gcsafe.}:
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["scenes_checksum"] = %checksum
      saveCloudLinkState(state)

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

proc refreshLocalNetworkPolicy*(frameConfig: FrameConfig) {.gcsafe.} =
  ## Recomputes the managed-frame private-network HTTP deny
  ## (utils/http_client.nim): active iff the frame is cloud-managed and the
  ## local admin has not set `network.allowLocalNetworkAccess` in frame.json.
  ## Called at startup and whenever the hub thread observes link-state or
  ## config changes; standalone and backend-managed frames always end up with
  ## the policy off.
  {.gcsafe.}:
    let link = snapshotLink()
    let localOverride = frameConfig != nil and frameConfig.network != nil and
      frameConfig.network.allowLocalNetworkAccess
    var exempt: seq[string] = @[]
    if link.managed:
      let hostPort = providerExemptHostPort(link.providerUrl)
      if hostPort.len > 0:
        exempt.add(hostPort)
    setLocalNetworkPolicy(link.managed and not localOverride, exempt)

proc demoteManagedLink(reason: string) {.gcsafe.} =
  ## Persistent 401: the provider revoked this frame. Return to standalone —
  ## keep rendering the last pushed scenes, never touch them.
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
    let command = "(sleep 2; systemctl reboot || reboot) >/dev/null 2>&1 &"
    discard runShellCapture(privilegedCommand("sh -c " & shellQuote(command)), timeoutMs = 10_000)

proc defaultCloudVerbContext*(frameConfig: FrameConfig, scopes: seq[string],
                              scenesChecksum: string): CloudVerbContext {.gcsafe.} =
  {.gcsafe.}:
    let config = frameConfig
    CloudVerbContext(
      frameConfig: frameConfig,
      scopes: scopes,
      scenesChecksum: scenesChecksum,
      sendEventFn: proc(event: string, payload: JsonNode) {.gcsafe.} =
        sendEvent(event, payload),
      persistSettingsFn: proc(payload: JsonNode) {.gcsafe.} =
        {.gcsafe.}:
          persistFrameApiUpdate(payload),
      persistChecksumFn: proc(checksum: string) {.gcsafe.} =
        persistScenesChecksum(checksum),
      getLogsFn: proc(): JsonNode {.gcsafe.} =
        getUiLogs(),
      getMetricsFn: proc(): JsonNode {.gcsafe.} =
        getUiMetrics(),
      getStateFn: proc(): JsonNode {.gcsafe.} =
        helloStatePayload(config, snapshotLink().scenesChecksum),
      rebootFn: proc() {.gcsafe.} =
        defaultReboot(),
      auditFn: proc(payload: JsonNode) {.gcsafe.} =
        log(payload),
    )

# ---------------------------------------------------------------------------
# Scene payload validation
# ---------------------------------------------------------------------------

proc validateInterpretedScenesPayload*(scenes: JsonNode): tuple[ok: bool, error: string] {.gcsafe.} =
  ## A managed frame only ever accepts interpreted node-graph JSON. Any app
  ## node that ships Nim source without a JS implementation is a compiled /
  ## source-only app and gets the whole payload refused (`not_interpreted`) —
  ## those remain the domain of the self-hosted backend.
  if scenes == nil or scenes.kind != JArray or scenes.len == 0:
    return (false, "invalid_scenes")
  {.gcsafe.}:
    for scene in scenes:
      if scene == nil or scene.kind != JObject:
        return (false, "invalid_scenes")
      let apps = scene{"apps"}
      let nodes = scene{"nodes"}
      if nodes == nil or nodes.kind != JArray:
        continue
      for node in nodes:
        if node == nil or node.kind != JObject:
          continue
        if node{"type"}.getStr("") != "app":
          continue
        let data = node{"data"}
        var sources: JsonNode = nil
        if data != nil and data.kind == JObject:
          sources = data{"sources"}
        if (sources == nil or sources.kind != JObject) and
            apps != nil and apps.kind == JObject and data != nil and data.kind == JObject:
          let keyword = data{"keyword"}.getStr("")
          if keyword.len > 0 and apps{keyword} != nil and apps{keyword}.kind == JObject:
            sources = apps{keyword}{"sources"}
        if sources != nil and sources.kind == JObject:
          var hasNimSource = false
          for filename in sources.keys:
            if filename.endsWith(".nim"):
              hasNimSource = true
              break
          if hasNimSource and not hasJsAppSource(sources):
            return (false, "not_interpreted")
    # Finally require the payload to parse as interpreted scene inputs — the
    # same parser the uploaded-scenes hot-reload path uses.
    try:
      if parseInterpretedSceneInputs($scenes).len == 0:
        return (false, "invalid_scenes")
    except CatchableError:
      return (false, "invalid_scenes")
  (true, "")

proc expectedUploadedSceneId(scenes: JsonNode): string =
  ## updateUploadedScenesFromPayload prefixes every scene id with "uploaded/".
  if scenes.kind == JArray and scenes.len > 0 and scenes[0].kind == JObject:
    let firstId = scenes[0]{"id"}.getStr("")
    if firstId.len > 0:
      return "uploaded/" & firstId
  ""

# ---------------------------------------------------------------------------
# Verb dispatcher
# ---------------------------------------------------------------------------

proc ackOk(id: JsonNode): JsonNode =
  result = %*{"type": "ack", "ok": true}
  if id != nil and id.kind != JNull:
    result["id"] = id

proc ackError(id: JsonNode, error: string): JsonNode =
  result = %*{"type": "ack", "ok": false, "error": error}
  if id != nil and id.kind != JNull:
    result["id"] = id

proc audit(ctx: CloudVerbContext, verb: string, ok: bool, error = "") =
  var payload = %*{"event": "cloud:audit", "verb": verb, "ok": ok}
  if error.len > 0:
    payload["error"] = %error
  if not ctx.auditFn.isNil:
    ctx.auditFn(payload)

proc hasScope(ctx: CloudVerbContext, scope: string): bool =
  scope in ctx.scopes

proc handleSetScenes(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  let scenes = msg{"scenes"}
  let checksum = msg{"checksum"}.getStr("")
  let (ok, error) = validateInterpretedScenesPayload(scenes)
  if not ok:
    ctx.audit("set_scenes", false, error)
    return CloudVerbReply(ack: ackError(id, error))
  ctx.sendEventFn("uploadScenes", %*{"scenes": scenes})
  ctx.scenesChecksum = checksum
  if not ctx.persistChecksumFn.isNil:
    ctx.persistChecksumFn(checksum)
  ctx.audit("set_scenes", true)
  var sceneAck = %*{"type": "scene_ack", "checksum": checksum,
                    "active_scene": expectedUploadedSceneId(scenes)}
  if id != nil and id.kind != JNull:
    sceneAck["id"] = id
  CloudVerbReply(ack: ackOk(id), extra: @[sceneAck])

proc handleSetSettings(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  let settings = msg{"settings"}
  if settings == nil or settings.kind != JObject:
    ctx.audit("set_settings", false, "invalid_settings")
    return CloudVerbReply(ack: ackError(id, "invalid_settings"))
  # One unknown key refuses the whole verb: the allowlist is the contract, and
  # partial application would leave provider and frame disagreeing about what
  # got set.
  for key in settings.keys:
    if key notin CLOUD_SETTINGS_ALLOWLIST:
      ctx.audit("set_settings", false, "setting_not_allowed: " & key)
      return CloudVerbReply(ack: ackError(id, "setting_not_allowed"))
  var payload = newJObject()
  for key in settings.keys:
    payload[key] = copy(settings[key])
  if payload.len > 0:
    try:
      ctx.persistSettingsFn(payload)
    except CatchableError as error:
      ctx.audit("set_settings", false, "persist_failed: " & error.msg)
      return CloudVerbReply(ack: ackError(id, "persist_failed"))
    ctx.sendEventFn("reload", %*{})
  ctx.audit("set_settings", true)
  CloudVerbReply(ack: ackOk(id))

proc handleSetSchedule(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  let schedule = msg{"schedule"}
  if schedule == nil or schedule.kind != JObject:
    ctx.audit("set_schedule", false, "invalid_schedule")
    return CloudVerbReply(ack: ackError(id, "invalid_schedule"))
  try:
    ctx.persistSettingsFn(%*{"schedule": schedule})
  except CatchableError as error:
    ctx.audit("set_schedule", false, "persist_failed: " & error.msg)
    return CloudVerbReply(ack: ackError(id, "persist_failed"))
  ctx.sendEventFn("reload", %*{})
  ctx.audit("set_schedule", true)
  CloudVerbReply(ack: ackOk(id))

proc handleSetCurrentScene(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  let sceneId = msg{"scene_id"}.getStr("")
  if sceneId.len == 0:
    ctx.audit("set_current_scene", false, "invalid_scene_id")
    return CloudVerbReply(ack: ackError(id, "invalid_scene_id"))
  ctx.sendEventFn("setCurrentScene", %*{"sceneId": sceneId})
  ctx.audit("set_current_scene", true)
  CloudVerbReply(ack: ackOk(id))

proc handleGetLogs(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if not ctx.hasScope("telemetry:logs"):
    ctx.audit("get_logs", false, "insufficient_scope")
    return CloudVerbReply(ack: ackError(id, "insufficient_scope"))
  let since = msg{"since"}.getStr("")
  var limit = msg{"limit"}.getInt(HubGetLogsDefaultLimit)
  limit = max(1, min(limit, HubGetLogsMaxLimit))
  let allLogs = ctx.getLogsFn()
  var filtered = newJArray()
  if allLogs != nil and allLogs.kind == JArray:
    for entry in allLogs:
      if since.len == 0 or entry{"timestamp"}.getStr("") >= since:
        filtered.add(entry)
  var logs = newJArray()
  let start = max(0, filtered.len - limit)
  for index in start ..< filtered.len:
    logs.add(filtered[index])
  var ack = ackOk(id)
  ack["logs"] = logs
  CloudVerbReply(ack: ack)

proc handleGetMetrics(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  if not ctx.hasScope("telemetry:metrics"):
    ctx.audit("get_metrics", false, "insufficient_scope")
    return CloudVerbReply(ack: ackError(id, "insufficient_scope"))
  var ack = ackOk(id)
  ack["metrics"] = ctx.getMetricsFn()
  CloudVerbReply(ack: ack)

proc handleCloudVerb*(ctx: CloudVerbContext, msg: JsonNode): CloudVerbReply {.gcsafe.} =
  ## Dispatches one provider→frame message. The verb table below is the
  ## complete cloud-profile capability surface of this frame; anything else —
  ## `shell`, `exec`, `file_write`, whatever a compromised provider invents —
  ## falls through to `unknown_verb` and is audit-logged.
  if msg == nil or msg.kind != JObject:
    return CloudVerbReply(ack: %*{"type": "ack", "ok": false, "error": "invalid_message"})
  let id = msg{"id"}
  let verb = msg{"type"}.getStr("")
  case verb
  of "set_scenes":
    result = handleSetScenes(ctx, id, msg)
  of "set_settings":
    result = handleSetSettings(ctx, id, msg)
  of "set_schedule":
    result = handleSetSchedule(ctx, id, msg)
  of "set_current_scene":
    result = handleSetCurrentScene(ctx, id, msg)
  of "get_state":
    var ack = ackOk(id)
    ack["state"] = ctx.getStateFn()
    var stateMessage = ctx.getStateFn()
    stateMessage["type"] = %"state"
    if id != nil and id.kind != JNull:
      stateMessage["id"] = id
    result = CloudVerbReply(ack: ack, extra: @[stateMessage])
  of "get_logs":
    result = handleGetLogs(ctx, id, msg)
  of "get_metrics":
    result = handleGetMetrics(ctx, id)
  of "render":
    ctx.sendEventFn("render", %*{})
    result = CloudVerbReply(ack: ackOk(id))
  of "reboot":
    ctx.audit("reboot", true)
    result = CloudVerbReply(ack: ackOk(id))
    # Delayed so the ack still flushes before the device goes down.
    ctx.rebootFn()
  of "restart_runtime":
    ctx.audit("restart_runtime", true)
    result = CloudVerbReply(ack: ackOk(id))
    ctx.sendEventFn("restart", %*{})
  of "notify_update_available":
    # Advisory only: the device fetches release metadata from its own
    # configured archive and verifies signatures itself. The payload carries
    # no URLs by design, and nothing here would fetch one if it did.
    ctx.audit("notify_update_available", true)
    log(%*{"event": "cloud:updateAvailable", "version": msg{"version"}.getStr("")})
    result = CloudVerbReply(ack: ackOk(id))
  else:
    let label = if verb.len > 0: verb else: "(missing type)"
    ctx.audit(label, false, "unknown_verb")
    result = CloudVerbReply(ack: ackError(id, "unknown_verb"))

# ---------------------------------------------------------------------------
# WebSocket session
# ---------------------------------------------------------------------------

proc dialManagementSocket(providerUrl, wsPath, accessToken: string):
    Future[WebSocket] {.async.} =
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

proc recvJsonWithin(socket: WebSocket, timeoutMs: int): Future[JsonNode] {.async.} =
  let recvFut = socket.receiveStrPacket()
  if not await withTimeout(recvFut, timeoutMs):
    # A stalled handshake is a network problem, not an authentication
    # rejection — it must not count toward the demotion threshold.
    raise newException(WebSocketError, "Timed out waiting for the provider")
  try:
    result = parseJson(recvFut.read())
  except JsonParsingError:
    result = %*{}

proc runHandshake(socket: WebSocket, ctx: CloudVerbContext) {.async.} =
  ## hello → challenge → auth → ready. Raises CloudHubAuthError when the
  ## provider rejects the signature or the handshake stalls.
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
  let nonce = challenge{"nonce"}.getStr("")
  if nonce.len == 0:
    raise newException(CloudHubAuthError, "Provider sent an empty challenge nonce")
  let signature = signBase64(nonce)
  await socket.send($(%*{"type": "auth", "signature": signature}))
  while true:
    let ready = await recvJsonWithin(socket, HubHandshakeTimeoutMs)
    let msgType = ready{"type"}.getStr("")
    if msgType == "ready":
      break
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

proc runHubSession(frameConfig: FrameConfig, link: HubLinkSnapshot):
    Future[SessionEndReason] {.async.} =
  var socket: WebSocket
  try:
    let dialFut = dialManagementSocket(link.providerUrl, link.wsPath, link.accessToken)
    if not await withTimeout(dialFut, HubHandshakeTimeoutMs):
      raise newException(WebSocketError, "Timed out connecting to the provider")
    socket = dialFut.read()
  except CloudHubAuthError:
    raise
  let ctx = defaultCloudVerbContext(frameConfig, link.scopes, link.scenesChecksum)
  var generation = link.generation
  var logBuffer: seq[SerializedLog] = @[]
  var logBufferSince = 0.0
  var lastMetricsSentAt = 0.0
  var lastStateCheckAt = 0.0
  var lastActiveScene = ""
  var logsGranted = "telemetry:logs" in link.scopes
  var metricsGranted = "telemetry:metrics" in link.scopes
  let metricsInterval = max(frameConfig.metricsInterval, 5.0)
  result = sessionDisconnected
  try:
    await runHandshake(socket, ctx)
    log(%*{"event": "cloud:hub:connected", "provider": link.providerUrl})
    if logsGranted:
      # Drop anything queued before this session so the provider only gets
      # lines from its own watch window.
      var stale: seq[SerializedLog] = @[]
      drainCloudLogChannel(stale)
      cloudLogForwardingEnabled.store(true, moRelaxed)
    var recvFut: Future[string] = nil
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
        let logsNow = "telemetry:logs" in fresh.scopes
        if logsNow != logsGranted:
          logsGranted = logsNow
          cloudLogForwardingEnabled.store(logsNow, moRelaxed)
          if not logsNow:
            logBuffer.setLen(0)
      if recvFut == nil:
        recvFut = socket.receiveStrPacket()
      if await withTimeout(recvFut, HubRecvTickMs):
        let raw = recvFut.read()
        recvFut = nil
        # receiveStrPacket answers pings itself and surfaces them as "".
        if raw.len > 0:
          var msg: JsonNode
          try:
            msg = parseJson(raw)
          except JsonParsingError:
            msg = nil
          let reply = handleCloudVerb(ctx, msg)
          if reply.ack != nil:
            await socket.send($reply.ack)
          for extra in reply.extra:
            await socket.send($extra)
      # ---- periodic pushes ------------------------------------------------
      let now = epochTime()
      if logsGranted:
        let before = logBuffer.len
        drainCloudLogChannel(logBuffer)
        if before == 0 and logBuffer.len > 0:
          logBufferSince = now
        if logBuffer.len >= HubLogBatchMaxLines or
            (logBuffer.len > 0 and now - logBufferSince >= HubLogBatchMaxSeconds):
          await socket.send($logBatchMessage(logBuffer))
          logBuffer.setLen(0)
      if metricsGranted and now - lastMetricsSentAt >= metricsInterval:
        let sample = latestMetricsSample()
        if sample != nil:
          lastMetricsSentAt = now
          await socket.send($(%*{"type": "metrics", "metrics": sample}))
      if now - lastStateCheckAt >= HubStateCheckSeconds:
        lastStateCheckAt = now
        # Pick up local settings changes (allowLocalNetworkAccess toggled on
        # the admin page) without waiting for a link-state generation bump.
        refreshLocalNetworkPolicy(frameConfig)
        let (sceneId, _) = getAllPublicStates()
        if sceneId.string != lastActiveScene:
          lastActiveScene = sceneId.string
          var stateMessage = helloStatePayload(frameConfig, ctx.scenesChecksum)
          stateMessage["type"] = %"state"
          await socket.send($stateMessage)
  except CloudHubAuthError:
    # Handshake-level rejection: let the thread count it toward demotion.
    raise
  except WebSocketError:
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
      if epochTime() >= nextEnrollAttemptAt and fileExists(pendingEnrollmentPath()):
        let (resolved, attempted, outcome) = processPendingCloudEnrollment(frameConfig)
        if attempted:
          log(%*{"event": "cloud:enroll:boot", "ok": outcome.ok,
                 "resolved": resolved, "error": outcome.error})
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
