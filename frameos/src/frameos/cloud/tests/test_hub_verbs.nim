import std/[json, sequtils, strutils, unittest]

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
    check recorded.persistedChecksums == @["sum-1"]
    check ctx.scenesChecksum == "sum-1"
    check reply.extra.len == 1
    check reply.extra[0]{"type"}.getStr("") == "scene_ack"
    check reply.extra[0]{"checksum"}.getStr("") == "sum-1"
    check reply.extra[0]{"active_scene"}.getStr("") == "uploaded/scene1"

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

  test "reboot and restart_runtime use the injected implementations":
    let recorded = Recorded()
    let ctx = makeContext(recorded)
    check handleCloudVerb(ctx, %*{"type": "reboot"}).ack{"ok"}.getBool(false)
    check recorded.reboots == 1
    check handleCloudVerb(ctx, %*{"type": "restart_runtime"}).ack{"ok"}.getBool(false)
    check recorded.events.mapIt(it[0]) == @["restart"]

  test "notify_update_available is advisory only":
    let recorded = Recorded()
    let reply = handleCloudVerb(makeContext(recorded), %*{
      "type": "notify_update_available", "version": "9.9.9",
      "url": "https://evil.example.com/firmware.bin"})
    check reply.ack{"ok"}.getBool(false) == true
    # Nothing dispatched, nothing persisted — and there is no code path that
    # could fetch the injected URL.
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
