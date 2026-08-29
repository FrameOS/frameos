## The cloud verb layer: one provider→frame message in, the replies out.
##
## Transport-free on purpose. This module knows the wire contract of
## docs/cloud-frames.md — the verb table, the scope checks, the settings
## allowlist and value rules, the asset path rules, the ack and reply shapes —
## and nothing about how a message arrived. The Linux runtime feeds it from
## the WebSocket thread in cloud/hub_client.nim; the ESP32 firmware feeds it
## from its C WebSocket client through src/embedded/embedded_cloud.nim. Every
## side effect (persisting settings, hot-loading scenes, reading an asset,
## rebooting) is a callback on `CloudVerbContext`, so the two platforms share
## the whole verb layer and differ only in what those callbacks do.
##
## The restricted profile is structural: this module implements the complete
## verb list from the wire spec and nothing else. There is no shell verb, no
## arbitrary file read/write verb, no SSH anything, no compiled-scene deploy —
## the code for those capabilities simply does not exist here, so no
## provider-side compromise or configuration flag can reach them. The only
## file access is the asset verb family (`assets_list`/`asset_get` plus the
## write verbs `asset_put`/`asset_put_chunk`/`asset_mkdir`/`asset_delete`/
## `asset_rename`): resolved and bounded on-device inside the assets directory
## by the platform's callbacks, with writes additionally refused for
## dot-directories (`.frameos`, `.thumbs` — the device's own plumbing).
## Anything outside the verb table is answered with `unknown_verb` and
## audit-logged through the normal log pipeline (`cloud:audit`).
##
## Must compile under -d:frameosEmbedded (Xtensa, --threads:off, no OS):
## stdlib json/base64/strutils, the interpreter's payload parser and the
## scene guard only. No sockets, no files, no processes.

import base64
import json
import strutils

import frameos/channels
import frameos/interpreter
import frameos/js_runtime/app_runtime
import frameos/types
when not defined(frameosEmbedded):
  # The apps this guard refuses (a child-process Chromium, ffmpeg) are not in
  # the firmware's catalog at all, so the walk is Linux-only. Tests and other
  # importers keep reaching CLOUD_REFUSED_APP_KEYWORDS / refusedCloudAppKeyword
  # through this module.
  import ./scene_guard
  export scene_guard

const
  # The scope that gates `refresh_service_settings` (docs/cloud-frames.md,
  # "Service settings"). Defined here, not in service_settings.nim, because
  # the verb layer must not import the HTTPS fetcher.
  ServiceSettingsScope* = "settings:services"
  HubGetLogsDefaultLimit = 200
  HubGetLogsMaxLimit = 1000
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
  # `asset_put` rides a single inbound frame, so the raw payload must survive
  # base64 inflation plus envelope inside HubMaxInboundBytes. 2.5 MiB raw ≈
  # 3.4 MiB encoded. Bigger files ride `asset_put_chunk` (below), one chunk of
  # at most this size per frame.
  HubMaxAssetUploadBytes* = 2_621_440
  # `asset_put_chunk` assembles a file across frames, so its ceiling is a disk
  # question, not a frame-size one. 64 MiB covers the biggest bundled font
  # (NotoColorEmoji, 10.7 MB) several times over and any photo a scene would
  # want; a video that needs more belongs on the card, not on the socket.
  HubMaxChunkedUploadBytes* = 64 * 1024 * 1024
  # upload_id is a filename component on the device: [A-Za-z0-9_-], bounded.
  HubMaxUploadIdLen* = 64

# Declarative settings a provider may push; every key maps onto an existing
# frame.json field through the same persist path the local admin uses. Must
# stay in sync with docs/cloud-frames.md (`set_settings`), allowedFrameSettings
# in cloud/apps/auth-web/src/lib/frames.ts and the SPA's
# frontend/src/utils/cloudFrameSettings.ts.
#
# Three tiers, one list. The first six shipped with the cloud link and every
# managed frame understands them. The next seven arrived in 2026.8.30 and the
# hardware batch (palette, the partial-refresh subset of deviceConfig, GPIO
# buttons) in 2026.8.31 — a provider gates each tier on the frame's reported
# `frameos_version`, because a frame on older firmware refuses the WHOLE verb
# on a key it does not know (see handleSetSettings): one new key in the push
# would take `name` and `interval` down with it. Structured values are
# shape-checked below (validateCloudSetting) before they reach the persist
# path — the allowlist says which keys, the validators say which values, and
# the provider's own validation is UX, not the boundary.
const CLOUD_SETTINGS_ALLOWLIST* = [
  "name", "rotate", "interval", "scaling_mode", "timezone", "debug",
  "flip", "error_behavior", "control_code", "metrics_interval",
  "max_http_response_bytes", "save_assets", "timezone_updater",
  "palette", "device_config", "gpio_buttons",
]

# The ESP32 firmware's profile of the same verb (docs/cloud-frames.md "Device
# profiles"; esp32SettableKeys in cloud/apps/auth-web/src/lib/frames.ts): the
# keys that map onto fos_config (NVS), and no other. `flip`, `error_behavior`,
# `palette` and the rest have no consumer on the chip, so a push naming one
# refuses the whole verb — same rule, different list. The power keys and
# `timezone_data` (the zone's tzdata slice, which the chip needs because it
# carries no tz database) exist only here.
const CLOUD_SETTINGS_ALLOWLIST_ESP32* = [
  "name", "rotate", "interval", "scaling_mode", "timezone", "timezone_data",
  "debug", "max_http_response_bytes", "gpio_buttons",
  "deep_sleep", "deep_sleep_on_battery", "wake_check_seconds",
  "battery_pin", "battery_divider", "battery_enable_pin",
]

# The display drivers copy these three into their own context at init
# (drivers/drivers.nim): a palette, a partial-refresh policy or a button map
# only takes effect on the next start. A push carrying one of them restarts
# the runtime after persisting instead of reloading it — the process comes
# straight back (systemd), the panel re-inits with the new values.
const CLOUD_SETTINGS_RESTART_KEYS* = ["palette", "device_config", "gpio_buttons"]

# Ceilings for the numeric extended settings. maxHttpResponseBytes is a
# per-request memory bound on a Pi Zero as much as a policy knob, so the
# provider cannot lift it past what the platform's default already allows.
const
  CloudMaxHttpResponseBytesFloor* = 64 * 1024
  CloudMaxHttpResponseBytesCeiling* = DefaultMaxHttpResponseBytes
  CloudMetricsIntervalCeilingSeconds* = 24 * 60 * 60.0
  CloudErrorRetryCeilingSeconds* = 24 * 60 * 60.0
  CloudErrorWindowCeilingMinutes* = 7 * 24 * 60.0
  # A saveAssets object names apps by keyword; keep it small and simple.
  CloudSaveAssetsMaxEntries* = 64
  # Palettes are the panel's ink count (6 for Spectra, 7 for ACeP); 16 leaves
  # room without letting a provider ship a lookup table.
  CloudPaletteMaxColors* = 16
  # BCM 0..27 on a Pi header, up to 48 on the ESP32 boards; the driver
  # refuses (and logs) a line it cannot open, it never crashes on one.
  CloudGpioButtonMaxPin* = 48
  CloudGpioButtonsMax* = 16
  CloudPartialRefreshMaxRefreshes* = 1000
  # ESP32 power keys (fos_config.h): a wake check-in period of a day at most,
  # an ADC GPIO (-1 = no battery sense) and the voltage divider ratio. The
  # firmware clamps a sub-minute check-in to 60 s itself.
  CloudWakeCheckCeilingSeconds* = 24 * 60 * 60
  CloudBatteryPinMax* = 48
  CloudBatteryDividerMin* = 0.5
  CloudBatteryDividerMax* = 20.0

type
  AssetReadResult* = object
    ## One asset read for `asset_get`. `error` is empty on success and one of
    ## the wire contract's per-verb errors otherwise (invalid_path, not_found,
    ## is_directory, too_large, read_failed). `data` holds the raw bytes —
    ## base64 happens at chunking time, never here. `detail` never reaches the
    ## provider: the wire carries the fixed code, the frame's own log carries
    ## why — without it a failed thumbnail and an unreadable file are the same
    ## word, `read_failed`, and neither says which.
    error*: string
    detail*: string
    data*: string
    contentType*: string
    mtime*: BiggestInt
    ## The platform validated the request and will emit the `asset_chunk`
    ## frames itself, straight off its storage, after the ack (the ESP32
    ## streams a file from the SD card in 24 KiB pieces rather than holding
    ## an 8 MiB read in PSRAM). `data` is empty; the handler acks and adds no
    ## chunks of its own.
    streamed*: bool

  CloudVerbContext* = ref object
    ## Everything handleCloudVerb needs, injected so tests can stub the side
    ## effects and assert on them — and so the ESP32 firmware can supply its
    ## own (src/embedded/embedded_cloud.nim) without a second verb layer.
    frameConfig*: FrameConfig
    scopes*: seq[string]
    scenesChecksum*: string
    ## The `frameos_version` this device runs, for log lines that name it.
    installedVersion*: string
    ## Which `set_settings` keys this device honours: CLOUD_SETTINGS_ALLOWLIST
    ## (the default when empty) on the Linux runtime,
    ## CLOUD_SETTINGS_ALLOWLIST_ESP32 on the firmware.
    settingsAllowlist*: seq[string]
    ## A self-hosted FrameOS backend owns this device's content (docs/
    ## cloud-frames.md "one control plane owns the content"): the content
    ## verbs — set_scenes, set_current_scene, set_settings, set_schedule,
    ## refresh_service_settings — are refused `backend_managed` so a
    ## provider's stale assignment never overwrites the backend's on every
    ## reconnect. Telemetry, assets and OTA still work. Only the ESP32 can be
    ## in this state (enrollment on Linux refuses while a backend is set).
    backendManaged*: bool
    ## The platform hot-loads a pushed `set_scenes` payload asynchronously and
    ## sends `scene_ack` itself once the payload is live — the ESP32 render
    ## task loads it from flash on its next pass, minutes later on a sleeping
    ## frame. set_scenes then acks acceptance only; the checksum is the
    ## platform's to persist when the load succeeds (persistChecksumFn is not
    ## called). The unchanged-payload shortcut still answers scene_ack at
    ## once — nothing is loaded in that case.
    deferredSceneAck*: bool
    ## Returns false when the runtime event queue was full and the event was
    ## dropped, so verbs that must not be acked optimistically can say so.
    sendEventFn*: proc(event: string, payload: JsonNode): bool {.gcsafe.}
    ## Stores a validated `set_scenes` payload — {"scenes", "source",
    ## "checksum"?, "sceneId"?, "state"?} — and returns "" or the wire error
    ## to ack (`scene_store_failed`, `no_memory`, …). nil hands the payload to
    ## the runtime as an `uploadScenes` event through sendEventFn instead (the
    ## Linux runner hot-loads it from there), a full queue reading as
    ## `queue_full`. The firmware sets this: it writes the payload to flash
    ## and knows synchronously whether that worked.
    applyScenesFn*: proc(payload: JsonNode): string {.gcsafe.}
    persistSettingsFn*: proc(payload: JsonNode) {.gcsafe.}
    # "Would persisting this payload change anything?" — the guard that lets
    # an idempotent set_settings redelivery be acked without a config reload
    # (which re-inits the scene and re-renders the panel). nil means "assume
    # yes", i.e. the old always-reload behaviour.
    settingsChangedFn*: proc(payload: JsonNode): bool {.gcsafe.}
    ## Keeps the OS clock in step with a pushed `timezone` (Linux writes
    ## /etc/localtime; the firmware's persist path installs the zone itself,
    ## so it leaves this nil).
    applyTimeZoneFn*: proc(timeZone: string) {.gcsafe.}
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
    ## `asset_put_chunk`: write `data` at `offset` into the part named by
    ## `uploadId`; with a non-empty `finalPath` also move the finished part
    ## there and return the stored entry (like writeAssetFn), otherwise
    ## return {"received": <part size>}. Raises ValueError("chunk_gap") when
    ## `offset` is past what has landed, ValueError for a guard refusal and
    ## OSError for filesystem trouble.
    putAssetChunkFn*: proc(uploadId: string, offset: BiggestInt, data: string,
                           finalPath: string): JsonNode {.gcsafe.}
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
    #
    # Not on the firmware: parsing every scene of the push builds all of them
    # in PSRAM at once, on a board that otherwise keeps exactly one scene
    # resident (the rest stay on flash until selected). The ESP32 loader
    # parses the payload scene by scene when the render task applies it and
    # a payload it cannot load simply never gets its scene_ack — the provider
    # sees "out of sync", which is the truth.
    when not defined(frameosEmbedded):
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

proc refuse(ctx: CloudVerbContext, verb: string, id: JsonNode, error: string,
            detail = ""): CloudVerbReply =
  ## One refusal: the audit line (with the detail, which never reaches the
  ## wire) and the error ack. Every refusal in this module goes through here —
  ## a single call per site is what keeps the layer small on the firmware.
  ctx.audit(verb, false, if detail.len > 0: error & ": " & detail else: error)
  CloudVerbReply(ack: ackError(id, error))

proc hasScope(ctx: CloudVerbContext, scope: string): bool =
  scope in ctx.scopes

proc refuseBackendManaged(ctx: CloudVerbContext, verb: string, id: JsonNode): CloudVerbReply =
  ## The `backend_managed` refusal for a content verb (see backendManaged).
  ctx.refuse(verb, id, "backend_managed")

proc handleSetScenes(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.backendManaged:
    return refuseBackendManaged(ctx, "set_scenes", id)
  let scenes = msg{"scenes"}
  let checksum = msg{"checksum"}.getStr("")
  let (ok, error) = validateInterpretedScenesPayload(scenes)
  if not ok:
    return ctx.refuse("set_scenes", id, error)
  let refused = when defined(frameosEmbedded): "" else: refusedCloudAppKeyword(scenes)
  if refused.len > 0:
    return ctx.refuse("set_scenes", id, "app_not_allowed", refused)
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
  #
  # "checksum" rides along for a platform that acks the load itself
  # (deferredSceneAck): it is what its scene_ack must carry. The Linux runner
  # reads only the keys it knows and ignores it.
  var eventPayload = %*{"scenes": scenes, "source": "cloud"}
  if checksum.len > 0:
    eventPayload["checksum"] = %checksum
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
  let applyError =
    if not ctx.applyScenesFn.isNil: ctx.applyScenesFn(eventPayload)
    elif ctx.sendEventFn("uploadScenes", eventPayload): ""
    # The runtime queue was full, so the deploy never happened. Acking ok here
    # (and persisting the checksum) would tell the provider the frame is up to
    # date forever; a retryable error makes it push again instead.
    else: "queue_full"
  if applyError.len > 0:
    return ctx.refuse("set_scenes", id, applyError)
  ctx.audit("set_scenes", true)
  if ctx.deferredSceneAck:
    # Accepted, not yet live: the platform reports (and remembers) the
    # checksum once the payload actually loads.
    return CloudVerbReply(ack: ackOk(id))
  ctx.scenesChecksum = checksum
  if not ctx.persistChecksumFn.isNil:
    ctx.persistChecksumFn(checksum)
  var sceneAck = %*{"type": "scene_ack", "checksum": checksum,
                    "active_scene": expectedUploadedSceneId(scenes, requestedSceneId)}
  if id != nil and id.kind != JNull:
    sceneAck["id"] = id
  CloudVerbReply(ack: ackOk(id), extra: @[sceneAck])

# ---------------------------------------------------------------------------
# set_settings value validation
# ---------------------------------------------------------------------------

proc isJsonNumber(node: JsonNode): bool =
  node != nil and node.kind in {JInt, JFloat}

proc numberInRange(node: JsonNode, low, high: float): bool =
  isJsonNumber(node) and node.getFloat() >= low and node.getFloat() <= high

proc intInRange(node: JsonNode, low, high: int): bool =
  node != nil and node.kind == JInt and node.getInt() >= low and node.getInt() <= high

proc onlyKeys(node: JsonNode, allowed: openArray[string]): bool =
  ## Object shape guard: every key present must be one of `allowed`. An
  ## unknown sub-key is refused for the same reason an unknown top-level key
  ## is — the provider does not get to invent fields the runtime never
  ## validated, even inside an object it is allowed to set.
  if node == nil or node.kind != JObject:
    return false
  for key in node.keys:
    if key notin allowed:
      return false
  true

when not defined(frameosEmbedded):
  proc isHtmlHexColor(node: JsonNode): bool =
    ## "#rrggbb" only — the one spelling every producer of these values (the
    ## SPA's ColorInput, the backend's frame.json writer) uses, and the one
    ## loadControlCode's parseHtmlColor cannot choke on.
    if node == nil or node.kind != JString:
      return false
    let value = node.getStr("")
    if value.len != 7 or value[0] != '#':
      return false
    for ch in value[1 .. ^1]:
      if ch notin {'0'..'9', 'a'..'f', 'A'..'F'}:
        return false
    true

  proc validateLinuxSetting(key: string, value: JsonNode): bool =
    ## The keys only the Linux runtime honours (CLOUD_SETTINGS_ALLOWLIST minus
    ## CLOUD_SETTINGS_ALLOWLIST_ESP32). Not compiled into the firmware: its
    ## allowlist refuses these keys before any validator runs, and on a chip
    ## at 90% of its flash slot unreachable code is not free.
    case key
    of "flip":
      value.kind == JString and value.getStr("") in ["", "horizontal", "vertical", "both"]
    of "error_behavior":
      # The frontend/backend spelling; frontendErrorBehaviorToRuntime maps it
      # onto errorBehavior in frame.json.
      if not onlyKeys(value, ["mode", "retry_seconds", "silent_retry_seconds",
                              "silent_retry_forever", "silent_window_minutes",
                              "show_error_retry_seconds"]):
        return false
      for subKey in value.keys:
        let ok = case subKey
          of "mode":
            value[subKey].kind == JString and
              value[subKey].getStr("") in ["safe_mode", "show_error_retry", "silent_retry"]
          of "silent_retry_forever":
            value[subKey].kind == JBool
          of "silent_window_minutes":
            numberInRange(value[subKey], 1, CloudErrorWindowCeilingMinutes)
          else:
            numberInRange(value[subKey], 1, CloudErrorRetryCeilingSeconds)
        if not ok:
          return false
      true
    of "control_code":
      # The runtime's controlCode shape (loadControlCode): a bool `enabled`,
      # numbers, and #rrggbb colours — not the SPA form's string spellings.
      if not onlyKeys(value, ["enabled", "position", "size", "padding",
                              "offsetX", "offsetY", "qrCodeColor", "backgroundColor"]):
        return false
      for subKey in value.keys:
        let ok = case subKey
          of "enabled": value[subKey].kind == JBool
          of "position":
            value[subKey].kind == JString and value[subKey].getStr("") in
              ["top-left", "top-right", "bottom-left", "bottom-right", "center"]
          of "size": numberInRange(value[subKey], 1, 50)
          of "padding": intInRange(value[subKey], 0, 50)
          of "offsetX", "offsetY": intInRange(value[subKey], -4096, 4096)
          else: isHtmlHexColor(value[subKey])
        if not ok:
          return false
      true
    of "metrics_interval":
      # 0 disables the sampler (metrics.nim); anything else is a period.
      numberInRange(value, 0, CloudMetricsIntervalCeilingSeconds)
    of "save_assets":
      # A single switch, or a per-app-keyword map of switches.
      if value.kind == JBool:
        return true
      if value.kind != JObject or value.len > CloudSaveAssetsMaxEntries:
        return false
      for appKey in value.keys:
        if appKey.len == 0 or appKey.len > 64 or value[appKey].kind != JBool:
          return false
      true
    of "timezone_updater":
      # enabled/hour only. The download URL is deliberately NOT accepted from a
      # provider: the endpoint stays the FrameOS-owned default (or whatever the
      # local admin set) — see handleSetSettings for how it is carried over.
      if not onlyKeys(value, ["enabled", "hour"]):
        return false
      for subKey in value.keys:
        let ok = case subKey
          of "enabled": value[subKey].kind == JBool
          else: intInRange(value[subKey], 0, 23)
        if not ok:
          return false
      true
    of "palette":
      # The SPA's Palette shape (frame.json `palette`): "#rrggbb" colours plus
      # the optional display name and per-colour names. An empty colour list is
      # a valid value — it hands the panel back its built-in palette.
      if not onlyKeys(value, ["name", "colors", "colorNames"]):
        return false
      let colors = value{"colors"}
      if colors == nil or colors.kind != JArray or colors.len > CloudPaletteMaxColors:
        return false
      for color in colors.items:
        if not isHtmlHexColor(color):
          return false
      if value.hasKey("name") and not (value["name"].kind == JString and value["name"].getStr("").len <= 64):
        return false
      if value.hasKey("colorNames"):
        let names = value["colorNames"]
        if names.kind != JArray or names.len != colors.len:
          return false
        for name in names.items:
          if name.kind != JString or name.getStr("").len > 32:
            return false
      true
    of "device_config":
      # STRICTLY the partial-refresh policy. Everything else in deviceConfig is
      # hardware wiring (VCOM, pins, upload URL and headers, SD card, render
      # mode) and stays the device's own — the persist path patches, so what
      # is not sent is not touched.
      if not onlyKeys(value, ["partial", "partialMaxAreaPercent", "partialMaxRefreshesBeforeFull"]):
        return false
      if value.len == 0:
        return false
      for subKey in value.keys:
        let ok = case subKey
          of "partial": value[subKey].kind == JBool
          of "partialMaxAreaPercent": numberInRange(value[subKey], 0, 100)
          else: intInRange(value[subKey], 0, CloudPartialRefreshMaxRefreshes)
        if not ok:
          return false
      true
    else:
      false

proc validateCloudSetting*(key: string, value: JsonNode): bool =
  ## Is `value` an acceptable value for allowlisted setting `key`? The device
  ## is the security boundary, so every key on CLOUD_SETTINGS_ALLOWLIST has a
  ## rule here — including the original six, whose provider-side validators
  ## these mirror. Anything this rejects fails the WHOLE verb with
  ## `invalid_settings` (docs/cloud-frames.md).
  if value == nil:
    return false
  case key
  of "name":
    value.kind == JString and value.getStr("").len in 1 .. 256
  of "rotate":
    value.kind == JInt and value.getInt() in [0, 90, 180, 270]
  of "interval":
    numberInRange(value, 1, 24 * 60 * 60)
  of "scaling_mode":
    value.kind == JString and value.getStr("") in ["contain", "cover", "stretch", "center"]
  of "timezone":
    value.kind == JString and value.getStr("").len <= 64
  of "timezone_data":
    # The zone's tzdata slice for the ESP32 (fos_tz.h): an object in the
    # generator's {timezones, dstChanges} shape, or null for "fetch it
    # yourself". Only meaningful next to `timezone` — handleSetSettings
    # refuses it on its own.
    value.kind in {JObject, JNull}
  of "debug", "deep_sleep", "deep_sleep_on_battery":
    value.kind == JBool
  of "wake_check_seconds":
    intInRange(value, 0, CloudWakeCheckCeilingSeconds)
  of "battery_pin", "battery_enable_pin":
    intInRange(value, -1, CloudBatteryPinMax)
  of "battery_divider":
    numberInRange(value, CloudBatteryDividerMin, CloudBatteryDividerMax)
  of "max_http_response_bytes":
    intInRange(value, CloudMaxHttpResponseBytesFloor, CloudMaxHttpResponseBytesCeiling)
  of "gpio_buttons":
    # [{pin, label}] — the whole list, replaced. An empty list unbinds every
    # button; a pin appearing twice is refused (the driver would register
    # the line twice).
    if value.kind != JArray or value.len > CloudGpioButtonsMax:
      return false
    var seenPins: seq[int] = @[]
    for button in value.items:
      if not onlyKeys(button, ["pin", "label"]):
        return false
      if not intInRange(button{"pin"}, 0, CloudGpioButtonMaxPin):
        return false
      let label = button{"label"}
      if label == nil or label.kind != JString or label.getStr("").strip().len notin 1 .. 32:
        return false
      if button["pin"].getInt() in seenPins:
        return false
      seenPins.add(button["pin"].getInt())
    true
  else:
    when defined(frameosEmbedded):
      false
    else:
      validateLinuxSetting(key, value)

proc settingsAllowlist(ctx: CloudVerbContext): seq[string] =
  if ctx.settingsAllowlist.len > 0: ctx.settingsAllowlist
  else: @CLOUD_SETTINGS_ALLOWLIST

proc handleSetSettings(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.backendManaged:
    return refuseBackendManaged(ctx, "set_settings", id)
  let settings = msg{"settings"}
  if settings == nil or settings.kind != JObject:
    return ctx.refuse("set_settings", id, "invalid_settings")
  # One unknown key refuses the whole verb: the allowlist is the contract, and
  # partial application would leave provider and frame disagreeing about what
  # got set. One bad VALUE refuses it too, for the same reason.
  let allowlist = ctx.settingsAllowlist()
  for key in settings.keys:
    if key notin allowlist:
      return ctx.refuse("set_settings", id, "setting_not_allowed", key)
    if not validateCloudSetting(key, settings[key]):
      return ctx.refuse("set_settings", id, "invalid_settings", key)
  # A tzdata slice without the zone it belongs to is meaningless.
  if settings.hasKey("timezone_data") and not settings.hasKey("timezone"):
    return ctx.refuse("set_settings", id, "invalid_settings", "timezone_data")
  var payload = newJObject()
  for key in settings.keys:
    payload[key] = copy(settings[key])
  if payload.hasKey("timezone_updater"):
    # The persist path replaces the whole timeZoneUpdates object, and the
    # provider only ever sends enabled/hour: carry the download URL the frame
    # already uses across, so a push can never point the updater anywhere new
    # — nor silently reset a URL the local admin chose.
    let current = if ctx.frameConfig != nil: ctx.frameConfig.timeZoneUpdates else: nil
    if current != nil and current.url.strip().len > 0:
      payload["timezone_updater"]["url"] = %current.url
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
      except ValueError as error:
        # The persist path's own refusal of a value that passed the shape
        # check — a GPIO the board does not have, a rotation the panel
        # cannot do. The verb is refused whole, like any invalid value.
        return ctx.refuse("set_settings", id, "invalid_settings", error.msg)
      except CatchableError as error:
        return ctx.refuse("set_settings", id, "persist_failed", error.msg)
      # A driver-init key (see CLOUD_SETTINGS_RESTART_KEYS) needs the process
      # to come back up; everything else is picked up by a config reload.
      var needsRestart = false
      for key in CLOUD_SETTINGS_RESTART_KEYS:
        if payload.hasKey(key):
          needsRestart = true
      if payload.hasKey("timezone") and not ctx.applyTimeZoneFn.isNil:
        ctx.applyTimeZoneFn(payload["timezone"].getStr(""))
      # Same order as restart_runtime: the event queues here, the ack goes
      # out on return, the runner exits when it drains the queue.
      discard ctx.sendEventFn(if needsRestart: "restart" else: "reload", %*{})
  ctx.audit("set_settings", true)
  CloudVerbReply(ack: ackOk(id))

proc handleRefreshServiceSettings(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  ## Advisory nudge: "your service settings changed, re-fetch them". The
  ## payload is always empty — API keys never ride the command queue
  ## (docs/cloud-frames.md, "Service settings"), and nothing in this handler
  ## reads one. Set_settings and this verb are disjoint paths: the six
  ## service-settings groups are NOT in CLOUD_SETTINGS_ALLOWLIST and never
  ## become settable over the socket.
  if ctx.backendManaged:
    # The settings poll takes its payload from the backend whenever one is
    # configured, so acking the nudge would promise a fetch that never reads
    # the provider.
    return refuseBackendManaged(ctx, "refresh_service_settings", id)
  if not ctx.hasScope(ServiceSettingsScope):
    # The provider's 403 on the fetch is the real revocation boundary, but a
    # device that knows it was never granted the scope says so up front.
    return ctx.refuse("refresh_service_settings", id, "insufficient_scope")
  if ctx.refreshServiceSettingsFn.isNil:
    return ctx.refuse("refresh_service_settings", id, "unsupported_verb")
  # Ack on ACCEPTING the nudge, not on completing the fetch: the fetch is HTTP
  # on our own schedule, and a failed fetch must not look like a refused verb.
  ctx.refreshServiceSettingsFn()
  ctx.audit("refresh_service_settings", true)
  CloudVerbReply(ack: ackOk(id))

proc handleSetSchedule(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.backendManaged:
    return refuseBackendManaged(ctx, "set_schedule", id)
  var schedule = msg{"schedule"}
  # `null` clears the schedule (the shape the firmware always took); an
  # absent or non-object value is a malformed push.
  if schedule != nil and schedule.kind == JNull:
    schedule = %*{"events": []}
  if schedule == nil or schedule.kind != JObject:
    return ctx.refuse("set_schedule", id, "invalid_schedule")
  var payload = %*{"schedule": schedule}
  # The frame's current UTC offset, sent by providers for devices without a
  # tz database (docs/cloud-frames.md `set_schedule`). Carried through to the
  # persist path under the wire key; the Linux merge has no field for it and
  # ignores it, the firmware applies it before the schedule.
  let offset = msg{"utcOffsetMinutes"}
  if offset != nil and offset.kind == JInt:
    payload["utcOffsetMinutes"] = %offset.getInt()
  try:
    ctx.persistSettingsFn(payload)
  except ValueError as error:
    return ctx.refuse("set_schedule", id, "invalid_schedule", error.msg)
  except CatchableError as error:
    return ctx.refuse("set_schedule", id, "persist_failed", error.msg)
  discard ctx.sendEventFn("reload", %*{})
  ctx.audit("set_schedule", true)
  CloudVerbReply(ack: ackOk(id))

proc handleSetCurrentScene(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.backendManaged:
    return refuseBackendManaged(ctx, "set_current_scene", id)
  let sceneId = msg{"scene_id"}.getStr("")
  if sceneId.len == 0:
    return ctx.refuse("set_current_scene", id, "invalid_scene_id")
  var payload = %*{"sceneId": sceneId}
  # Optional public scene-state values, same shape the local setCurrentScene
  # event carries (docs/cloud-frames.md).
  let state = msg{"state"}
  if state != nil and state.kind == JObject:
    payload["state"] = copy(state)
  if not ctx.sendEventFn("setCurrentScene", payload):
    # Dropped on the floor (a full runtime queue): an ok ack would tell the
    # provider the switch happened.
    return ctx.refuse("set_current_scene", id, "queue_full")
  ctx.audit("set_current_scene", true)
  CloudVerbReply(ack: ackOk(id))

proc handleAssetsList(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  if ctx.listAssetsFn.isNil:
    return ctx.refuse("assets_list", id, "unsupported_verb")
  let listing =
    try:
      ctx.listAssetsFn()
    except CatchableError as error:
      return ctx.refuse("assets_list", id, "read_failed", error.msg)
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
    return ctx.refuse("asset_get", id, "unsupported_verb")
  let path = msg{"path"}.getStr("")
  if path.len == 0:
    return ctx.refuse("asset_get", id, "invalid_path")
  let thumb = msg{"thumb"}.getBool(false)
  let asset =
    try:
      ctx.readAssetFn(path, thumb)
    except CatchableError as error:
      return ctx.refuse("asset_get", id, "read_failed", error.msg)
  if asset.error.len > 0:
    return ctx.refuse("asset_get", id, asset.error, asset.detail)
  ctx.audit("asset_get", true)
  if asset.streamed:
    return CloudVerbReply(ack: ackOk(id))
  CloudVerbReply(ack: ackOk(id), extra: assetChunkExtras(id, asset))

proc handleImageGet(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  if ctx.getImageFn.isNil:
    return ctx.refuse("image_get", id, "unsupported_verb")
  let image =
    try:
      ctx.getImageFn()
    except CatchableError:
      AssetReadResult(error: "no_image")
  if image.error.len > 0:
    return ctx.refuse("image_get", id, image.error)
  ctx.audit("image_get", true)
  if image.streamed:
    return CloudVerbReply(ack: ackOk(id))
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

proc hiddenAssetPath*(relPath: string): bool =
  ## Dotfiles and dot-directories (".thumbs" above all) are local plumbing the
  ## admin panel does not list either — keep them off the wire.
  for component in relPath.split('/'):
    if component.len > 0 and component[0] == '.':
      return true
  false

proc refusedWritePath(path: string): bool =
  ## Writes never touch dot-directories: `.thumbs` and `.frameos` (scene
  ## snapshots) are the device's own plumbing. asset_get deliberately CAN
  ## read them (that is how the provider fetches scene snapshots), but a
  ## provider must not be able to plant or destroy files there.
  hiddenAssetPath(path.strip())

proc handleAssetPut(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.writeAssetFn.isNil:
    return ctx.refuse("asset_put", id, "unsupported_verb")
  let path = msg{"path"}.getStr("")
  if path.len == 0 or refusedWritePath(path):
    return ctx.refuse("asset_put", id, "invalid_path")
  let encoded = msg{"data"}.getStr("")
  var data: string
  try:
    data = decode(encoded)
  except CatchableError:
    return ctx.refuse("asset_put", id, "invalid_data")
  if data.len == 0:
    return ctx.refuse("asset_put", id, "invalid_data")
  if data.len > HubMaxAssetUploadBytes:
    return ctx.refuse("asset_put", id, "too_large")
  try:
    let stored = ctx.writeAssetFn(path, data)
    ctx.audit("asset_put", true)
    var ack = ackOk(id)
    ack["asset"] = stored
    CloudVerbReply(ack: ack)
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.refuse("asset_put", id, wireError)

proc validCloudUploadId*(uploadId: string): bool =
  ## [A-Za-z0-9_-]{1,64}: it becomes a filename component on the device.
  if uploadId.len == 0 or uploadId.len > HubMaxUploadIdLen:
    return false
  for ch in uploadId:
    if not (ch.isAlphaNumeric() or ch in {'-', '_'}):
      return false
  true

proc handleAssetPutChunk(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  ## The cloud→device half of the chunk protocol (docs/cloud-frames.md
  ## `asset_put_chunk`): the provider streams a file as offset-addressed
  ## chunks under one `upload_id`, waiting for each ack, and marks the last
  ## one `complete` with the destination `path`. Offsets make redelivery
  ## idempotent — hub delivery is at-least-once, and a chunk that arrives
  ## twice overwrites itself instead of appending. Nothing is visible in the
  ## assets directory until the final chunk lands.
  if ctx.putAssetChunkFn.isNil:
    return ctx.refuse("asset_put_chunk", id, "unsupported_verb")
  let uploadId = msg{"upload_id"}.getStr("")
  if not validCloudUploadId(uploadId):
    return ctx.refuse("asset_put_chunk", id, "invalid_upload_id")
  let offsetNode = msg{"offset"}
  if offsetNode == nil or offsetNode.kind != JInt or offsetNode.getBiggestInt() < 0:
    return ctx.refuse("asset_put_chunk", id, "invalid_offset")
  let offset = offsetNode.getBiggestInt()
  let complete = msg{"complete"}.getBool(false)
  let path = msg{"path"}.getStr("")
  # The destination is only needed (and only checked) on the final chunk;
  # the part itself never lives in the assets directory.
  if complete and (path.len == 0 or refusedWritePath(path)):
    return ctx.refuse("asset_put_chunk", id, "invalid_path")
  var data: string
  try:
    data = decode(msg{"data"}.getStr(""))
  except CatchableError:
    return ctx.refuse("asset_put_chunk", id, "invalid_data")
  if data.len == 0 or data.len > HubMaxAssetUploadBytes:
    return ctx.refuse("asset_put_chunk", id, if data.len == 0: "invalid_data" else: "too_large")
  if offset + data.len > HubMaxChunkedUploadBytes:
    return ctx.refuse("asset_put_chunk", id, "too_large")
  try:
    let stored = ctx.putAssetChunkFn(uploadId, offset, data, if complete: path else: "")
    ctx.audit("asset_put_chunk", true)
    var ack = ackOk(id)
    if complete:
      ack["asset"] = stored
    else:
      ack["received"] = stored{"received"}
    CloudVerbReply(ack: ack)
  except CatchableError as error:
    # A hole in the part is the sender's cue to restart from offset 0 — say
    # so distinctly, it is the one write error that is not the device's.
    let wireError = if error of ValueError and error.msg == "chunk_gap": "chunk_gap"
                    else: assetWriteError(error)
    ctx.refuse("asset_put_chunk", id, wireError)

proc handleAssetMkdir(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.mkdirAssetFn.isNil:
    return ctx.refuse("asset_mkdir", id, "unsupported_verb")
  let path = msg{"path"}.getStr("")
  if path.len == 0 or refusedWritePath(path):
    return ctx.refuse("asset_mkdir", id, "invalid_path")
  try:
    ctx.mkdirAssetFn(path)
    ctx.audit("asset_mkdir", true)
    CloudVerbReply(ack: ackOk(id))
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.refuse("asset_mkdir", id, wireError)

proc handleAssetDelete(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.deleteAssetFn.isNil:
    return ctx.refuse("asset_delete", id, "unsupported_verb")
  let path = msg{"path"}.getStr("")
  if path.len == 0 or refusedWritePath(path):
    return ctx.refuse("asset_delete", id, "invalid_path")
  try:
    ctx.deleteAssetFn(path)
    ctx.audit("asset_delete", true)
    CloudVerbReply(ack: ackOk(id))
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.refuse("asset_delete", id, wireError)

proc handleAssetRename(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if ctx.renameAssetFn.isNil:
    return ctx.refuse("asset_rename", id, "unsupported_verb")
  let src = msg{"src"}.getStr("")
  let dst = msg{"dst"}.getStr("")
  if src.len == 0 or dst.len == 0 or refusedWritePath(src) or refusedWritePath(dst):
    return ctx.refuse("asset_rename", id, "invalid_path")
  try:
    ctx.renameAssetFn(src, dst)
    ctx.audit("asset_rename", true)
    CloudVerbReply(ack: ackOk(id))
  except CatchableError as error:
    let wireError = assetWriteError(error)
    ctx.refuse("asset_rename", id, wireError)

proc handleGetLogs(ctx: CloudVerbContext, id: JsonNode, msg: JsonNode): CloudVerbReply =
  if not ctx.hasScope("telemetry:logs"):
    return ctx.refuse("get_logs", id, "insufficient_scope")
  let since = msg{"since"}.getStr("")
  var limit = msg{"limit"}.getInt(HubGetLogsDefaultLimit)
  limit = max(1, min(limit, HubGetLogsMaxLimit))
  let allLogs = ctx.getLogsFn()
  var filtered = newJArray()
  if allLogs != nil and allLogs.kind == JArray:
    for entry in allLogs:
      # `since` is an ISO timestamp and only comparable to one; an entry
      # stamped as epoch seconds (the firmware's ring) or not at all (before
      # SNTP) is kept — a replay with a few extra lines beats an empty one.
      let stamp = entry{"timestamp"}
      if since.len == 0 or stamp == nil or stamp.kind != JString or
          stamp.getStr("") >= since:
        filtered.add(entry)
  var logs = newJArray()
  let start = max(0, filtered.len - limit)
  for index in start ..< filtered.len:
    logs.add(filtered[index])
  # The wire shape (docs/cloud-frames.md): a bare ack, then a `log_batch`
  # carrying the command id — the same message the live tap sends, so the
  # provider stores a replay exactly like it stores the stream.
  var batch = %*{"type": "log_batch", "logs": logs}
  if id != nil and id.kind != JNull:
    batch["id"] = id
  CloudVerbReply(ack: ackOk(id), extra: @[batch])

proc handleGetMetrics(ctx: CloudVerbContext, id: JsonNode): CloudVerbReply =
  if not ctx.hasScope("telemetry:metrics"):
    return ctx.refuse("get_metrics", id, "insufficient_scope")
  # getMetricsFn hands back the device's sample history (oldest first, each
  # {"metrics": {…}, …} like the UI's metrics feed) or a single sample; the
  # wire carries one `metrics` message with the newest, same as the periodic
  # push. No sample yet — a frame that has not rendered — is `no_metrics`.
  let history = ctx.getMetricsFn()
  var sample: JsonNode = nil
  if history != nil and history.kind == JArray and history.len > 0:
    let newest = history[history.len - 1]
    if newest.kind == JObject:
      sample = if newest{"metrics"} != nil and newest["metrics"].kind == JObject: newest["metrics"]
               else: newest
  elif history != nil and history.kind == JObject:
    sample = history
  if sample == nil:
    return ctx.refuse("get_metrics", id, "no_metrics")
  var reply = %*{"type": "metrics", "metrics": sample}
  if id != nil and id.kind != JNull:
    reply["id"] = id
  CloudVerbReply(ack: ackOk(id), extra: @[reply])

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
  of "asset_put_chunk":
    result = handleAssetPutChunk(ctx, id, msg)
  of "asset_mkdir":
    result = handleAssetMkdir(ctx, id, msg)
  of "asset_delete":
    result = handleAssetDelete(ctx, id, msg)
  of "asset_rename":
    result = handleAssetRename(ctx, id, msg)
  of "image_get":
    result = handleImageGet(ctx, id)
  of "render":
    if ctx.sendEventFn("render", %*{}):
      result = CloudVerbReply(ack: ackOk(id))
    else:
      result = CloudVerbReply(ack: ackError(id, "queue_full"))
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
                    "installed": ctx.installedVersion}
    let offeredVersion = msg{"version"}.getStr("")
    if offeredVersion.len > 0:
      notice["version"] = %offeredVersion
    log(notice)
    result = CloudVerbReply(ack: ackOk(id))
    ctx.requestUpgradeFn()
  else:
    let label = if verb.len > 0: verb else: "(missing type)"
    result = ctx.refuse(label, id, "unknown_verb")

