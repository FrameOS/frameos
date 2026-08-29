## The conformance corpus (docs/cloud-frames-fixtures.json) against the Linux
## runtime: every `settings` case through the real set_settings handler for
## the linux verdict and through the contract walker for both profiles; every
## `verbs` case through the dispatcher. The ESP32 firmware and the cloud run
## the same file — this is what keeps three implementations one contract.

import std/[json, os, unittest]

import ../contract
import ../hub_client
import ../../types

const FixturesPath = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." /
  "docs" / "cloud-frames-fixtures.json"

type Recorded = ref object
  persisted: seq[JsonNode]
  events: seq[string]

proc makeContext(recorded: Recorded, scopes: seq[string] = @[]): CloudVerbContext =
  CloudVerbContext(
    frameConfig: FrameConfig(mode: "test", device: "web_only", width: 800, height: 480),
    scopes: scopes,
    sendEventFn: proc(event: string, payload: JsonNode): bool {.gcsafe.} =
      recorded.events.add(event)
      true,
    persistSettingsFn: proc(payload: JsonNode) {.gcsafe.} =
      recorded.persisted.add(payload),
    getLogsFn: proc(): JsonNode {.gcsafe.} = %*[],
    getMetricsFn: proc(): JsonNode {.gcsafe.} = %*[],
    getStateFn: proc(): JsonNode {.gcsafe.} = %*{"states": {}},
    # The asset family answers unsupported_verb without a callback; give the
    # stub the minimum so "is every contract verb served" means served.
    listAssetsFn: proc(): JsonNode {.gcsafe.} = %*{"assets": []},
    readAssetFn: proc(path: string, thumb: bool): AssetReadResult {.gcsafe.} =
      AssetReadResult(error: "not_found"),
    getImageFn: proc(): AssetReadResult {.gcsafe.} = AssetReadResult(error: "no_image"),
    writeAssetFn: proc(path: string, data: string): JsonNode {.gcsafe.} = %*{},
    putAssetChunkFn: proc(uploadId: string, offset: BiggestInt, data: string,
                          finalPath: string): JsonNode {.gcsafe.} = %*{},
    mkdirAssetFn: proc(path: string) {.gcsafe.} = discard,
    deleteAssetFn: proc(path: string) {.gcsafe.} = discard,
    renameAssetFn: proc(src: string, dst: string) {.gcsafe.} = discard,
    refreshServiceSettingsFn: proc() {.gcsafe.} = discard,
    requestUpgradeFn: proc() {.gcsafe.} = discard,
    rebootFn: proc() {.gcsafe.} = discard,
    auditFn: proc(payload: JsonNode) {.gcsafe.} = discard,
  )

let fixtures = parseFile(FixturesPath)

suite "cloud verb contract fixtures":
  test "every settings case gives the contract's verdict on both profiles":
    var count = 0
    for fixture in fixtures["settings"]:
      let name = fixture["name"].getStr()
      for profile in ["linux", "esp32"]:
        let expected = fixture["expect"][profile].getStr()
        let verdict = checkContractSettings(profile, fixture["settings"])
        checkpoint(name & " [" & profile & "]: expected " & expected & ", got " &
                   (if verdict.len == 0: "ok" else: verdict))
        check (if verdict.len == 0: "ok" else: verdict) == expected
        inc count
    check count == fixtures["settings"].len * 2

  test "the linux verdict is what the set_settings verb answers":
    for fixture in fixtures["settings"]:
      let recorded = Recorded()
      let expected = fixture["expect"]["linux"].getStr()
      let reply = handleCloudVerb(makeContext(recorded),
        %*{"id": "1", "type": "set_settings", "settings": fixture["settings"]})
      checkpoint(fixture["name"].getStr())
      if expected == "ok":
        check reply.ack{"ok"}.getBool(false) == true
        check recorded.persisted.len == 1
      else:
        check reply.ack{"error"}.getStr("") == expected
        check recorded.persisted.len == 0

  test "verb cases":
    for fixture in fixtures["verbs"]:
      var scopes: seq[string] = @[]
      if fixture.hasKey("scopes"):
        for scope in fixture["scopes"]:
          scopes.add(scope.getStr())
      let reply = handleCloudVerb(makeContext(Recorded(), scopes),
        %*{"id": "1", "type": fixture["type"].getStr()})
      checkpoint(fixture["name"].getStr())
      check reply.ack{"error"}.getStr("") == fixture["expect"].getStr()

  test "the runtime's allowlist is the contract's linux profile":
    check CLOUD_SETTINGS_ALLOWLIST == profileAllowlist("linux")
    check "deep_sleep" notin CLOUD_SETTINGS_ALLOWLIST
    check "flip" in CLOUD_SETTINGS_ALLOWLIST
    check CLOUD_SETTINGS_RESTART_KEYS == @["palette", "device_config", "gpio_buttons"]

  test "every verb the dispatcher serves is in the contract, and vice versa":
    for spec in CloudContractVerbs:
      let reply = handleCloudVerb(makeContext(Recorded(),
        @["telemetry:logs", "telemetry:metrics", "settings:services"]),
        %*{"id": "1", "type": spec.verb})
      checkpoint(spec.verb)
      check reply.ack{"error"}.getStr("") notin ["unknown_verb", "unsupported_verb"]
    check contractVerb("get_logs").scope == "telemetry:logs"
    check contractVerb("set_scenes").content == true
    check contractVerb("shell").known == false

  test "the wire limits the runtime enforces are the contract's":
    check contractLimit("assetMaxFileBytes", "linux") == HubMaxAssetFileBytes
    check contractLimit("assetPutMaxBytes", "linux") == HubMaxAssetUploadBytes
    check contractLimit("chunkedUploadMaxBytes", "linux") == HubMaxChunkedUploadBytes
    check contractLimit("uploadIdMaxLen", "linux") == HubMaxUploadIdLen
    check contractLimit("assetListMaxEntries", "linux") == HubMaxAssetListEntries

  test "formats":
    check isIanaZone("UTC")
    check isIanaZone("America/Argentina/Buenos_Aires")
    check isIanaZone("Etc/GMT+2")
    check not isIanaZone("")
    check not isIanaZone("/Europe")
    check not isIanaZone("Europe/")
    check not isIanaZone("Europe//Berlin")
    check not isIanaZone("1Europe")
    check isHtmlHexColor("#0a0B0c")
    check not isHtmlHexColor("#0a0")
    check isGpioLabel(" next ")
    check not isGpioLabel("a:b")
