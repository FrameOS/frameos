## The verb layer as the ESP32 firmware drives it (src/embedded/
## embedded_cloud.nim): its own settings allowlist, a scene_ack the platform
## sends itself, assets streamed by the transport, and the backend-managed
## refusal. Exercised on the host with a stub context, because the firmware's
## verb table must not drift from the Linux one — that drift is the whole
## reason the layer is shared.

import std/[json, strutils, unittest]

import ../verbs
import ../../types

type
  Recorded = ref object
    events: seq[(string, JsonNode)]
    appliedScenes: seq[JsonNode]
    applyScenesError: string
    persisted: seq[JsonNode]
    persistError: string ## "" | "invalid" | "io"
    checksums: seq[string]
    audits: seq[JsonNode]
    reboots: int
    assetReads: seq[string]
    imageReads: int
    dropEvents: bool

proc esp32Context(recorded: Recorded, scopes: seq[string] = @[],
                  checksum = ""): CloudVerbContext =
  ## The shape embedded_cloud.nim builds, minus the C calls.
  CloudVerbContext(
    frameConfig: FrameConfig(mode: "embedded", device: "embedded", width: 800, height: 480),
    scopes: scopes,
    scenesChecksum: checksum,
    installedVersion: "2026.8.40",
    settingsAllowlist: @CLOUD_SETTINGS_ALLOWLIST_ESP32,
    deferredSceneAck: true,
    sendEventFn: proc(event: string, payload: JsonNode): bool {.gcsafe.} =
      if recorded.dropEvents:
        return false
      recorded.events.add((event, payload))
      true,
    applyScenesFn: proc(payload: JsonNode): string {.gcsafe.} =
      recorded.appliedScenes.add(payload)
      recorded.applyScenesError,
    persistSettingsFn: proc(payload: JsonNode) {.gcsafe.} =
      case recorded.persistError
      of "invalid": raise newException(ValueError, "gpio 99 does not exist")
      of "io": raise newException(IOError, "nvs full")
      else: discard
      recorded.persisted.add(payload),
    persistChecksumFn: proc(checksum: string) {.gcsafe.} =
      recorded.checksums.add(checksum),
    getLogsFn: proc(): JsonNode {.gcsafe.} =
      %*[
        {"payload": {"event": "boot"}},
        {"timestamp": 1756400000.0, "payload": {"event": "render"}},
      ],
    getMetricsFn: proc(): JsonNode {.gcsafe.} =
      %*{"heap": 12345},
    getStateFn: proc(): JsonNode {.gcsafe.} =
      %*{"frameos_version": "2026.8.40", "states": {}, "active_scene": "clock"},
    listAssetsFn: proc(): JsonNode {.gcsafe.} =
      %*{"assets": [], "truncated": false},
    readAssetFn: proc(path: string, thumb: bool): AssetReadResult {.gcsafe.} =
      recorded.assetReads.add(path)
      if path == "missing.jpg": AssetReadResult(error: "not_found")
      else: AssetReadResult(streamed: true),
    getImageFn: proc(): AssetReadResult {.gcsafe.} =
      inc recorded.imageReads
      AssetReadResult(streamed: true),
    refreshServiceSettingsFn: proc() {.gcsafe.} =
      discard,
    requestUpgradeFn: proc() {.gcsafe.} =
      discard,
    rebootFn: proc() {.gcsafe.} =
      recorded.reboots += 1,
    auditFn: proc(payload: JsonNode) {.gcsafe.} =
      recorded.audits.add(payload),
  )

proc interpretedScenes(): JsonNode =
  %*[{"id": "clock", "name": "Clock", "nodes": [], "edges": []}]

suite "cloud verbs on the ESP32 profile":
  test "the firmware allowlist takes the power keys the Linux list refuses":
    let recorded = Recorded()
    let reply = handleCloudVerb(esp32Context(recorded), %*{
      "id": "1", "type": "set_settings",
      "settings": {"deep_sleep": true, "deep_sleep_on_battery": false,
                   "wake_check_seconds": 900, "battery_pin": 1,
                   "battery_divider": 2.0, "battery_enable_pin": 21,
                   "interval": 600}})
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persisted.len == 1
    check recorded.persisted[0]{"wake_check_seconds"}.getInt() == 900
    # Same push at a Linux frame: the whole verb is refused on the first
    # unknown key, exactly as before the layer was shared.
    var linux = esp32Context(recorded)
    linux.settingsAllowlist = @[]
    let refused = handleCloudVerb(linux, %*{
      "id": "2", "type": "set_settings", "settings": {"deep_sleep": true}})
    check refused.ack{"error"}.getStr("") == "setting_not_allowed"

  test "the firmware allowlist refuses the Linux-only keys":
    let recorded = Recorded()
    for key in ["flip", "error_behavior", "control_code", "metrics_interval",
                "save_assets", "timezone_updater", "palette", "device_config"]:
      let reply = handleCloudVerb(esp32Context(recorded), %*{
        "id": key, "type": "set_settings", "settings": {key: true}})
      check reply.ack{"error"}.getStr("") == "setting_not_allowed"
    check recorded.persisted.len == 0

  test "every firmware-allowlisted key has a validator that accepts a sane value":
    let sane = %*{
      "name": "Kitchen", "rotate": 90, "interval": 300, "scaling_mode": "cover",
      "timezone": "Europe/Brussels", "timezone_data": {"timezones": {}, "dstChanges": {}},
      "debug": true, "max_http_response_bytes": 1048576,
      "gpio_buttons": [{"pin": 3, "label": "next"}],
      "deep_sleep": true, "deep_sleep_on_battery": true, "wake_check_seconds": 0,
      "battery_pin": -1, "battery_divider": 0.5, "battery_enable_pin": 21,
    }
    for key in CLOUD_SETTINGS_ALLOWLIST_ESP32:
      check sane.hasKey(key)
      check validateCloudSetting(key, sane[key])

  test "power keys are shape-checked before the persist path sees them":
    let recorded = Recorded()
    for bad in [%*{"wake_check_seconds": 86401}, %*{"wake_check_seconds": -1},
                %*{"battery_pin": 49}, %*{"battery_divider": 0.1},
                %*{"battery_divider": 21}, %*{"deep_sleep": "yes"},
                %*{"battery_enable_pin": "21"}]:
      let reply = handleCloudVerb(esp32Context(recorded), %*{
        "id": "x", "type": "set_settings", "settings": bad})
      check reply.ack{"error"}.getStr("") == "invalid_settings"
    check recorded.persisted.len == 0

  test "timezone_data rides with timezone and never alone":
    let recorded = Recorded()
    let ok = handleCloudVerb(esp32Context(recorded), %*{
      "id": "1", "type": "set_settings",
      "settings": {"timezone": "Europe/Tallinn", "timezone_data": newJNull()}})
    check ok.ack{"ok"}.getBool(false) == true
    let alone = handleCloudVerb(esp32Context(recorded), %*{
      "id": "2", "type": "set_settings",
      "settings": {"timezone_data": {"timezones": {}}}})
    check alone.ack{"error"}.getStr("") == "invalid_settings"
    let wrongShape = handleCloudVerb(esp32Context(recorded), %*{
      "id": "3", "type": "set_settings",
      "settings": {"timezone": "UTC", "timezone_data": "slice"}})
    check wrongShape.ack{"error"}.getStr("") == "invalid_settings"
    check recorded.persisted.len == 1

  test "the persist path's own refusal is invalid_settings, an I/O failure persist_failed":
    let recorded = Recorded(persistError: "invalid")
    let refused = handleCloudVerb(esp32Context(recorded), %*{
      "id": "1", "type": "set_settings", "settings": {"battery_pin": 40}})
    check refused.ack{"error"}.getStr("") == "invalid_settings"
    check recorded.audits[^1]{"error"}.getStr("").startsWith("invalid_settings: gpio 99")
    recorded.persistError = "io"
    let failed = handleCloudVerb(esp32Context(recorded), %*{
      "id": "2", "type": "set_settings", "settings": {"battery_pin": 40}})
    check failed.ack{"error"}.getStr("") == "persist_failed"

  test "set_settings without applyTimeZoneFn leaves the zone to the persist path":
    let recorded = Recorded()
    let reply = handleCloudVerb(esp32Context(recorded), %*{
      "id": "1", "type": "set_settings", "settings": {"timezone": "Asia/Tokyo"}})
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persisted[0]{"timezone"}.getStr("") == "Asia/Tokyo"
    # gpio_buttons is a restart key on both platforms: the firmware maps the
    # restart event onto its deferred reboot.
    let buttons = handleCloudVerb(esp32Context(recorded), %*{
      "id": "2", "type": "set_settings",
      "settings": {"gpio_buttons": [{"pin": 4, "label": "a"}]}})
    check buttons.ack{"ok"}.getBool(false) == true
    check recorded.events[^1][0] == "restart"

  test "set_scenes acks acceptance and leaves scene_ack to the platform":
    let recorded = Recorded()
    let reply = handleCloudVerb(esp32Context(recorded), %*{
      "id": "7", "type": "set_scenes", "checksum": "abc",
      "scenes": interpretedScenes(), "scene_id": "clock"})
    check reply.ack{"ok"}.getBool(false) == true
    check reply.extra.len == 0
    check recorded.appliedScenes.len == 1
    check recorded.appliedScenes[0]{"checksum"}.getStr("") == "abc"
    check recorded.appliedScenes[0]{"sceneId"}.getStr("") == "clock"
    check recorded.appliedScenes[0]{"source"}.getStr("") == "cloud"
    # Not persisted here: the platform remembers the checksum when the
    # payload actually loads.
    check recorded.checksums.len == 0
    check recorded.events.len == 0

  test "set_scenes reports the platform's storage error verbatim":
    let recorded = Recorded(applyScenesError: "scene_store_failed")
    let reply = handleCloudVerb(esp32Context(recorded), %*{
      "id": "7", "type": "set_scenes", "checksum": "abc", "scenes": interpretedScenes()})
    check reply.ack{"ok"}.getBool(false) == false
    check reply.ack{"error"}.getStr("") == "scene_store_failed"
    check recorded.audits[^1]{"error"}.getStr("") == "scene_store_failed"

  test "set_scenes redelivering the live checksum answers scene_ack at once":
    let recorded = Recorded()
    let reply = handleCloudVerb(esp32Context(recorded, checksum = "abc"), %*{
      "id": "8", "type": "set_scenes", "checksum": "abc", "scenes": interpretedScenes()})
    check reply.ack{"ok"}.getBool(false) == true
    check reply.extra.len == 1
    check reply.extra[0]{"type"}.getStr("") == "scene_ack"
    check reply.extra[0]{"active_scene"}.getStr("") == "clock"
    check recorded.appliedScenes.len == 0

  test "asset_get and image_get ack and let the transport stream the chunks":
    let recorded = Recorded()
    let asset = handleCloudVerb(esp32Context(recorded), %*{
      "id": "a", "type": "asset_get", "path": "photos/cat.jpg"})
    check asset.ack{"ok"}.getBool(false) == true
    check asset.extra.len == 0
    check recorded.assetReads == @["photos/cat.jpg"]
    let missing = handleCloudVerb(esp32Context(recorded), %*{
      "id": "b", "type": "asset_get", "path": "missing.jpg"})
    check missing.ack{"error"}.getStr("") == "not_found"
    let image = handleCloudVerb(esp32Context(recorded), %*{"id": "c", "type": "image_get"})
    check image.ack{"ok"}.getBool(false) == true
    check image.extra.len == 0
    check recorded.imageReads == 1

  test "a backend-managed frame refuses the content verbs and keeps the rest":
    let recorded = Recorded()
    var ctx = esp32Context(recorded, @["telemetry:logs", "settings:services"])
    ctx.backendManaged = true
    for verb in ["set_scenes", "set_current_scene", "set_settings", "set_schedule",
                 "refresh_service_settings"]:
      let reply = handleCloudVerb(ctx, %*{"id": verb, "type": verb,
        "scenes": interpretedScenes(), "scene_id": "clock",
        "settings": {"interval": 60}, "schedule": {"events": []}})
      check reply.ack{"error"}.getStr("") == "backend_managed"
      check recorded.audits[^1]{"error"}.getStr("") == "backend_managed"
    check recorded.appliedScenes.len == 0
    check recorded.persisted.len == 0
    check handleCloudVerb(ctx, %*{"id": "l", "type": "get_logs"}).ack{"ok"}.getBool(false)
    check handleCloudVerb(ctx, %*{"id": "r", "type": "render"}).ack{"ok"}.getBool(false)
    check handleCloudVerb(ctx, %*{"id": "s", "type": "get_state"}).ack{"ok"}.getBool(false)

  test "set_schedule carries utcOffsetMinutes through and clears on null":
    let recorded = Recorded()
    let withOffset = handleCloudVerb(esp32Context(recorded), %*{
      "id": "1", "type": "set_schedule", "schedule": {"events": []},
      "utcOffsetMinutes": 120})
    check withOffset.ack{"ok"}.getBool(false) == true
    check recorded.persisted[0]{"utcOffsetMinutes"}.getInt() == 120
    check recorded.persisted[0]{"schedule"}{"events"}.len == 0
    let cleared = handleCloudVerb(esp32Context(recorded), %*{
      "id": "2", "type": "set_schedule", "schedule": newJNull()})
    check cleared.ack{"ok"}.getBool(false) == true
    check recorded.persisted[1]{"schedule"}{"events"}.len == 0
    check recorded.persisted[1].hasKey("utcOffsetMinutes") == false
    let missing = handleCloudVerb(esp32Context(recorded), %*{"id": "3", "type": "set_schedule"})
    check missing.ack{"error"}.getStr("") == "invalid_schedule"

  test "set_current_scene and render report a dropped event instead of acking":
    let recorded = Recorded(dropEvents: true)
    let switched = handleCloudVerb(esp32Context(recorded), %*{
      "id": "1", "type": "set_current_scene", "scene_id": "clock"})
    check switched.ack{"error"}.getStr("") == "queue_full"
    let rendered = handleCloudVerb(esp32Context(recorded), %*{"id": "2", "type": "render"})
    check rendered.ack{"error"}.getStr("") == "queue_full"
    recorded.dropEvents = false
    let ok = handleCloudVerb(esp32Context(recorded), %*{
      "id": "3", "type": "set_current_scene", "scene_id": "clock", "state": {"n": 1}})
    check ok.ack{"ok"}.getBool(false) == true
    check recorded.events[^1][0] == "setCurrentScene"
    check recorded.events[^1][1]{"state"}{"n"}.getInt() == 1

  test "get_logs replays entries without an ISO timestamp":
    let recorded = Recorded()
    let reply = handleCloudVerb(esp32Context(recorded, @["telemetry:logs"]), %*{
      "id": "1", "type": "get_logs", "since": "2026-08-01T00:00:00Z"})
    check reply.ack{"ok"}.getBool(false) == true
    check reply.extra[0]{"type"}.getStr("") == "log_batch"
    check reply.extra[0]{"logs"}.len == 2

  test "get_metrics takes a single sample and says no_metrics without one":
    let recorded = Recorded()
    let reply = handleCloudVerb(esp32Context(recorded, @["telemetry:metrics"]), %*{
      "id": "1", "type": "get_metrics"})
    check reply.ack{"ok"}.getBool(false) == true
    check reply.extra[0]{"type"}.getStr("") == "metrics"
    check reply.extra[0]{"metrics"}{"heap"}.getInt() == 12345
    var ctx = esp32Context(recorded, @["telemetry:metrics"])
    ctx.getMetricsFn = proc(): JsonNode {.gcsafe.} = nil
    check handleCloudVerb(ctx, %*{"id": "2", "type": "get_metrics"})
      .ack{"error"}.getStr("") == "no_metrics"

  test "reboot and restart_runtime both reach the platform's reboot":
    let recorded = Recorded()
    check handleCloudVerb(esp32Context(recorded), %*{"id": "1", "type": "reboot"})
      .ack{"ok"}.getBool(false) == true
    check recorded.reboots == 1
    check handleCloudVerb(esp32Context(recorded), %*{"id": "2", "type": "restart_runtime"})
      .ack{"ok"}.getBool(false) == true
    check recorded.events[^1][0] == "restart"

  test "the verb table is the same on both profiles":
    # A verb the Linux runtime serves must not be unknown_verb on the
    # firmware: the profiles differ in what the callbacks do, never in which
    # verbs exist.
    let recorded = Recorded()
    let ctx = esp32Context(recorded, @["telemetry:logs", "telemetry:metrics", "settings:services"])
    for verb in ["set_scenes", "set_settings", "set_schedule", "refresh_service_settings",
                 "set_current_scene", "get_state", "get_logs", "get_metrics",
                 "assets_list", "asset_get", "asset_put", "asset_put_chunk",
                 "asset_mkdir", "asset_delete", "asset_rename", "image_get",
                 "render", "reboot", "restart_runtime", "notify_update_available"]:
      let reply = handleCloudVerb(ctx, %*{"id": verb, "type": verb})
      check reply.ack{"error"}.getStr("") != "unknown_verb"
    check handleCloudVerb(ctx, %*{"id": "x", "type": "shell"}).ack{"error"}.getStr("") == "unknown_verb"
