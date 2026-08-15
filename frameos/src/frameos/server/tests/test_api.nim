import unittest
import times
import os
import mummy
import tables
import json
import zippy
import locks

import ../api
import ../state
import ../../types

proc baseConfig(assetsPath = ""): FrameConfig =
  FrameConfig(
    name: "Unit Frame",
    mode: "web_only",
    frameHost: "localhost",
    framePort: 8787,
    frameAccess: "private",
    frameAccessKey: "test-key",
    frameAdminAuth: %*{},
    httpsProxy: HttpsProxyConfig(
      enable: true,
      port: 9443,
      exposeOnlyPort: true,
      serverCert: "server-cert",
      serverKey: "server-key",
    ),
    serverHost: "localhost",
    serverPort: 8989,
    serverApiKey: "api",
    width: 800,
    height: 480,
    rotate: 0,
    flip: "",
    scalingMode: "contain",
    device: "web_only",
    metricsInterval: 60,
    assetsPath: assetsPath,
    saveAssets: %*(false),
    timeZone: "Europe/Brussels",
    timeZoneUpdates: TimeZoneUpdatesConfig(enabled: false, hour: 4, url: "https://example.test/tz.json.gz"),
    network: NetworkConfig(networkCheck: false),
    mountpoints: MountpointsConfig(enabled: true, items: @[
      MountpointConfig(enabled: true, source: "//nas/photos", target: "/mnt/photos", username: "frame", password: "secret")
    ]),
    errorBehavior: ErrorBehaviorConfig(
      mode: "silent_retry",
      retrySeconds: 30,
      silentRetrySeconds: 15,
      silentRetryForever: true,
      silentWindowMinutes: 7,
      showErrorRetrySeconds: 20,
    ),
  )

suite "Server API helpers":
  test "url encoded parser decodes values":
    let parsed = parseUrlEncoded("name=Frame%20One&flag=true&empty=")
    check parsed["name"] == "Frame One"
    check parsed["flag"] == "true"
    check parsed["empty"] == ""

  test "if-modified-since handling for mummy headers":
    let referenceTime = parse("Wed, 21 Oct 2015 07:28:00 GMT", "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    let referenceUnix = referenceTime.toTime().toUnix().float
    var headers: mummy.HttpHeaders
    headers["If-Modified-Since"] = "Wed, 21 Oct 2015 07:28:00 GMT"
    check shouldReturnNotModified(headers, referenceUnix)

  test "frameApiPayload reflects config active connections and scene payload fallback":
    let tempRoot = getTempDir() / "frameos-api-frame-payload"
    createDir(tempRoot)
    let configPath = tempRoot / "frame.json"
    writeFile(configPath, """{
      "interval": 42,
      "backgroundColor": "#123456",
      "color": "#ffffff"
    }""")
    putEnv("FRAMEOS_CONFIG", configPath)

    let scenesGzPath = tempRoot / "scenes.json.gz"
    writeFile(scenesGzPath, compress("""[{"id":"scene/a"}]""", dataFormat = dfGzip))
    putEnv("FRAMEOS_SCENES_JSON", scenesGzPath)

    globalFrameConfig = baseConfig(tempRoot)
    let state = initConnectionsState()
    withLock state.lock:
      state.items.add(default(WebSocket))
      state.items.add(default(WebSocket))

    let payload = frameApiPayload(state)
    check payload{"interval"}.getFloat() == 42
    check payload{"max_http_response_bytes"}.getInt() == globalFrameConfig.maxHttpResponseBytes
    check payload{"background_color"}.getStr() == "#123456"
    check payload{"active_connections"}.getInt() == 2
    check payload{"scenes"}.kind == JArray
    check payload{"scenes"}.len == 1
    check payload{"frame_access_key"}.getStr() == ""
    check payload{"server_api_key"}.getStr() == ""
    check payload{"frame_admin_auth"}{"enabled"}.getBool() == false
    check payload{"https_proxy"}{"port"}.getInt() == 9443
    check payload{"https_proxy"}{"certs"}{"server"}.getStr() == ""
    check payload{"timezone"}.getStr() == "Europe/Brussels"
    check payload{"timezone_updater"}{"enabled"}.getBool() == false
    check payload{"error_behavior"}{"mode"}.getStr() == "silent_retry"
    check payload{"error_behavior"}{"silent_retry_forever"}.getBool() == true
    check payload{"mountpoints"}{"enabled"}.getBool() == true
    check payload{"mountpoints"}{"items"}[0]{"password"}.getStr() == ""

    let privilegedPayload = frameApiPayload(state, exposeSecrets = true)
    check privilegedPayload{"frame_access_key"}.getStr() == globalFrameConfig.frameAccessKey
    check privilegedPayload{"server_api_key"}.getStr() == globalFrameConfig.serverApiKey
    check privilegedPayload{"https_proxy"}{"certs"}{"server"}.getStr() == "server-cert"
    check privilegedPayload{"mountpoints"}{"items"}[0]{"password"}.getStr() == "secret"

    putEnv("FRAMEOS_SCENES_JSON", tempRoot / "invalid-scenes.json")
    writeFile(tempRoot / "invalid-scenes.json", "{not-json")
    let invalidScenesPayload = frameApiPayload(state)
    check invalidScenesPayload{"scenes"}.kind == JArray
    check invalidScenesPayload{"scenes"}.len == 0

suite "private-network elevation is not a bulk-savable setting":
  test "a config save cannot flip allowLocalNetworkAccess either way":
    # Both the cloud verb path and the admin page's frame save land in
    # frontendFramePayloadToRuntimeConfig. Neither may carry this field: it
    # only moves through the on-panel ceremony (frameos/local_access.nim).
    let existingOff = %*{"network": {"networkCheck": true, "allowLocalNetworkAccess": false}}
    let turnOn = %*{"network": {"networkCheck": true, "allowLocalNetworkAccess": true}}
    let elevated = frontendFramePayloadToRuntimeConfig(turnOn, existingOff)
    check elevated{"network"}{"allowLocalNetworkAccess"}.getBool() == false
    # Unrelated fields in the same object still save normally.
    check elevated{"network"}{"networkCheck"}.getBool() == true

    # And it cannot be revoked that way either, so a stale payload replayed by
    # the backend does not silently re-arm the deny mid-session.
    let existingOn = %*{"network": {"allowLocalNetworkAccess": true}}
    let turnOff = %*{"network": {"allowLocalNetworkAccess": false}}
    check frontendFramePayloadToRuntimeConfig(turnOff, existingOn){"network"}{
      "allowLocalNetworkAccess"}.getBool() == true

  test "a frame with no stored value does not gain one from a payload":
    let fresh = frontendFramePayloadToRuntimeConfig(
      %*{"network": {"allowLocalNetworkAccess": true}}, %*{})
    check not fresh{"network"}.hasKey("allowLocalNetworkAccess")

suite "no-op settings pushes are detectable":
  # The cloud's set_settings verb delivers the full allowlisted object on
  # every "push scenes & settings" click; frameApiUpdateChangesConfig is what
  # lets the hub client ack values already in effect without a config reload
  # (which re-inits the scene and re-renders the panel).
  test "an identical payload reports no change; a different one does":
    let dir = getTempDir() / "frameos-api-noop-test"
    createDir(dir)
    defer:
      removeDir(dir)
      delEnv("FRAMEOS_CONFIG")
    let configPath = dir / "frame.json"
    putEnv("FRAMEOS_CONFIG", configPath)
    # Runtime key names, exactly as frame.json stores them — note timeZone,
    # not timezone: the merge maps the API's snake_case onto these, and a
    # fixture with the wrong casing makes the merge ADD a key, which reads
    # (correctly) as a change.
    writeFile(configPath, $(%*{
      "name": "Kitchen", "rotate": 90, "interval": 300.0,
      "scalingMode": "cover", "timeZone": "Europe/Brussels", "debug": false,
    }))

    check not frameApiUpdateChangesConfig(%*{
      "name": "Kitchen", "rotate": 90, "interval": 300.0,
      "scaling_mode": "cover", "timezone": "Europe/Brussels", "debug": false,
    })
    check frameApiUpdateChangesConfig(%*{"name": "Hallway"})
    check frameApiUpdateChangesConfig(%*{"rotate": 180})
    # Empty and malformed payloads change nothing, by definition.
    check not frameApiUpdateChangesConfig(%*{})
    check not frameApiUpdateChangesConfig(newJNull())

  test "the probe agrees with what persistFrameApiUpdate then writes":
    # The probe runs the SAME merge as the persist — this pins that: a
    # payload the probe calls unchanged must leave the runtime-visible config
    # identical after a real persist, and vice versa. `frameApi` is excluded
    # from the comparison on both sides: it is sync bookkeeping the merge
    # rewrites on every call (a payload echo plus a fresh revision stamp),
    # which is exactly why the probe has to ignore it too.
    proc runtimeVisible(path: string): JsonNode =
      result = parseJson(readFile(path))
      if result.hasKey("frameApi"):
        result.delete("frameApi")

    let dir = getTempDir() / "frameos-api-noop-roundtrip"
    createDir(dir)
    defer:
      removeDir(dir)
      delEnv("FRAMEOS_CONFIG")
    let configPath = dir / "frame.json"
    putEnv("FRAMEOS_CONFIG", configPath)
    writeFile(configPath, $(%*{"name": "Kitchen", "rotate": 90}))

    let unchanged = %*{"name": "Kitchen", "rotate": 90}
    check not frameApiUpdateChangesConfig(unchanged)
    let before = runtimeVisible(configPath)
    persistFrameApiUpdate(unchanged)
    check runtimeVisible(configPath) == before

    let changed = %*{"rotate": 270}
    check frameApiUpdateChangesConfig(changed)
    persistFrameApiUpdate(changed)
    check runtimeVisible(configPath){"rotate"}.getInt(0) == 270
    check not frameApiUpdateChangesConfig(changed)
