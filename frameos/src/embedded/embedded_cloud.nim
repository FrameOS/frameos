## The ESP32 firmware's side of the cloud verb layer.
##
## The verb table, the scope checks, the settings allowlist and every ack
## shape live in frameos/cloud/verbs.nim and are the same code the Linux
## runtime runs. This module is the firmware's `CloudVerbContext`: each
## callback is a thin C binding (embedded/esp32/main/fos_cloud_verbs.c) onto
## the module that owns the state — fos_scenes for the scene store, fos_settings
## for NVS, fos_assets for the SD card, fos_client for the render loop. The C
## WebSocket client (fos_cloud.c) hands every provider message that is not
## part of the handshake to fos_nim_cloud_verb_impl and sends back whatever
## comes out, in order.
##
## Threading: called on the cloud task, under the (recursive) Nim runtime
## lock — the render task is never inside Nim at the same time, and the
## callbacks may re-enter the runtime (fos_tz_install does).

import std/[json, strutils]

import frameos/channels
import frameos/cloud/verbs
import frameos/types

import embedded_runtime

# ----------------------------------------------------------- C bindings
#
# Every proc returns "" on success or the wire error token to ack. JSON
# results come back as a malloc'd string the callee must release with
# fos_cloud_cb_free after copying — the static buffers of the other
# frameos_nim_* calls would be one verb's listing clobbering another's.

proc cApplyScenes(scenesJson: cstring, len: csize_t, sceneId: cstring,
                  checksum: cstring): cstring {.importc: "fos_cloud_cb_apply_scenes", cdecl.}
proc cApplySettings(settingsJson: cstring): cstring {.importc: "fos_cloud_cb_apply_settings", cdecl.}
proc cSetSchedule(scheduleJson: cstring, utcOffsetMinutes: cint,
                  hasOffset: bool): cstring {.importc: "fos_cloud_cb_set_schedule", cdecl.}
proc cSelectScene(sceneId: cstring): cstring {.importc: "fos_cloud_cb_select_scene", cdecl.}
proc cRenderNow() {.importc: "fos_cloud_cb_render_now", cdecl.}
proc cRestart() {.importc: "fos_cloud_cb_restart", cdecl.}
proc cRequestUpgrade() {.importc: "fos_cloud_cb_request_upgrade", cdecl.}
proc cRefreshServiceSettings() {.importc: "fos_cloud_cb_refresh_service_settings", cdecl.}
proc cVersion(): cstring {.importc: "fos_cloud_cb_version", cdecl.}
proc cStateJson(): cstring {.importc: "fos_cloud_cb_state_json", cdecl.}
proc cLogsJson(): cstring {.importc: "fos_cloud_cb_logs_json", cdecl.}
proc cMetricsJson(): cstring {.importc: "fos_cloud_cb_metrics_json", cdecl.}
proc cAssetsListJson(): cstring {.importc: "fos_cloud_cb_assets_list_json", cdecl.}
proc cAssetRead(path: cstring): cstring {.importc: "fos_cloud_cb_asset_read", cdecl.}
proc cImageRead(): cstring {.importc: "fos_cloud_cb_image_read", cdecl.}
proc cAssetWrite(path: cstring, data: pointer, len: csize_t,
                 err: var cstring): cstring {.importc: "fos_cloud_cb_asset_write", cdecl.}
proc cAssetPutChunk(uploadId: cstring, offset: clonglong, data: pointer, len: csize_t,
                    finalPath: cstring, err: var cstring): cstring {.
                    importc: "fos_cloud_cb_asset_put_chunk", cdecl.}
proc cAssetMkdir(path: cstring): cstring {.importc: "fos_cloud_cb_asset_mkdir", cdecl.}
proc cAssetDelete(path: cstring): cstring {.importc: "fos_cloud_cb_asset_delete", cdecl.}
proc cAssetRename(src, dst: cstring): cstring {.importc: "fos_cloud_cb_asset_rename", cdecl.}
proc cFree(p: pointer) {.importc: "fos_cloud_cb_free", cdecl.}

proc token(p: cstring): string =
  ## A static error token ("" = ok); never freed.
  if p.isNil: "" else: $p

proc takeOwned(p: cstring): string =
  ## Copy a malloc'd result and release it.
  if p.isNil:
    return ""
  result = $p
  cFree(p)

proc parseOwnedJson(p: cstring): JsonNode =
  let text = takeOwned(p)
  if text.len == 0:
    return nil
  parseJson(text)

proc raiseAssetError(err: string) =
  ## Map the C layer's tokens onto the exceptions the verb handlers translate
  ## (verbs.nim assetWriteError): a guard refusal is a ValueError, everything
  ## else an OSError, with the one message it names.
  case err
  of "invalid_path", "invalid_upload_id", "invalid_offset", "chunk_gap":
    raise newException(ValueError, err)
  of "not_found":
    raise newException(OSError, "Asset not found")
  else:
    raise newException(OSError, if err.len > 0: err else: "write_failed")

# ----------------------------------------------------------- the context

proc esp32SendEvent(event: string, payload: JsonNode): bool {.gcsafe.} =
  ## The runtime events the verb layer emits, mapped onto the firmware's
  ## modules. Anything else is a scene event, dispatched like a button press.
  {.cast(gcsafe).}:
    case event
    of "setCurrentScene":
      # Queued for the render task, which applies it before the next pass
      # (fos_scenes_select); the optional state seed is not carried on this
      # profile, as before.
      token(cSelectScene(payload{"sceneId"}.getStr("").cstring)).len == 0
    of "render":
      cRenderNow()
      true
    of "restart":
      cRestart()
      true
    of "reload":
      # Settings are live the moment fos_config has them: the render loop
      # pushes debug/scaling/interval into the runtime every pass.
      true
    else:
      channels.sendEvent(event, payload)
      true

proc esp32ApplyScenes(payload: JsonNode): string {.gcsafe.} =
  ## Persist the pushed scenes to /state and let the render task hot-load
  ## them (fos_scenes_set_json_from with the cloud source). Only the `scenes`
  ## array is reprinted — a max-size push already costs the socket buffer
  ## plus this tree, so nothing else is copied.
  {.cast(gcsafe).}:
    let scenes = payload{"scenes"}
    if scenes == nil or scenes.kind != JArray:
      return "invalid_scenes"
    let text = $scenes
    token(cApplyScenes(text.cstring, text.len.csize_t,
                       payload{"sceneId"}.getStr("").cstring,
                       payload{"checksum"}.getStr("").cstring))

proc esp32PersistSettings(payload: JsonNode) {.gcsafe.} =
  ## set_settings and set_schedule both land here. A refusal from the C
  ## applier (a pin the board lacks, a rotation the panel cannot do) is a
  ## ValueError so the verb answers `invalid_settings` / `invalid_schedule`;
  ## a storage failure is `persist_failed`.
  {.cast(gcsafe).}:
    var err: string
    if payload.hasKey("schedule"):
      let schedule = payload["schedule"]
      let text = if schedule.kind == JNull: "" else: $schedule
      let offset = payload{"utcOffsetMinutes"}
      err = token(cSetSchedule(if text.len > 0: text.cstring else: nil,
                               (if offset != nil: offset.getInt() else: 0).cint,
                               offset != nil))
    else:
      let text = $payload
      err = token(cApplySettings(text.cstring))
    case err
    of "": discard
    of "invalid_settings", "invalid_schedule": raise newException(ValueError, err)
    else: raise newException(IOError, err)

proc esp32State(): JsonNode {.gcsafe.} =
  ## The hello-shaped state: the static fields from C (version, hardware,
  ## the applied scenes checksum) plus what only the runtime knows — the
  ## scene the render task is on and its public state. Same keys the C hello
  ## sends (fos_cloud.c add_state_fields), so the hub folds both the same
  ## way; `active_scene` is left out until a scene has been selected.
  {.cast(gcsafe).}:
    result = parseOwnedJson(cStateJson())
    if result == nil or result.kind != JObject:
      result = %*{}
    let info = parseJson(sceneInfoJson())
    let active = info{"currentSceneId"}.getStr("")
    if active.len > 0:
      result["active_scene"] = %active
    let states = parseJson(sceneStateJson())
    result["states"] = if states.kind == JObject: states else: %*{}

proc esp32Context(scopes: seq[string], scenesChecksum: string,
                  backendManaged: bool): CloudVerbContext {.gcsafe.} =
  {.cast(gcsafe).}:
    CloudVerbContext(
      frameConfig: getFrameConfig(),
      scopes: scopes,
      scenesChecksum: scenesChecksum,
      installedVersion: token(cVersion()),
      settingsAllowlist: @CLOUD_SETTINGS_ALLOWLIST_ESP32,
      backendManaged: backendManaged,
      # The render task loads a pushed payload from flash on its next pass;
      # fos_cloud.c sends scene_ack when the load lands (ws_poll_scene_ack).
      deferredSceneAck: true,
      sendEventFn: esp32SendEvent,
      applyScenesFn: esp32ApplyScenes,
      persistSettingsFn: esp32PersistSettings,
      # No change probe: fos_config diffs and logs what changed itself, and a
      # no-op push costs an NVS write, not a panel refresh.
      settingsChangedFn: nil,
      applyTimeZoneFn: nil,
      persistChecksumFn: nil,
      getLogsFn: proc(): JsonNode {.gcsafe.} =
        {.cast(gcsafe).}:
          let logs = parseOwnedJson(cLogsJson())
          if logs == nil: newJArray() else: logs,
      getMetricsFn: proc(): JsonNode {.gcsafe.} =
        {.cast(gcsafe).}:
          parseOwnedJson(cMetricsJson()),
      getStateFn: esp32State,
      listAssetsFn: proc(): JsonNode {.gcsafe.} =
        {.cast(gcsafe).}:
          let listing = parseOwnedJson(cAssetsListJson())
          if listing == nil: %*{"assets": []} else: listing,
      readAssetFn: proc(path: string, thumb: bool): AssetReadResult {.gcsafe.} =
        # `thumb` is accepted and ignored: no thumbnailer on this profile,
        # the original bytes are the reply (docs/cloud-frames.md).
        {.cast(gcsafe).}:
          let err = token(cAssetRead(path.cstring))
          if err.len > 0: AssetReadResult(error: err)
          else: AssetReadResult(streamed: true),
      getImageFn: proc(): AssetReadResult {.gcsafe.} =
        {.cast(gcsafe).}:
          let err = token(cImageRead())
          if err.len > 0: AssetReadResult(error: err)
          else: AssetReadResult(streamed: true),
      writeAssetFn: proc(path: string, data: string): JsonNode {.gcsafe.} =
        {.cast(gcsafe).}:
          var err: cstring = nil
          let stored = parseOwnedJson(cAssetWrite(path.cstring, data[0].unsafeAddr,
                                                  data.len.csize_t, err))
          if stored == nil:
            raiseAssetError(token(err))
          stored,
      putAssetChunkFn: proc(uploadId: string, offset: BiggestInt, data: string,
                            finalPath: string): JsonNode {.gcsafe.} =
        {.cast(gcsafe).}:
          var err: cstring = nil
          let stored = parseOwnedJson(cAssetPutChunk(
            uploadId.cstring, offset.clonglong, data[0].unsafeAddr, data.len.csize_t,
            if finalPath.len > 0: finalPath.cstring else: nil, err))
          if stored == nil:
            raiseAssetError(token(err))
          stored,
      mkdirAssetFn: proc(path: string) {.gcsafe.} =
        {.cast(gcsafe).}:
          let err = token(cAssetMkdir(path.cstring))
          if err.len > 0: raiseAssetError(err),
      deleteAssetFn: proc(path: string) {.gcsafe.} =
        {.cast(gcsafe).}:
          let err = token(cAssetDelete(path.cstring))
          if err.len > 0: raiseAssetError(err),
      renameAssetFn: proc(src: string, dst: string) {.gcsafe.} =
        {.cast(gcsafe).}:
          let err = token(cAssetRename(src.cstring, dst.cstring))
          if err.len > 0: raiseAssetError(err),
      refreshServiceSettingsFn: proc() {.gcsafe.} =
        {.cast(gcsafe).}:
          cRefreshServiceSettings(),
      requestUpgradeFn: proc() {.gcsafe.} =
        {.cast(gcsafe).}:
          cRequestUpgrade(),
      rebootFn: proc() {.gcsafe.} =
        {.cast(gcsafe).}:
          cRestart(),
      auditFn: proc(payload: JsonNode) {.gcsafe.} =
        {.cast(gcsafe).}:
          channels.log(payload),
    )

# ----------------------------------------------------------- C entry point

var cloudVerbReplyBuffer: string
  ## The reply text handed back to C; valid until the next call, like the
  ## other frameos_nim_* result buffers.

proc parseScopes(scopesJson: cstring): seq[string] =
  result = @[]
  if scopesJson.isNil:
    return
  try:
    let parsed = parseJson($scopesJson)
    if parsed.kind == JArray:
      for scope in parsed:
        if scope.kind == JString and scope.getStr("").len > 0:
          result.add(scope.getStr(""))
  except CatchableError:
    discard

proc fos_nim_cloud_verb_impl(msg: cstring, len: csize_t, scopesJson: cstring,
                             scenesChecksum: cstring, backendManaged: bool): cstring {.exportc, cdecl.} =
  ## One provider→frame message in; a JSON array of the messages to send
  ## (the ack first, then any reply frames) out. "" when the message is not
  ## a JSON object — the C side answers `invalid_json` from the raw id then.
  var text = newString(len.int)
  if len > 0:
    copyMem(addr text[0], msg, len.int)
  var parsed: JsonNode
  try:
    parsed = parseJson(text)
  except CatchableError:
    return ""
  if parsed == nil or parsed.kind != JObject:
    return ""
  var replies = newJArray()
  try:
    let ctx = esp32Context(parseScopes(scopesJson), $scenesChecksum, backendManaged)
    let reply = handleCloudVerb(ctx, parsed)
    if reply.ack != nil:
      replies.add(reply.ack)
    for extra in reply.extra:
      replies.add(extra)
  except CatchableError as error:
    # A verb handler must never take the socket down with it: log, refuse
    # the one command, carry on. The provider's queue keeps the rest.
    log("cloud verb " & parsed{"type"}.getStr("") & " failed: " & error.msg)
    var ack = %*{"type": "ack", "ok": false, "error": "internal_error"}
    if parsed{"id"} != nil and parsed{"id"}.kind != JNull:
      ack["id"] = parsed["id"]
    replies = %*[ack]
  cloudVerbReplyBuffer = $replies
  cloudVerbReplyBuffer.cstring
