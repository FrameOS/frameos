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
## write verbs `asset_put`/`asset_mkdir`/`asset_delete`/`asset_rename`):
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
import frameos/hal/processes
import frameos/interpreter
import frameos/js_runtime/app_runtime
import frameos/scenes
import frameos/server/api
import frameos/server/routes/admin_api_assets_routes
import frameos/server/state
import frameos/types
import frameos/upgrade
import frameos/utils/http_client
import ./enrollment
import ./identity
import ./link_state
import ./scene_guard
import ./service_settings

# Tests and other importers keep reaching CLOUD_REFUSED_APP_KEYWORDS /
# refusedCloudAppKeyword through this module.
export scene_guard

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
  # Asset verbs (docs/cloud-frames.md): the reference provider stores at most
  # this much per file, so reading more would only be thrown away — refuse
  # with `too_large` instead. Chunks stay comfortably inside the hub's 4 MiB
  # frame cap even after the ~4/3 base64 inflation.
  HubMaxAssetFileBytes* = 8 * 1024 * 1024
  HubAssetChunkRawBytes = 1024 * 1024
  # Listing bound. The provider caps the stored listing JSON at 256 KiB; 5000
  # entries of typical paths sit under that while covering any sane assets
  # folder. Over the cap the listing says `truncated: true` — never a silent
  # stop (a partial listing that looks complete is worse than none).
  HubMaxAssetListEntries* = 5000
  # `asset_put` rides a single inbound frame (there is no cloud→device chunk
  # stream), so the raw payload must survive base64 inflation plus envelope
  # inside HubMaxInboundBytes. 2.5 MiB raw ≈ 3.4 MiB encoded.
  HubMaxAssetUploadBytes* = 2_621_440
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

# Declarative settings a provider may push; every key maps onto an existing
# frame.json field through the same persist path the local admin uses. Must
# stay in sync with docs/cloud-frames.md (`set_settings`).
const CLOUD_SETTINGS_ALLOWLIST* = [
  "name", "rotate", "interval", "scaling_mode", "timezone", "debug",
]

# CLOUD_REFUSED_APP_KEYWORDS / refusedCloudAppKeyword moved to
# cloud/scene_guard.nim (re-exported below): the scene registry now re-checks
# persisted cloud-origin payloads at load time, and scenes.nim cannot import
# this module.

type
  CloudHubAuthError* = object of CatchableError

  AssetReadResult* = object
    ## One asset read for `asset_get`. `error` is empty on success and one of
    ## the wire contract's per-verb errors otherwise (invalid_path, not_found,
    ## is_directory, too_large, read_failed). `data` holds the raw bytes —
    ## base64 happens at chunking time, never here.
    error*: string
    data*: string
    contentType*: string
    mtime*: BiggestInt

  CloudVerbContext* = ref object
    ## Everything handleCloudVerb needs, injected so tests can stub the side
    ## effects and assert on them.
    frameConfig*: FrameConfig
    scopes*: seq[string]
    scenesChecksum*: string
    ## Returns false when the runtime event queue was full and the event was
    ## dropped, so verbs that must not be acked optimistically can say so.
    sendEventFn*: proc(event: string, payload: JsonNode): bool {.gcsafe.}
    persistSettingsFn*: proc(payload: JsonNode) {.gcsafe.}
    # "Would persisting this payload change anything?" — the guard that lets
    # an idempotent set_settings redelivery be acked without a config reload
    # (which re-inits the scene and re-renders the panel). nil means "assume
    # yes", i.e. the old always-reload behaviour.
    settingsChangedFn*: proc(payload: JsonNode): bool {.gcsafe.}
    persistChecksumFn*: proc(checksum: string) {.gcsafe.}
    getLogsFn*: proc(): JsonNode {.gcsafe.}
    getMetricsFn*: proc(): JsonNode {.gcsafe.}
    getStateFn*: proc(): JsonNode {.gcsafe.}
    ## Returns {"assets": [{path,size,mtime,is_dir}…], "truncated": bool} with
    ## paths relative to the assets directory (docs/cloud-frames.md).
    listAssetsFn*: proc(): JsonNode {.gcsafe.}
    readAssetFn*: proc(path: string, thumb: bool): AssetReadResult {.gcsafe.}
    ## Write verbs. writeAssetFn returns the stored entry as
    ## {"path" (relative), "size", "mtime", "is_dir"}; all four raise
    ## ValueError for a path the guard refuses and OSError for a filesystem
    ## failure — the handlers translate those into wire errors.
    writeAssetFn*: proc(path: string, data: string): JsonNode {.gcsafe.}
    mkdirAssetFn*: proc(path: string) {.gcsafe.}
    deleteAssetFn*: proc(path: string) {.gcsafe.}
    renameAssetFn*: proc(src: string, dst: string) {.gcsafe.}
    ## The current rendered image for `image_get` (error "no_image" until the
    ## first render).
    getImageFn*: proc(): AssetReadResult {.gcsafe.}
    ## Accepts a `refresh_service_settings` nudge. The verb acks on ACCEPTANCE,
    ## never on completion: the fetch is an HTTPS request on the device's own
    ## schedule (see pullServiceSettings), and a failed fetch must not look
    ## like a refused verb.
    refreshServiceSettingsFn*: proc() {.gcsafe.}
    ## Accepts a `notify_update_available` nudge. Acks on ACCEPTANCE, like the
    ## service-settings refresh: the upgrade itself runs detached and reports
    ## through the upgrade status file and shipped logs, never through the
    ## ack. Must be idempotent — hub delivery is at-least-once.
    requestUpgradeFn*: proc() {.gcsafe.}
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
    let command = "(sleep 2; systemctl reboot || reboot) >/dev/null 2>&1 &"
    discard runShellCapture(privilegedCommand("sh -c " & shellQuote(command)), timeoutMs = 10_000)

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

proc hiddenAssetPath(relPath: string): bool =
  ## Dotfiles and dot-directories (".thumbs" above all) are local plumbing the
  ## admin panel does not list either — keep them off the wire.
  for component in relPath.split('/'):
    if component.len > 0 and component[0] == '.':
      return true
  false

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
      return AssetReadResult(
        error: if status == Http413: "too_large" else: "read_failed")
    if body.len > HubMaxAssetFileBytes:
      return AssetReadResult(error: "too_large")
    AssetReadResult(
      data: body,
      # Thumbnails are always the generated 320x320 JPEG; originals go by
      # extension (same table getAssetPayload uses for its own header).
      contentType: if thumb: "image/jpeg" else: contentTypeForFilePath(fullPath),
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

proc defaultCloudVerbContext*(frameConfig: FrameConfig, scopes: seq[string],
                              scenesChecksum: string): CloudVerbContext {.gcsafe.} =
  {.gcsafe.}:
    let config = frameConfig
    CloudVerbContext(
      frameConfig: frameConfig,
      scopes: scopes,
      scenesChecksum: scenesChecksum,
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

proc expectedUploadedSceneId(scenes: JsonNode, requestedSceneId = ""): string =
  ## updateUploadedScenesFromPayload prefixes every scene id with "uploaded/",
  ## and activates the payload's `sceneId` when it names one of the pushed
  ## scenes (the first scene otherwise) — mirror that choice here.
  if scenes.kind == JArray and scenes.len > 0 and scenes[0].kind == JObject:
    if requestedSceneId.len > 0:
      for scene in scenes:
        if scene.kind == JObject and scene{"id"}.getStr("") == requestedSceneId:
          return "uploaded/" & requestedSceneId
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
  let refused = refusedCloudAppKeyword(scenes)
  if refused.len > 0:
    ctx.audit("set_scenes", false, "app_not_allowed: " & refused)
    return CloudVerbReply(ack: ackError(id, "app_not_allowed"))
  # The workspace's "preview on frame" flow names which pushed scene to
  # activate and seeds its public state; the runtime's uploadScenes handler
  # honors both keys (runner.nim), so pass them through untouched.
  #
  # "source" is the runtime origin stamp: the DEVICE marks everything that
  # arrives over this verb as provider-pushed — never trusting a key inside
  # the payload — and updateUploadedScenesFromPayload persists it with the
  # scenes. It is what keeps the LAN deny up after a demotion and what the
  # load-time refused-app re-check keys on. Local admin uploads carry no
  # source and read back as "local".
  var eventPayload = %*{"scenes": scenes, "source": "cloud"}
  let requestedSceneId = msg{"scene_id"}.getStr("")
  if requestedSceneId.len > 0:
    eventPayload["sceneId"] = %requestedSceneId
  let state = msg{"state"}
  if state != nil and state.kind == JObject:
    eventPayload["state"] = copy(state)
  # Idempotency guard, mirroring set_settings: the checksum covers the whole
  # payload, so a redelivery of exactly what this frame already applied (the
  # "also push scenes & settings" tick with nothing changed, or at-least-once
  # redelivery after a reconnect) has nothing to do — re-uploading would
  # re-init the scene and re-render the panel for a no-op. Only skipped when
  # the message ALSO asks for no scene switch and carries no state seed;
  # either of those is new work even under an unchanged checksum. The ack and
  # scene_ack still go out — that is what reconciles the provider's sync row.
  if checksum.len > 0 and checksum == ctx.scenesChecksum and
      requestedSceneId.len == 0 and (state == nil or state.kind != JObject):
    ctx.audit("set_scenes", true)
    # The runtime was not touched, so report the scene it is ACTUALLY showing
    # — the payload's default would be a guess that goes wrong the moment the
    # user has switched scenes since the last real push.
    let currentActive =
      if ctx.getStateFn.isNil: expectedUploadedSceneId(scenes, requestedSceneId)
      else: ctx.getStateFn(){"active_scene"}.getStr(expectedUploadedSceneId(scenes, requestedSceneId))
    var unchangedAck = %*{"type": "scene_ack", "checksum": checksum,
                          "active_scene": currentActive}
    if id != nil and id.kind != JNull:
      unchangedAck["id"] = id
    return CloudVerbReply(ack: ackOk(id), extra: @[unchangedAck])
  if not ctx.sendEventFn("uploadScenes", eventPayload):
    # The runtime queue was full, so the deploy never happened. Acking ok here
    # (and persisting the checksum) would tell the provider the frame is up to
    # date forever; a retryable error makes it push again instead.
    ctx.audit("set_scenes", false, "queue_full")
    return CloudVerbReply(ack: ackError(id, "queue_full"))
  ctx.scenesChecksum = checksum
  if not ctx.persistChecksumFn.isNil:
    ctx.persistChecksumFn(checksum)
  ctx.audit("set_scenes", true)
  var sceneAck = %*{"type": "scene_ack", "checksum": checksum,
                    "active_scene": expectedUploadedSceneId(scenes, requestedSceneId)}
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
    # Idempotency guard: every "push scenes & settings" click redelivers the
    # full settings object, and reloading the config re-inits the active scene
    # and re-renders the panel — an e-ink flash plus a page of reload/render
    # log lines for a write that changed nothing. Values already in effect are
    # acked without touching disk or the runtime.
    let changed = ctx.settingsChangedFn.isNil or ctx.settingsChangedFn(payload)
    if changed:
      try:
        ctx.persistSettingsFn(payload)
      except CatchableError as error:
        ctx.audit("set_settings", false, "persist_failed: " & error.msg)
        return CloudVerbReply(ack: ackError(id, "persist_failed"))
      discard ctx.sendEventFn("reload", %*{})
  ctx.audit("set_settings", true)
  CloudVerbReply(ack: ackOk(id))

proc handleRefreshServiceSettings(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  ## Advisory nudge: "your service settings changed, re-fetch them". The
  ## payload is always empty — API keys never ride the command queue
  ## (docs/cloud-frames.md, "Service settings"), and nothing in this handler
  ## reads one. Set_settings and this verb are disjoint paths: the six
  ## service-settings groups are NOT in CLOUD_SETTINGS_ALLOWLIST and never
  ## become settable over the socket.
  if not ctx.hasScope(ServiceSettingsScope):
    # The provider's 403 on the fetch is the real revocation boundary, but a
    # device that knows it was never granted the scope says so up front.
    ctx.audit("refresh_service_settings", false, "insufficient_scope")
    return CloudVerbReply(ack: ackError(id, "insufficient_scope"))
  if ctx.refreshServiceSettingsFn.isNil:
    ctx.audit("refresh_service_settings", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  # Ack on ACCEPTING the nudge, not on completing the fetch: the fetch is HTTP
  # on our own schedule, and a failed fetch must not look like a refused verb.
  ctx.refreshServiceSettingsFn()
  ctx.audit("refresh_service_settings", true)
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
  discard ctx.sendEventFn("reload", %*{})
  ctx.audit("set_schedule", true)
  CloudVerbReply(ack: ackOk(id))

proc handleSetCurrentScene(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  let sceneId = msg{"scene_id"}.getStr("")
  if sceneId.len == 0:
    ctx.audit("set_current_scene", false, "invalid_scene_id")
    return CloudVerbReply(ack: ackError(id, "invalid_scene_id"))
  var payload = %*{"sceneId": sceneId}
  # Optional public scene-state values, same shape the local setCurrentScene
  # event carries (docs/cloud-frames.md).
  let state = msg{"state"}
  if state != nil and state.kind == JObject:
    payload["state"] = copy(state)
  discard ctx.sendEventFn("setCurrentScene", payload)
  ctx.audit("set_current_scene", true)
  CloudVerbReply(ack: ackOk(id))

proc handleAssetsList(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  if ctx.listAssetsFn.isNil:
    ctx.audit("assets_list", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  let listing =
    try:
      ctx.listAssetsFn()
    except CatchableError as error:
      ctx.audit("assets_list", false, "read_failed: " & error.msg)
      return CloudVerbReply(ack: ackError(id, "read_failed"))
  var reply = %*{"type": "assets"}
  if id != nil and id.kind != JNull:
    reply["id"] = id
  reply["assets"] =
    if listing != nil and listing.kind == JObject and listing{"assets"} != nil:
      listing["assets"]
    else:
      newJArray()
  if listing != nil and listing.kind == JObject and listing{"truncated"}.getBool(false):
    reply["truncated"] = %true
  ctx.audit("assets_list", true)
  CloudVerbReply(ack: ackOk(id), extra: @[reply])

proc assetChunkExtras(id: JsonNode, asset: AssetReadResult): seq[JsonNode] =
  ## The full payload is in memory and validated: every chunk below will
  ## exist, so the ok-ack the wire contract sends before the stream is
  ## honest. Chunks are independently base64-decodable; the provider
  ## concatenates the raw bytes. Shared by asset_get and image_get.
  result = @[]
  var seqNumber = 0
  var offset = 0
  let total = asset.data.len
  while true:
    let chunkLen = min(HubAssetChunkRawBytes, total - offset)
    let done = offset + chunkLen >= total
    var chunk = %*{
      "type": "asset_chunk",
      "seq": seqNumber,
      "data": encode(asset.data[offset ..< offset + chunkLen]),
      "done": done,
    }
    if id != nil and id.kind != JNull:
      chunk["id"] = id
    if seqNumber == 0:
      chunk["size"] = %total
      chunk["mtime"] = %asset.mtime
      chunk["content_type"] = %asset.contentType
    result.add(chunk)
    offset += chunkLen
    inc seqNumber
    if done:
      break

proc handleAssetGet(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.readAssetFn.isNil:
    ctx.audit("asset_get", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  let path = msg{"path"}.getStr("")
  if path.len == 0:
    ctx.audit("asset_get", false, "invalid_path")
    return CloudVerbReply(ack: ackError(id, "invalid_path"))
  let thumb = msg{"thumb"}.getBool(false)
  let asset =
    try:
      ctx.readAssetFn(path, thumb)
    except CatchableError as error:
      ctx.audit("asset_get", false, "read_failed: " & error.msg)
      return CloudVerbReply(ack: ackError(id, "read_failed"))
  if asset.error.len > 0:
    ctx.audit("asset_get", false, asset.error)
    return CloudVerbReply(ack: ackError(id, asset.error))
  ctx.audit("asset_get", true)
  CloudVerbReply(ack: ackOk(id), extra: assetChunkExtras(id, asset))

proc handleImageGet(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  if ctx.getImageFn.isNil:
    ctx.audit("image_get", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  let image =
    try:
      ctx.getImageFn()
    except CatchableError:
      AssetReadResult(error: "no_image")
  if image.error.len > 0:
    ctx.audit("image_get", false, image.error)
    return CloudVerbReply(ack: ackError(id, image.error))
  ctx.audit("image_get", true)
  CloudVerbReply(ack: ackOk(id), extra: assetChunkExtras(id, image))

proc assetWriteError(error: ref CatchableError): string =
  ## The write helpers raise ValueError for guard refusals and OSError for
  ## filesystem trouble; "Asset not found" is the one OSError worth naming.
  if error of ValueError:
    "invalid_path"
  elif error.msg == "Asset not found":
    "not_found"
  else:
    "write_failed"

proc refusedWritePath(path: string): bool =
  ## Writes never touch dot-directories: `.thumbs` and `.frameos` (scene
  ## snapshots) are the device's own plumbing. asset_get deliberately CAN
  ## read them (that is how the provider fetches scene snapshots), but a
  ## provider must not be able to plant or destroy files there.
  hiddenAssetPath(path.strip())

proc handleAssetPut(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.writeAssetFn.isNil:
    ctx.audit("asset_put", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  let path = msg{"path"}.getStr("")
  if path.len == 0 or refusedWritePath(path):
    ctx.audit("asset_put", false, "invalid_path")
    return CloudVerbReply(ack: ackError(id, "invalid_path"))
  let encoded = msg{"data"}.getStr("")
  var data: string
  try:
    data = decode(encoded)
  except CatchableError:
    ctx.audit("asset_put", false, "invalid_data")
    return CloudVerbReply(ack: ackError(id, "invalid_data"))
  if data.len == 0:
    ctx.audit("asset_put", false, "invalid_data")
    return CloudVerbReply(ack: ackError(id, "invalid_data"))
  if data.len > HubMaxAssetUploadBytes:
    ctx.audit("asset_put", false, "too_large")
    return CloudVerbReply(ack: ackError(id, "too_large"))
  try:
    let stored = ctx.writeAssetFn(path, data)
    ctx.audit("asset_put", true)
    var ack = ackOk(id)
    ack["asset"] = stored
    CloudVerbReply(ack: ack)
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.audit("asset_put", false, wireError)
    CloudVerbReply(ack: ackError(id, wireError))

proc handleAssetMkdir(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.mkdirAssetFn.isNil:
    ctx.audit("asset_mkdir", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  let path = msg{"path"}.getStr("")
  if path.len == 0 or refusedWritePath(path):
    ctx.audit("asset_mkdir", false, "invalid_path")
    return CloudVerbReply(ack: ackError(id, "invalid_path"))
  try:
    ctx.mkdirAssetFn(path)
    ctx.audit("asset_mkdir", true)
    CloudVerbReply(ack: ackOk(id))
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.audit("asset_mkdir", false, wireError)
    CloudVerbReply(ack: ackError(id, wireError))

proc handleAssetDelete(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.deleteAssetFn.isNil:
    ctx.audit("asset_delete", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  let path = msg{"path"}.getStr("")
  if path.len == 0 or refusedWritePath(path):
    ctx.audit("asset_delete", false, "invalid_path")
    return CloudVerbReply(ack: ackError(id, "invalid_path"))
  try:
    ctx.deleteAssetFn(path)
    ctx.audit("asset_delete", true)
    CloudVerbReply(ack: ackOk(id))
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.audit("asset_delete", false, wireError)
    CloudVerbReply(ack: ackError(id, wireError))

proc handleAssetRename(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.renameAssetFn.isNil:
    ctx.audit("asset_rename", false, "unsupported_verb")
    return CloudVerbReply(ack: ackError(id, "unsupported_verb"))
  let src = msg{"src"}.getStr("")
  let dst = msg{"dst"}.getStr("")
  if src.len == 0 or dst.len == 0 or refusedWritePath(src) or refusedWritePath(dst):
    ctx.audit("asset_rename", false, "invalid_path")
    return CloudVerbReply(ack: ackError(id, "invalid_path"))
  try:
    ctx.renameAssetFn(src, dst)
    ctx.audit("asset_rename", true)
    CloudVerbReply(ack: ackOk(id))
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.audit("asset_rename", false, wireError)
    CloudVerbReply(ack: ackError(id, wireError))

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
  of "refresh_service_settings":
    result = handleRefreshServiceSettings(ctx, id)
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
  of "assets_list":
    result = handleAssetsList(ctx, id)
  of "asset_get":
    result = handleAssetGet(ctx, id, msg)
  of "asset_put":
    result = handleAssetPut(ctx, id, msg)
  of "asset_mkdir":
    result = handleAssetMkdir(ctx, id, msg)
  of "asset_delete":
    result = handleAssetDelete(ctx, id, msg)
  of "asset_rename":
    result = handleAssetRename(ctx, id, msg)
  of "image_get":
    result = handleImageGet(ctx, id)
  of "render":
    discard ctx.sendEventFn("render", %*{})
    result = CloudVerbReply(ack: ackOk(id))
  of "reboot":
    ctx.audit("reboot", true)
    result = CloudVerbReply(ack: ackOk(id))
    # Delayed so the ack still flushes before the device goes down.
    ctx.rebootFn()
  of "restart_runtime":
    ctx.audit("restart_runtime", true)
    result = CloudVerbReply(ack: ackOk(id))
    discard ctx.sendEventFn("restart", %*{})
  of "notify_update_available":
    # The provider supplies no URLs and no binaries — this nudges the device
    # to run its own signed upgrade flow (frameos/upgrade.nim), which fetches
    # release metadata from its configured archive and verifies signatures
    # itself; nothing here would fetch a URL if the payload smuggled one in.
    # The ack means the nudge was accepted, not that an upgrade happened:
    # requestUpgradeFn refuses repeats while one is in flight and resolves to
    # up_to_date on a current install, so at-least-once redelivery is safe.
    ctx.audit("notify_update_available", true)
    # The provider is not required to name a version — the device resolves the
    # latest release itself — and logging `"version": ""` only made the line
    # look broken. Report what this device is on instead; the target shows up
    # in the cloud:upgrade lines the watcher forwards.
    var notice = %*{"event": "cloud:updateAvailable",
                    "installed": installedFrameOSVersion()}
    let offeredVersion = msg{"version"}.getStr("")
    if offeredVersion.len > 0:
      notice["version"] = %offeredVersion
    log(notice)
    result = CloudVerbReply(ack: ackOk(id))
    ctx.requestUpgradeFn()
  else:
    let label = if verb.len > 0: verb else: "(missing type)"
    ctx.audit(label, false, "unknown_verb")
    result = CloudVerbReply(ack: ackError(id, "unknown_verb"))

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
  var logsGranted = "telemetry:logs" in link.scopes
  var metricsGranted = "telemetry:metrics" in link.scopes
  let metricsInterval = max(frameConfig.metricsInterval, 5.0)
  let idleTimeout = hubIdleTimeoutSeconds()
  let pingInterval = min(HubPingIntervalSeconds, idleTimeout / 3)
  result = sessionDisconnected
  try:
    let ready = await runHandshake(socket, ctx)
    log(%*{"event": "cloud:hub:connected", "provider": link.providerUrl})
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
      if metricsGranted and now - lastMetricsSentAt >= metricsInterval:
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
        if sceneId.string != lastActiveScene:
          lastActiveScene = sceneId.string
          var stateMessage = helloStatePayload(frameConfig, ctx.scenesChecksum)
          stateMessage["type"] = %"state"
          await socket.send($stateMessage)
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
