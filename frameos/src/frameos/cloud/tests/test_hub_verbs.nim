import std/[base64, json, sequtils, strutils, tables, unittest]

import ../hub_client
import ../../types

type
  Recorded = ref object
    events: seq[(string, JsonNode)]
    persistedSettings: seq[JsonNode]
    persistedChecksums: seq[string]
    audits: seq[JsonNode]
    reboots: int
    dropEvents: bool ## simulates a full runtime event queue
    assetReads: seq[(string, bool)]
    assetData: string ## what readAssetFn serves for "photos/cat.jpg"
    assetWrites: seq[(string, string)]
    ## asset_put_chunk parts, upload_id → bytes so far (an in-memory stand-in
    ## for the device's part files, with the same offset semantics).
    chunkParts: Table[string, string]
    assetMkdirs: seq[string]
    assetDeletes: seq[string]
    assetRenames: seq[(string, string)]
    serviceSettingsRefreshes: int
    upgradeRequests: int

proc makeContext(recorded: Recorded, scopes: seq[string] = @[]): CloudVerbContext =
  CloudVerbContext(
    frameConfig: FrameConfig(mode: "test", device: "web_only", width: 800, height: 480),
    scopes: scopes,
    scenesChecksum: "",
    sendEventFn: proc(event: string, payload: JsonNode): bool {.gcsafe.} =
      if recorded.dropEvents:
        return false
      recorded.events.add((event, payload))
      true,
    persistSettingsFn: proc(payload: JsonNode) {.gcsafe.} =
      recorded.persistedSettings.add(payload),
    persistChecksumFn: proc(checksum: string) {.gcsafe.} =
      recorded.persistedChecksums.add(checksum),
    getLogsFn: proc(): JsonNode {.gcsafe.} =
      %*[
        {"timestamp": "2026-08-01T10:00:00Z", "line": "one"},
        {"timestamp": "2026-08-02T10:00:00Z", "line": "two"},
        {"timestamp": "2026-08-02T11:00:00Z", "line": "three"},
      ],
    getMetricsFn: proc(): JsonNode {.gcsafe.} =
      %*[{"metrics": {"load": 0.5}}],
    getStateFn: proc(): JsonNode {.gcsafe.} =
      %*{"frameos_version": "test", "states": {}, "active_scene": "sceneA"},
    listAssetsFn: proc(): JsonNode {.gcsafe.} =
      %*{"assets": [
        {"path": "photos", "size": 0, "mtime": 1700000000, "is_dir": true},
        {"path": "photos/cat.jpg", "size": 5, "mtime": 1700000001, "is_dir": false},
      ]},
    readAssetFn: proc(path: string, thumb: bool): AssetReadResult {.gcsafe.} =
      recorded.assetReads.add((path, thumb))
      if path == "photos/cat.jpg":
        AssetReadResult(
          data: if recorded.assetData.len > 0: recorded.assetData else: "hello",
          contentType: "image/jpeg", mtime: 1700000001)
      else:
        AssetReadResult(error: "not_found"),
    getImageFn: proc(): AssetReadResult {.gcsafe.} =
      if recorded.assetData == "no-image":
        AssetReadResult(error: "no_image")
      else:
        AssetReadResult(data: "png-bytes", contentType: "image/png", mtime: 1700000002),
    writeAssetFn: proc(path: string, data: string): JsonNode {.gcsafe.} =
      if path == "denied.bin":
        raise newException(ValueError, "Invalid asset path")
      recorded.assetWrites.add((path, data))
      %*{"path": path, "size": data.len, "mtime": 1700000003, "is_dir": false},
    putAssetChunkFn: proc(uploadId: string, offset: BiggestInt, data: string,
                          finalPath: string): JsonNode {.gcsafe.} =
      if finalPath == "denied.bin":
        raise newException(ValueError, "Invalid asset path")
      var part = recorded.chunkParts.getOrDefault(uploadId, "")
      if offset <= 0:
        part = data
      elif part.len < offset:
        raise newException(ValueError, "chunk_gap")
      else:
        part = part[0 ..< offset.int] & data
      if finalPath.len == 0:
        recorded.chunkParts[uploadId] = part
        return %*{"received": part.len}
      recorded.chunkParts.del(uploadId)
      recorded.assetWrites.add((finalPath, part))
      %*{"path": finalPath, "size": part.len, "mtime": 1700000004, "is_dir": false},
    mkdirAssetFn: proc(path: string) {.gcsafe.} =
      recorded.assetMkdirs.add(path),
    deleteAssetFn: proc(path: string) {.gcsafe.} =
      if path == "missing.bin":
        raise newException(OSError, "Asset not found")
      recorded.assetDeletes.add(path),
    renameAssetFn: proc(src: string, dst: string) {.gcsafe.} =
      recorded.assetRenames.add((src, dst)),
    refreshServiceSettingsFn: proc() {.gcsafe.} =
      recorded.serviceSettingsRefreshes += 1,
    requestUpgradeFn: proc() {.gcsafe.} =
      recorded.upgradeRequests += 1,
    rebootFn: proc() {.gcsafe.} =
      recorded.reboots += 1,
    auditFn: proc(payload: JsonNode) {.gcsafe.} =
      recorded.audits.add(payload),
  )

proc auditedVerbs(recorded: Recorded): seq[string] =
  recorded.audits.mapIt(it{"verb"}.getStr(""))

suite "cloud hub verb dispatcher":
  test "unknown verbs are refused and audited":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    for verb in ["definitely_not_a_verb", "shell", "exec", "file_write",
                 "terminal", "ssh", "update_url", "assume_profile"]:
      let reply = handleCloudVerb(ctx, %*{"id": "1", "type": verb, "command": "rm -rf /"})
      check reply.ack{"ok"}.getBool(true) == false
      check reply.ack{"error"}.getStr("") == "unknown_verb"
      check reply.ack{"id"}.getStr("") == "1"
      check reply.extra.len == 0
    check recorded.events.len == 0
    check recorded.persistedSettings.len == 0
    check recorded.audits.len == 8
    for audit in recorded.audits:
      check audit{"event"}.getStr("") == "cloud:audit"
      check audit{"error"}.getStr("") == "unknown_verb"

  test "a message without a type is refused":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{"id": "9"})
    check reply.ack{"error"}.getStr("") == "unknown_verb"
    check handleCloudVerb(makeContext(recorded), nil).ack{"error"}.getStr("") == "invalid_message"

  test "set_settings refuses the whole verb on one disallowed key":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "2", "type": "set_settings",
      "settings": {"name": "Kitchen", "ssh_user": "root"},
    })
    check reply.ack{"ok"}.getBool(true) == false
    check reply.ack{"error"}.getStr("") == "setting_not_allowed"
    check recorded.persistedSettings.len == 0
    check recorded.events.len == 0

  test "set_settings can never grant local network access":
    # The local-presence override for the private-network HTTP deny must stay
    # out of the provider's reach: any spelling that could smuggle it in is
    # refused wholesale by the closed allowlist.
    for smuggled in ["network", "allowLocalNetworkAccess", "allow_local_network_access",
                     "network.allowLocalNetworkAccess", "networkConfig"]:
      let recorded = Recorded()
      var settings = %*{"name": "innocent"}
      settings[smuggled] = if smuggled == "network": %*{"allowLocalNetworkAccess": true}
                          else: %true
      let reply = handleCloudVerb(makeContext(recorded), %*{
        "id": "s", "type": "set_settings", "settings": settings})
      check reply.ack{"ok"}.getBool(true) == false
      check reply.ack{"error"}.getStr("") == "setting_not_allowed"
      check recorded.persistedSettings.len == 0
      check recorded.events.len == 0

  test "set_settings applies allowlisted keys through the persist path":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "3", "type": "set_settings",
      "settings": {"name": "Kitchen", "rotate": 90, "interval": 300,
                   "scaling_mode": "cover", "timezone": "Europe/Brussels",
                   "debug": false},
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persistedSettings.len == 1
    check recorded.persistedSettings[0]{"name"}.getStr("") == "Kitchen"
    check recorded.persistedSettings[0]{"rotate"}.getInt(0) == 90
    check recorded.events.len == 1
    check recorded.events[0][0] == "reload"

  test "set_settings applies the 2026.8.30 extended keys and shape-checks them":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    ctx.frameConfig.timeZoneUpdates = TimeZoneUpdatesConfig(
      enabled: true, hour: 3, url: "https://tz.example.test/custom.json.gz")
    let reply = handleCloudVerb(ctx, %*{
      "id": "3x", "type": "set_settings",
      "settings": {
        "flip": "horizontal",
        "error_behavior": {"mode": "silent_retry", "retry_seconds": 30,
                           "silent_retry_forever": true, "silent_window_minutes": 15},
        "control_code": {"enabled": true, "position": "bottom-left", "size": 3,
                         "padding": 2, "offsetX": -4, "offsetY": 10,
                         "qrCodeColor": "#112233", "backgroundColor": "#FFFFFF"},
        "metrics_interval": 0,
        "max_http_response_bytes": 8 * 1024 * 1024,
        "save_assets": {"unsplash": true, "openai": false},
        "timezone_updater": {"enabled": false, "hour": 5},
      },
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persistedSettings.len == 1
    let persisted = recorded.persistedSettings[0]
    check persisted{"flip"}.getStr("") == "horizontal"
    check persisted{"control_code"}{"enabled"}.getBool(false) == true
    check persisted{"metrics_interval"}.getFloat(-1) == 0
    # The download URL is never the provider's to set: the frame's own URL
    # rides along so the whole-object persist cannot reset it.
    check persisted{"timezone_updater"}{"url"}.getStr("") == "https://tz.example.test/custom.json.gz"
    check persisted{"timezone_updater"}{"enabled"}.getBool(true) == false
    check recorded.events.len == 1
    check recorded.events[0][0] == "reload"

  test "set_settings applies the hardware batch and restarts the runtime for it":
    # palette / device_config / gpio_buttons are copied into the driver
    # context at init: a reload would persist them and change nothing on the
    # panel, so the push restarts the runtime instead.
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "hw", "type": "set_settings",
      "settings": {
        "name": "Kitchen",
        "palette": {"name": "Spectra", "colors": ["#000000", "#FFFFFF", "#ff0000", "#00ff00", "#0000ff", "#ffff00"],
                    "colorNames": ["black", "white", "red", "green", "blue", "yellow"]},
        "device_config": {"partial": true, "partialMaxAreaPercent": 25.5, "partialMaxRefreshesBeforeFull": 10},
        "gpio_buttons": [{"pin": 5, "label": "A"}, {"pin": 6, "label": "B"}],
      },
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persistedSettings.len == 1
    let persisted = recorded.persistedSettings[0]
    check persisted{"palette"}{"colors"}.len == 6
    check persisted{"device_config"}{"partial"}.getBool(false) == true
    check persisted{"device_config"}.len == 3 # nothing else rides along
    check persisted{"gpio_buttons"}.len == 2
    check recorded.events.len == 1
    check recorded.events[0][0] == "restart"

    # Each of the three alone restarts too; the 2026.8.30 keys still reload.
    for settings in [%*{"palette": {"colors": []}}, %*{"device_config": {"partial": false}},
                     %*{"gpio_buttons": []}]:
      let one = Recorded()
      discard handleCloudVerb(makeContext(one), %*{"id": "h1", "type": "set_settings", "settings": settings})
      check one.events.len == 1 and one.events[0][0] == "restart"
    let soft = Recorded()
    discard handleCloudVerb(makeContext(soft), %*{"id": "h2", "type": "set_settings", "settings": {"flip": "both"}})
    check soft.events.len == 1 and soft.events[0][0] == "reload"

  test "set_settings refuses bad values for allowlisted keys with invalid_settings":
    let bad = [
      %*{"palette": {"colors": ["red"]}},
      %*{"palette": {"colors": "#ffffff"}},
      %*{"palette": {"colors": ["#ffffff"], "colorNames": ["a", "b"]}},
      %*{"palette": {"colors": ["#ffffff"], "lut": [1, 2, 3]}},
      %*{"palette": []},
      %*{"device_config": {}},
      %*{"device_config": {"partial": "true"}},
      %*{"device_config": {"partial": true, "vcom": -1.5}},
      %*{"device_config": {"partial": true, "pins": {"rst": 17}}},
      %*{"device_config": {"partialMaxAreaPercent": 101}},
      %*{"device_config": {"partialMaxRefreshesBeforeFull": -1}},
      %*{"gpio_buttons": {"pin": 5, "label": "A"}},
      %*{"gpio_buttons": [{"pin": 5}]},
      %*{"gpio_buttons": [{"pin": 5, "label": ""}]},
      %*{"gpio_buttons": [{"pin": 99, "label": "A"}]},
      %*{"gpio_buttons": [{"pin": 5, "label": "A", "action": "reboot"}]},
      %*{"gpio_buttons": [{"pin": 5, "label": "A"}, {"pin": 5, "label": "B"}]},
      %*{"flip": "diagonal"},
      %*{"flip": true},
      %*{"error_behavior": {"mode": "explode"}},
      %*{"error_behavior": {"retry_seconds": 0}},
      %*{"error_behavior": {"mode": "safe_mode", "shell": "rm -rf /"}},
      %*{"control_code": {"enabled": "true"}},
      %*{"control_code": {"position": "middle"}},
      %*{"control_code": {"qrCodeColor": "red"}},
      %*{"control_code": {"size": 0}},
      %*{"metrics_interval": -1},
      %*{"metrics_interval": "60"},
      %*{"max_http_response_bytes": 1},
      %*{"max_http_response_bytes": CloudMaxHttpResponseBytesCeiling + 1},
      %*{"save_assets": "yes"},
      %*{"save_assets": {"unsplash": "true"}},
      %*{"timezone_updater": {"url": "https://evil.example/tz.json.gz"}},
      %*{"timezone_updater": {"hour": 24}},
      %*{"timezone_updater": {"enabled": true, "url": "https://evil.example/tz.json.gz"}},
      %*{"rotate": 45},
      %*{"interval": 0},
      %*{"name": ""},
      %*{"debug": "true"},
    ]
    for settings in bad:
      let recorded = Recorded()
      var withValid = %*{"name": "Kitchen"}
      for key in settings.keys:
        withValid[key] = settings[key]
      let reply = handleCloudVerb(makeContext(recorded), %*{
        "id": "bad", "type": "set_settings", "settings": withValid})
      check reply.ack{"ok"}.getBool(true) == false
      check reply.ack{"error"}.getStr("") == "invalid_settings"
      check recorded.persistedSettings.len == 0
      check recorded.events.len == 0

  test "every allowlisted key has a validator that accepts a sane value":
    # A key with no rule falls through validateCloudSetting's `else` and
    # refuses every value — which would make the key unsettable while still
    # advertised. Pin one accepted value per key.
    let samples = %*{
      "name": "Kitchen", "rotate": 180, "interval": 300, "scaling_mode": "contain",
      "timezone": "Europe/Tallinn", "debug": true, "flip": "",
      "error_behavior": {"mode": "show_error_retry", "show_error_retry_seconds": 60},
      "control_code": {"enabled": false},
      "metrics_interval": 60, "max_http_response_bytes": 64 * 1024 * 1024,
      "save_assets": true, "timezone_updater": {"enabled": true, "hour": 3},
      "palette": {"colors": ["#ffffff", "#000000"]},
      "device_config": {"partial": true},
      "gpio_buttons": [{"pin": 5, "label": "A"}],
    }
    for key in CLOUD_SETTINGS_ALLOWLIST:
      check samples.hasKey(key)
      check validateCloudSetting(key, samples[key])
      check validateCloudSetting(key, newJNull()) == false
    check validateCloudSetting("not_a_setting", %"x") == false

  test "set_settings that changes nothing is acked without persist or reload":
    # Every "push scenes & settings" click redelivers the full settings
    # object; reloading the config for values already in effect re-inits the
    # active scene and re-renders the panel — an e-ink flash per no-op.
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    ctx.settingsChangedFn = proc(payload: JsonNode): bool {.gcsafe.} = false
    let reply = handleCloudVerb(ctx, %*{
      "id": "3b", "type": "set_settings",
      "settings": {"name": "Kitchen", "rotate": 90},
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persistedSettings.len == 0
    check recorded.events.len == 0
    check "set_settings" in auditedVerbs(recorded)

  test "set_settings with a nil change probe keeps the old always-reload path":
    # nil = "assume changed": an older or test context that never wires the
    # probe must not silently lose reloads.
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    check ctx.settingsChangedFn.isNil
    let reply = handleCloudVerb(ctx, %*{
      "id": "3c", "type": "set_settings", "settings": {"name": "Kitchen"},
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persistedSettings.len == 1
    check recorded.events.len == 1

  test "refresh_service_settings needs settings:services and only accepts the nudge":
    let denied = Recorded()
    let refused = handleCloudVerb(makeContext(denied, @["frame:managed"]),
      %*{"id": "r1", "type": "refresh_service_settings"})
    check refused.ack{"ok"}.getBool(true) == false
    check refused.ack{"error"}.getStr("") == "insufficient_scope"
    check denied.serviceSettingsRefreshes == 0

    let granted = Recorded()
    let accepted = handleCloudVerb(
      makeContext(granted, @["frame:managed", "settings:services"]),
      %*{"id": "r2", "type": "refresh_service_settings"})
    check accepted.ack{"ok"}.getBool(false) == true
    check accepted.ack{"id"}.getStr("") == "r2"
    # The ack is bare: acceptance, not completion. The fetch is HTTP on the
    # device's own schedule and nothing about it rides the ack.
    check accepted.extra.len == 0
    check granted.serviceSettingsRefreshes == 1
    check granted.events.len == 0
    check granted.persistedSettings.len == 0
    check "refresh_service_settings" in auditedVerbs(granted)

  test "refresh_service_settings ignores any payload the provider attaches":
    # The wire payload is always empty; a provider that smuggles keys into it
    # must not be able to set anything — this handler reads no keys at all.
    let recorded = Recorded()
    let reply = handleCloudVerb(
      makeContext(recorded, @["settings:services"]),
      %*{"id": "r3", "type": "refresh_service_settings",
         "settings": {"unsplash": {"accessKey": "leaked"}}})
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.serviceSettingsRefreshes == 1
    check recorded.persistedSettings.len == 0

  test "set_settings and service settings stay disjoint paths":
    # The six service-settings groups are cloud-owned but only over the
    # separate HTTPS pull; they are NOT in CLOUD_SETTINGS_ALLOWLIST, so
    # set_settings refuses the whole verb when one shows up — even alongside
    # a perfectly valid key, and even with settings:services granted.
    for group in ["frameOS", "github", "homeAssistant", "immich", "openAI", "unsplash"]:
      check group notin CLOUD_SETTINGS_ALLOWLIST
      let recorded = Recorded()
      var settings = %*{"name": "Kitchen"}
      settings[group] = %*{"apiKey": "sk-live-should-never-arrive-here"}
      let reply = handleCloudVerb(
        makeContext(recorded, @["frame:managed", "settings:services"]),
        %*{"id": "d1", "type": "set_settings", "settings": settings})
      check reply.ack{"ok"}.getBool(true) == false
      check reply.ack{"error"}.getStr("") == "setting_not_allowed"
      check recorded.persistedSettings.len == 0
      check recorded.events.len == 0
      check recorded.serviceSettingsRefreshes == 0

  test "set_schedule persists and reloads":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "4", "type": "set_schedule",
      "schedule": {"events": [{"id": "e1", "minute": 0, "hour": 8, "weekday": 0,
                               "event": "setCurrentScene", "payload": {}}]},
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.persistedSettings.len == 1
    check recorded.persistedSettings[0]{"schedule"}{"events"}.len == 1
    check recorded.events.len == 1 and recorded.events[0][0] == "reload"
    let bad = handleCloudVerb(makeContext(Recorded()), %*{"type": "set_schedule", "schedule": []})
    check bad.ack{"error"}.getStr("") == "invalid_schedule"

  test "set_scenes refuses non-array payloads":
    let recorded = Recorded()
    for scenes in [%*{"not": "an array"}, %*[], newJNull()]:
      let reply = handleCloudVerb(makeContext(recorded), %*{
        "id": "5", "type": "set_scenes", "scenes": scenes, "checksum": "abc"})
      check reply.ack{"error"}.getStr("") == "invalid_scenes"
    check recorded.events.len == 0
    check recorded.persistedChecksums.len == 0

  test "set_scenes refuses compiled/source-only apps":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "6", "type": "set_scenes", "checksum": "abc",
      "scenes": [{
        "id": "scene1", "name": "Test",
        "nodes": [{"id": "1", "type": "app",
                   "data": {"keyword": "custom/thing",
                            "sources": {"app.nim": "import osproc"}}}],
        "edges": [],
      }],
    })
    check reply.ack{"ok"}.getBool(true) == false
    check reply.ack{"error"}.getStr("") == "not_interpreted"
    check recorded.events.len == 0
    check recorded.persistedChecksums.len == 0

  test "set_scenes refuses scene-level source-only apps":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "type": "set_scenes", "checksum": "abc",
      "scenes": [{
        "id": "scene1", "name": "Test",
        "nodes": [{"id": "1", "type": "app", "data": {"keyword": "custom/thing"}}],
        "edges": [],
        "apps": {"custom/thing": {"sources": {"app.nim": "import osproc"}}},
      }],
    })
    check reply.ack{"error"}.getStr("") == "not_interpreted"

  test "set_scenes accepts interpreted scenes and reports scene_ack":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    let reply = handleCloudVerb(ctx, %*{
      "id": "7", "type": "set_scenes", "checksum": "sum-1",
      "scenes": [{
        "id": "scene1", "name": "Test",
        "nodes": [
          {"id": "1", "type": "app",
           "data": {"keyword": "code/js",
                    "sources": {"app.ts": "export function run() {}",
                                "app.nim": "generated wrapper, ignored"}}},
        ],
        "edges": [],
      }],
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.events.len == 1
    check recorded.events[0][0] == "uploadScenes"
    check recorded.events[0][1]{"scenes"}.kind == JArray
    # The device stamps the runtime origin itself — this is what persists to
    # state/uploaded.json and keeps the LAN deny alive after a demotion.
    check recorded.events[0][1]{"source"}.getStr("") == "cloud"
    check recorded.persistedChecksums == @["sum-1"]
    check ctx.scenesChecksum == "sum-1"
    check reply.extra.len == 1
    check reply.extra[0]{"type"}.getStr("") == "scene_ack"
    check reply.extra[0]{"checksum"}.getStr("") == "sum-1"
    check reply.extra[0]{"active_scene"}.getStr("") == "uploaded/scene1"

  test "set_scenes redelivering the applied checksum is acked without a re-upload":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    ctx.scenesChecksum = "sum-1"
    let reply = handleCloudVerb(ctx, %*{
      "id": "7b", "type": "set_scenes", "checksum": "sum-1",
      "scenes": [{"id": "scene1", "name": "Test", "nodes": [], "edges": []}],
    })
    check reply.ack{"ok"}.getBool(false) == true
    # No uploadScenes event: re-applying an identical payload re-inits the
    # scene and re-renders the panel for nothing.
    check recorded.events.len == 0
    # The scene_ack still goes out — it is what reconciles the provider's
    # sync row — and reports the scene ACTUALLY showing, since the runtime
    # was not touched.
    check reply.extra.len == 1
    check reply.extra[0]{"type"}.getStr("") == "scene_ack"
    check reply.extra[0]{"checksum"}.getStr("") == "sum-1"
    check reply.extra[0]{"active_scene"}.getStr("") == "sceneA"

  test "set_scenes with a matching checksum still uploads when asked to switch scene":
    # An unchanged payload plus scene_id (the workspace's "preview on frame")
    # is new work: the switch and state seed ride the upload event.
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    ctx.scenesChecksum = "sum-1"
    let reply = handleCloudVerb(ctx, %*{
      "id": "7c", "type": "set_scenes", "checksum": "sum-1",
      "scene_id": "scene1",
      "scenes": [{"id": "scene1", "name": "Test", "nodes": [], "edges": []}],
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.events.len == 1
    check recorded.events[0][0] == "uploadScenes"

  test "set_scenes with a new checksum always uploads":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    ctx.scenesChecksum = "sum-old"
    let reply = handleCloudVerb(ctx, %*{
      "id": "7d", "type": "set_scenes", "checksum": "sum-new",
      "scenes": [{"id": "scene1", "name": "Test", "nodes": [], "edges": []}],
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.events.len == 1
    check ctx.scenesChecksum == "sum-new"

  test "set_scenes refuses built-in apps that spawn processes":
    # These two apps run child processes against a configured target
    # (chromium / ffmpeg), so they never pass through utils/http_client's
    # private-network chokepoint — a cloud push naming them would be an SSRF
    # pivot onto the owner's LAN plus, for chromium, an apt-get install.
    for keyword in ["data/chromiumScreenshot", "data/rstpSnapshot",
                    "chromiumScreenshot", "legacy/rstpSnapshot"]:
      let recorded = Recorded()
      let reply = handleCloudVerb(makeContext(recorded), %*{
        "id": "sc", "type": "set_scenes", "checksum": "abc",
        "scenes": [{
          "id": "scene1", "name": "Test",
          "nodes": [{"id": "1", "type": "app", "data": {"keyword": keyword}}],
          "edges": [],
        }],
      })
      check reply.ack{"ok"}.getBool(true) == false
      check reply.ack{"error"}.getStr("") == "app_not_allowed"
      check recorded.events.len == 0
      check recorded.persistedChecksums.len == 0
      check recorded.audits[^1]{"error"}.getStr("").startsWith("app_not_allowed")
    # An ordinary app in the same shape still deploys.
    let ok = Recorded()
    check handleCloudVerb(makeContext(ok), %*{
      "id": "sc", "type": "set_scenes", "checksum": "abc",
      "scenes": [{
        "id": "scene1", "name": "Test",
        "nodes": [{"id": "1", "type": "app", "data": {"keyword": "data/clock"}}],
        "edges": [],
      }],
    }).ack{"ok"}.getBool(false) == true

  test "set_scenes reports a retryable error when the event queue is full":
    # A dropped uploadScenes means the deploy never happened; acking ok (and
    # persisting the checksum) would make the provider believe the frame is up
    # to date and never push again.
    let recorded = Recorded()
    recorded.dropEvents = true
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "q", "type": "set_scenes", "checksum": "sum-q",
      "scenes": [{"id": "scene1", "name": "Test", "nodes": [], "edges": []}],
    })
    check reply.ack{"ok"}.getBool(true) == false
    check reply.ack{"error"}.getStr("") == "queue_full"
    check reply.extra.len == 0
    check recorded.persistedChecksums.len == 0
    check recorded.audits[^1]{"error"}.getStr("") == "queue_full"

  test "get_logs requires telemetry:logs":
    let recorded = Recorded()
    let denied = handleCloudVerb(makeContext(recorded), %*{"id": "8", "type": "get_logs"})
    check denied.ack{"error"}.getStr("") == "insufficient_scope"
    let granted = handleCloudVerb(makeContext(recorded, @["frame:managed", "telemetry:logs"]),
      %*{"id": "8", "type": "get_logs", "since": "2026-08-02T00:00:00Z", "limit": 1})
    check granted.ack{"ok"}.getBool(false) == true
    check granted.ack{"logs"}.len == 1
    check granted.ack{"logs"}[0]{"line"}.getStr("") == "three"

  test "get_metrics requires telemetry:metrics":
    let recorded = Recorded()
    check handleCloudVerb(makeContext(recorded), %*{"type": "get_metrics"})
      .ack{"error"}.getStr("") == "insufficient_scope"
    let granted = handleCloudVerb(makeContext(recorded, @["telemetry:metrics"]),
      %*{"type": "get_metrics"})
    check granted.ack{"ok"}.getBool(false) == true
    check granted.ack{"metrics"}.kind == JArray

  test "get_state replies with the hello-shaped state":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{"id": "10", "type": "get_state"})
    check reply.ack{"ok"}.getBool(false) == true
    check reply.ack{"state"}{"active_scene"}.getStr("") == "sceneA"
    check reply.extra.len == 1
    check reply.extra[0]{"type"}.getStr("") == "state"
    check reply.extra[0]{"id"}.getStr("") == "10"

  test "render and set_current_scene dispatch events":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    check handleCloudVerb(ctx, %*{"type": "render"}).ack{"ok"}.getBool(false)
    check handleCloudVerb(ctx, %*{"type": "set_current_scene", "scene_id": "uploaded/x"})
      .ack{"ok"}.getBool(false)
    check handleCloudVerb(ctx, %*{"type": "set_current_scene"})
      .ack{"error"}.getStr("") == "invalid_scene_id"
    check recorded.events.mapIt(it[0]) == @["render", "setCurrentScene"]
    check recorded.events[1][1]{"sceneId"}.getStr("") == "uploaded/x"

  test "set_current_scene forwards the optional state object":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "type": "set_current_scene", "scene_id": "uploaded/x",
      "state": {"message": "hi", "count": 3},
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.events.len == 1
    check recorded.events[0][1]{"state"}{"message"}.getStr("") == "hi"
    check recorded.events[0][1]{"state"}{"count"}.getInt(0) == 3
    # A non-object state is dropped, not forwarded.
    let recorded2 = Recorded()
    discard handleCloudVerb(makeContext(recorded2), %*{
      "type": "set_current_scene", "scene_id": "x", "state": "nonsense",
    })
    check not recorded2.events[0][1].hasKey("state")

  test "set_scenes forwards scene_id and state to the upload event":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "7", "type": "set_scenes", "checksum": "sum-2",
      "scene_id": "scene2", "state": {"greeting": "hey"},
      "scenes": [
        {"id": "scene1", "name": "One", "nodes": [], "edges": []},
        {"id": "scene2", "name": "Two", "nodes": [], "edges": []},
      ],
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.events[0][1]{"sceneId"}.getStr("") == "scene2"
    check recorded.events[0][1]{"state"}{"greeting"}.getStr("") == "hey"
    # scene_ack predicts the activation updateUploadedScenesFromPayload makes.
    check reply.extra[0]{"active_scene"}.getStr("") == "uploaded/scene2"
    # A scene_id not in the push falls back to the first scene.
    let recorded2 = Recorded()
    let reply2 = handleCloudVerb(makeContext(recorded2), %*{
      "id": "8", "type": "set_scenes", "checksum": "sum-3",
      "scene_id": "not-there",
      "scenes": [{"id": "scene1", "name": "One", "nodes": [], "edges": []}],
    })
    check reply2.extra[0]{"active_scene"}.getStr("") == "uploaded/scene1"

  test "assets_list replies with the listing":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "a1", "type": "assets_list",
    })
    check reply.ack{"ok"}.getBool(false) == true
    check reply.extra.len == 1
    let listing = reply.extra[0]
    check listing{"type"}.getStr("") == "assets"
    check listing{"id"}.getStr("") == "a1"
    check listing{"assets"}.len == 2
    check listing{"assets"}[1]{"path"}.getStr("") == "photos/cat.jpg"
    check not listing.hasKey("truncated")
    check recorded.audits[^1]{"verb"}.getStr("") == "assets_list"
    check recorded.audits[^1]{"ok"}.getBool(false) == true

  test "asset_get streams one chunk for a small file":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "g1", "type": "asset_get", "path": "photos/cat.jpg", "thumb": true,
    })
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.assetReads == @[("photos/cat.jpg", true)]
    check reply.extra.len == 1
    let chunk = reply.extra[0]
    check chunk{"type"}.getStr("") == "asset_chunk"
    check chunk{"id"}.getStr("") == "g1"
    check chunk{"seq"}.getInt(-1) == 0
    check chunk{"done"}.getBool(false) == true
    check chunk{"size"}.getInt(0) == 5
    check chunk{"content_type"}.getStr("") == "image/jpeg"
    check chunk{"mtime"}.getInt(0) == 1700000001
    check decode(chunk{"data"}.getStr("")) == "hello"

  test "asset_get chunks large files and reassembles losslessly":
    let recorded = Recorded()
    # Just over two chunk sizes so the tail chunk is tiny.
    recorded.assetData = newString(2 * 1024 * 1024 + 10)
    for i in 0 ..< recorded.assetData.len:
      recorded.assetData[i] = char(i mod 251)
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "g2", "type": "asset_get", "path": "photos/cat.jpg",
    })
    check reply.ack{"ok"}.getBool(false) == true
    check reply.extra.len == 3
    var reassembled = ""
    for index, chunk in reply.extra:
      check chunk{"seq"}.getInt(-1) == index
      check chunk{"done"}.getBool(false) == (index == 2)
      check chunk.hasKey("size") == (index == 0)
      reassembled.add(decode(chunk{"data"}.getStr("")))
    check reply.extra[0]{"size"}.getInt(0) == recorded.assetData.len
    check reassembled == recorded.assetData

  test "asset_get failures are plain error acks":
    let recorded = Recorded()
    let missing = handleCloudVerb(makeContext(recorded), %*{
      "id": "g3", "type": "asset_get", "path": "nope.bin",
    })
    check missing.ack{"ok"}.getBool(true) == false
    check missing.ack{"error"}.getStr("") == "not_found"
    check missing.extra.len == 0
    let noPath = handleCloudVerb(makeContext(recorded), %*{
      "id": "g4", "type": "asset_get",
    })
    check noPath.ack{"error"}.getStr("") == "invalid_path"
    # No readAssetFn call for the missing-path refusal.
    check recorded.assetReads == @[("nope.bin", false)]

  test "image_get streams the current render, no_image before the first one":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "i1", "type": "image_get",
    })
    check reply.ack{"ok"}.getBool(false) == true
    check reply.extra.len == 1
    check reply.extra[0]{"type"}.getStr("") == "asset_chunk"
    check reply.extra[0]{"content_type"}.getStr("") == "image/png"
    check decode(reply.extra[0]{"data"}.getStr("")) == "png-bytes"
    let empty = Recorded()
    empty.assetData = "no-image"
    let refused = handleCloudVerb(makeContext(empty), %*{
      "id": "i2", "type": "image_get",
    })
    check refused.ack{"error"}.getStr("") == "no_image"
    check refused.extra.len == 0

  test "asset_put stores decoded bytes and acks the stored entry":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "id": "p1", "type": "asset_put",
      "path": "photos/new.jpg", "data": encode("fresh-bytes"),
    })
    check reply.ack{"ok"}.getBool(false) == true
    check reply.ack{"asset"}{"path"}.getStr("") == "photos/new.jpg"
    check reply.ack{"asset"}{"size"}.getInt(0) == "fresh-bytes".len
    check recorded.assetWrites == @[("photos/new.jpg", "fresh-bytes")]

  test "asset_put refuses bad payloads without touching the filesystem":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    check handleCloudVerb(ctx, %*{
      "type": "asset_put", "data": encode("x"),
    }).ack{"error"}.getStr("") == "invalid_path"
    check handleCloudVerb(ctx, %*{
      "type": "asset_put", "path": "a.bin", "data": "",
    }).ack{"error"}.getStr("") == "invalid_data"
    check handleCloudVerb(ctx, %*{
      "type": "asset_put", "path": "a.bin", "data": "not-base64!!!",
    }).ack{"error"}.getStr("") == "invalid_data"
    # Guard refusals from the write helper surface as invalid_path.
    check handleCloudVerb(ctx, %*{
      "type": "asset_put", "path": "denied.bin", "data": encode("x"),
    }).ack{"error"}.getStr("") == "invalid_path"
    check recorded.assetWrites.len == 0

  test "asset_put_chunk assembles a file across acked chunks, offsets make retries idempotent":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    let first = handleCloudVerb(ctx, %*{
      "id": "c1", "type": "asset_put_chunk", "upload_id": "up_1",
      "offset": 0, "data": encode("hello "),
    })
    check first.ack{"ok"}.getBool(false) == true
    check first.ack{"received"}.getInt(0) == 6
    check first.ack.hasKey("asset") == false
    # At-least-once delivery: the same chunk again lands on the same bytes.
    let again = handleCloudVerb(ctx, %*{
      "id": "c1", "type": "asset_put_chunk", "upload_id": "up_1",
      "offset": 0, "data": encode("hello "),
    })
    check again.ack{"received"}.getInt(0) == 6
    let second = handleCloudVerb(ctx, %*{
      "id": "c2", "type": "asset_put_chunk", "upload_id": "up_1",
      "offset": 6, "data": encode("wor"),
    })
    check second.ack{"received"}.getInt(0) == 9
    let last = handleCloudVerb(ctx, %*{
      "id": "c3", "type": "asset_put_chunk", "upload_id": "up_1",
      "offset": 9, "data": encode("ld"), "complete": true, "path": "fonts/big.ttf",
    })
    check last.ack{"ok"}.getBool(false) == true
    check last.ack{"asset"}{"path"}.getStr("") == "fonts/big.ttf"
    check last.ack{"asset"}{"size"}.getInt(0) == 11
    check recorded.assetWrites == @[("fonts/big.ttf", "hello world")]
    check "up_1" notin recorded.chunkParts

  test "asset_put_chunk reports a hole as chunk_gap and refuses bad envelopes":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    check handleCloudVerb(ctx, %*{
      "type": "asset_put_chunk", "upload_id": "up_2", "offset": 0, "data": encode("abc"),
    }).ack{"ok"}.getBool(false) == true
    # Offset past the part's end: an earlier chunk was lost — restart, don't append.
    check handleCloudVerb(ctx, %*{
      "type": "asset_put_chunk", "upload_id": "up_2", "offset": 10, "data": encode("x"),
    }).ack{"error"}.getStr("") == "chunk_gap"
    for (message, error) in [
      (%*{"type": "asset_put_chunk", "offset": 0, "data": encode("x")}, "invalid_upload_id"),
      (%*{"type": "asset_put_chunk", "upload_id": "../evil", "offset": 0, "data": encode("x")}, "invalid_upload_id"),
      (%*{"type": "asset_put_chunk", "upload_id": "a".repeat(65), "offset": 0, "data": encode("x")}, "invalid_upload_id"),
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "data": encode("x")}, "invalid_offset"),
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": -1, "data": encode("x")}, "invalid_offset"),
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": "0", "data": encode("x")}, "invalid_offset"),
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": 0, "data": ""}, "invalid_data"),
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": 0, "data": "!!!"}, "invalid_data"),
      # The destination is checked on the final chunk, dot-directories included.
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": 0, "data": encode("x"),
          "complete": true}, "invalid_path"),
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": 0, "data": encode("x"),
          "complete": true, "path": ".thumbs/x.bin"}, "invalid_path"),
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": 0, "data": encode("x"),
          "complete": true, "path": "denied.bin"}, "invalid_path"),
      # Past the assembled-file ceiling.
      (%*{"type": "asset_put_chunk", "upload_id": "up_3", "offset": HubMaxChunkedUploadBytes,
          "data": encode("x")}, "too_large"),
    ]:
      check handleCloudVerb(ctx, message).ack{"error"}.getStr("") == error
    check recorded.assetWrites.len == 0

  test "asset write verbs never touch dot-directories":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    for message in [
      %*{"type": "asset_put", "path": ".frameos/scene_images/x.png", "data": encode("x")},
      %*{"type": "asset_mkdir", "path": ".thumbs/sub"},
      %*{"type": "asset_delete", "path": ".frameos"},
      %*{"type": "asset_rename", "src": "ok.bin", "dst": ".thumbs/ok.bin"},
      %*{"type": "asset_rename", "src": ".thumbs/x.jpg", "dst": "ok.bin"},
    ]:
      check handleCloudVerb(ctx, message).ack{"error"}.getStr("") == "invalid_path"
    check recorded.assetWrites.len == 0
    check recorded.assetMkdirs.len == 0
    check recorded.assetDeletes.len == 0
    check recorded.assetRenames.len == 0

  test "asset_mkdir, asset_delete and asset_rename dispatch and map errors":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    check handleCloudVerb(ctx, %*{
      "type": "asset_mkdir", "path": "albums/summer",
    }).ack{"ok"}.getBool(false) == true
    check recorded.assetMkdirs == @["albums/summer"]
    check handleCloudVerb(ctx, %*{
      "type": "asset_delete", "path": "photos/old.jpg",
    }).ack{"ok"}.getBool(false) == true
    check recorded.assetDeletes == @["photos/old.jpg"]
    check handleCloudVerb(ctx, %*{
      "type": "asset_delete", "path": "missing.bin",
    }).ack{"error"}.getStr("") == "not_found"
    check handleCloudVerb(ctx, %*{
      "type": "asset_rename", "src": "photos/cat.jpg", "dst": "photos/dog.jpg",
    }).ack{"ok"}.getBool(false) == true
    check recorded.assetRenames == @[("photos/cat.jpg", "photos/dog.jpg")]
    check handleCloudVerb(ctx, %*{
      "type": "asset_rename", "src": "", "dst": "x.bin",
    }).ack{"error"}.getStr("") == "invalid_path"

  test "reboot and restart_runtime use the injected implementations":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    check handleCloudVerb(ctx, %*{"type": "reboot"}).ack{"ok"}.getBool(false)
    check recorded.reboots == 1
    check handleCloudVerb(ctx, %*{"type": "restart_runtime"}).ack{"ok"}.getBool(false)
    check recorded.events.mapIt(it[0]) == @["restart"]

  test "notify_update_available triggers the injected upgrade, nothing else":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "type": "notify_update_available", "version": "9.9.9",
      "url": "https://evil.example.com/firmware.bin"})
    check reply.ack{"ok"}.getBool(false) == true
    check recorded.upgradeRequests == 1
    # The nudge only starts the device's own signed upgrade flow: nothing
    # else is dispatched or persisted, and there is no code path that could
    # fetch the injected URL.
    check recorded.events.len == 0
    check recorded.persistedSettings.len == 0
    check "notify_update_available" in auditedVerbs(recorded)

suite "interpreted scene payload validation":
  test "plain node-graph scenes validate":
    check validateInterpretedScenesPayload(%*[
      {"id": "a", "name": "A", "nodes": [], "edges": []}
    ]) == (true, "")

  test "malformed payloads are invalid_scenes":
    check validateInterpretedScenesPayload(newJNull()).error == "invalid_scenes"
    check validateInterpretedScenesPayload(%*[]).error == "invalid_scenes"
    check validateInterpretedScenesPayload(%*["nope"]).error == "invalid_scenes"

  test "nim sources without js are not_interpreted":
    check validateInterpretedScenesPayload(%*[
      {"id": "a", "name": "A", "edges": [],
       "nodes": [{"id": "1", "type": "app", "data": {"sources": {"app.nim": "x"}}}]}
    ]).error == "not_interpreted"

  test "js apps with generated nim wrappers pass":
    check validateInterpretedScenesPayload(%*[
      {"id": "a", "name": "A", "edges": [],
       "nodes": [{"id": "1", "type": "app",
                  "data": {"sources": {"app.ts": "y", "app.nim": "x"}}}]}
    ]).ok
