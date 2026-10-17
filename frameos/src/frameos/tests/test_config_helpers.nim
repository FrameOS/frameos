import std/[json, unittest]
import pixie
import ../config
import ../types
import ../utils/image

suite "config parsing (jsony)":
  test "setConfigDefaults populates key defaults":
    var config = FrameConfig(
      serverPort: 0,
      width: 0,
      height: 0,
      device: "",
      metricsInterval: -1,
      framePort: 0,
      frameHost: "",
      httpsProxy: nil,
      frameAccess: "",
      name: "",
      timeZone: ""
    )

    setConfigDefaults(config)

    check config.serverPort == 8989
    check config.width == 1920
    check config.height == 1080
    check config.device == "web_only"
    check config.metricsInterval == 60
    check config.maxHttpResponseBytes == DefaultMaxHttpResponseBytes
    check config.framePort == 8787
    check config.frameHost == "localhost"
    check config.httpsProxy != nil
    check config.httpsProxy.port == 8443
    check config.frameAccess == "private"
    check config.name == "localhost"
    check config.timeZone.len > 0
    check config.network != nil
    check config.errorBehavior != nil and config.errorBehavior.mode == "show_error_retry"
    check config.js != nil and config.js.assetSandbox == "frame"
    check config.deviceConfig != nil and config.deviceConfig.pins.rst == -1
    check config.saveAssets == %*false
    check config.assetsPath == "/srv/assets"

  test "setConfigDefaults keeps metricsInterval 0 (the disabled value)":
    var config = FrameConfig(metricsInterval: 0)
    setConfigDefaults(config)
    check config.metricsInterval == 0

  test "an empty document is a complete default config":
    let config = parseFrameConfig("{}")
    check config.mode == "rpios"
    check config.serverSendLogs == true
    check config.metricsInterval == 60
    check config.timeZoneUpdates.enabled == true
    check config.timeZoneUpdates.hour == 3
    check config.timeZoneUpdates.url == "https://tz.frameos.net/tzdata.json.gz"
    check config.controlCode.enabled == false
    check config.controlCode.position == "top-right"
    check config.controlCode.size == 2
    check config.network.networkCheckTimeoutSeconds == 30
    check config.network.wifiHotspot == "disabled"
    check config.mountpoints.enabled == false and config.mountpoints.items.len == 0
    check config.schedule.events.len == 0
    check config.gpioButtons.len == 0
    check config.palette.colors.len == 0
    check config.frameAdminAuth == %*{}
    check config.settings == nil

  test "unknown keys are ignored":
    let config = parseFrameConfig("""{"imageEngine": "imagemagick", "frameosVersion": "2026.8.30", "nope": {"a": 1}}""")
    check config.width == 1920

  test "schedule parses events and tolerates null":
    let config = parseFrameConfig($(%*{"schedule": {"events": [{
      "id": "e1", "minute": 5, "hour": 6, "weekday": 1, "event": "refresh", "payload": {"k": "v"}
    }]}}))
    check config.schedule.events.len == 1
    check config.schedule.events[0].id == "e1"
    check config.schedule.events[0].hour == 6
    check config.schedule.events[0].payload{"k"}.getStr() == "v"
    check parseFrameConfig("""{"schedule": null}""").schedule.events.len == 0
    check parseFrameConfig("""{"schedule": {}}""").schedule.events.len == 0

  test "deviceConfig maps upload keys, trims headers, keeps unknown pins default":
    let config = parseFrameConfig($(%*{"deviceConfig": {
      "vcom": -1.5,
      "partial": true,
      "partialMaxAreaPercent": 12.5,
      "partialMaxRefreshesBeforeFull": 9,
      "uploadUrl": "http://upload.local",
      "uploadHeaders": [
        {"name": " Authorization ", "value": "Bearer abc"},
        {"name": "", "value": "ignored"},
        {"name": "   ", "value": "ignored"}
      ],
      "pins": {"rst": 17, "sck": 11},
      "renderMode": "local",
      "psramMB": 8
    }}))
    let cfg = config.deviceConfig
    check cfg.vcom == -1.5
    check cfg.partial == true
    check cfg.partialMaxAreaPercent == 12.5
    check cfg.partialMaxRefreshesBeforeFull == 9
    check cfg.httpUploadUrl == "http://upload.local"
    check cfg.httpUploadHeaders.len == 1
    check cfg.httpUploadHeaders[0].name == "Authorization"
    check cfg.httpUploadHeaders[0].value == "Bearer abc"
    check cfg.pins.rst == 17
    check cfg.pins.sclk == 11
    check cfg.pins.dc == -1
    check parseFrameConfig("""{"deviceConfig": {}}""").deviceConfig.partial == false
    check parseFrameConfig("""{"deviceConfig": {}}""").deviceConfig.pins.cs == -1

  test "lenient scalars: quoted numbers, float ints, string booleans":
    # The SPA's on-device save posts its form values verbatim: control_code
    # enabled as 'true', sizes as text, vcom as text.
    let config = parseFrameConfig("""{
      "framePort": "8788",
      "width": 800.0,
      "metricsInterval": "30",
      "debug": "true",
      "deviceConfig": {"vcom": "-1.25", "partial": "false"},
      "controlCode": {"enabled": "true", "size": "3", "padding": "2", "offsetX": "-4"},
      "rotate": null,
      "flip": null,
      "serverSendLogs": 1
    }""")
    check config.framePort == 8788
    check config.width == 800
    check config.metricsInterval == 30
    check config.debug == true
    check config.deviceConfig.vcom == -1.25
    check config.deviceConfig.partial == false
    check config.controlCode.enabled == true
    check config.controlCode.size == 3
    check config.controlCode.padding == 2
    check config.controlCode.offsetX == -4
    check config.rotate == 0
    check config.flip == ""
    check config.serverSendLogs == true

  test "unreadable scalars leave the default instead of failing the load":
    let config = parseFrameConfig("""{"width": "wide", "debug": {"x": 1}, "rotate": [90], "name": 42, "flip": true}""")
    check config.width == 1920
    check config.debug == false
    check config.rotate == 0
    check config.name == "42"
    check config.flip == "true"

  test "malformed JSON is fatal":
    expect CatchableError:
      discard parseFrameConfig("""{"width": """)

  test "network keeps hotspot setting independent of network checks":
    let disabled = parseFrameConfig("""{"network": {"networkCheck": false, "wifiHotspot": "bootOnly"}}""").network
    check disabled.networkCheck == false
    check disabled.wifiHotspot == "bootOnly"
    check disabled.networkCheckUrl == "https://networkcheck.frameos.net"

    let enabled = parseFrameConfig("""{"network": {"networkCheck": true, "wifiHotspot": "enabled"}}""").network
    check enabled.networkCheck == true
    check enabled.wifiHotspot == "enabled"
    check parseFrameConfig("""{"network": {"networkCheck": true}}""").network.wifiHotspot == "disabled"
    check parseFrameConfig("""{"network": null}""").network.wifiHotspot == "disabled"

  test "palette parses html colors and empties on an invalid one":
    let valid = parseFrameConfig("""{"palette": {"name": "x", "colors": ["#ffffff", "#000000"]}}""").palette
    check valid.colors.len == 2
    check valid.colors[0] == (255, 255, 255)
    check parseFrameConfig("""{"palette": {"colors": ["#ffffff", "not-a-color"]}}""").palette.colors.len == 0
    check parseFrameConfig("""{"palette": {}}""").palette.colors.len == 0
    check parseFrameConfig("""{"palette": null}""").palette.colors.len == 0

  test "control code colours default when unreadable":
    let code = parseFrameConfig("""{"controlCode": {"enabled": true, "qrCodeColor": "", "backgroundColor": "#ff0000"}}""").controlCode
    check code.enabled == true
    check code.qrCodeColor.toHtmlHex() == "#000000"
    check code.backgroundColor.toHtmlHex() == "#FF0000"

  test "mountpoints strip paths, default enabled, drop null items":
    let mounts = parseFrameConfig("""{"mountpoints": {"enabled": true, "items": [
      {"source": " //nas/photos ", "target": "/mnt/photos ", "options": " vers=3.0 "}, null
    ]}}""").mountpoints
    check mounts.enabled == true
    check mounts.items.len == 1
    check mounts.items[0].enabled == true
    check mounts.items[0].source == "//nas/photos"
    check mounts.items[0].target == "/mnt/photos"
    check mounts.items[0].options == "vers=3.0"

  test "js runtime keeps -1 sentinels and validates the sandbox":
    check parseFrameConfig("{}").js.executionTimeoutMs == -1
    let js = parseFrameConfig("""{"js": {"executionTimeoutMs": 500, "assetSandbox": "bogus"}}""").js
    check js.executionTimeoutMs == 500
    check js.memoryLimitMb == -1
    check js.assetSandbox == "frame"

  test "assetsPath loses its trailing slash and defaults when empty":
    check parseFrameConfig("""{"assetsPath": "/data/assets/"}""").assetsPath == "/data/assets"
    check parseFrameConfig("""{"assetsPath": ""}""").assetsPath == "/srv/assets"
    check parseFrameConfig("""{"assetsPath": null}""").assetsPath == "/srv/assets"

  test "updateFrameConfigFrom updates the object every holder shares":
    let target = FrameConfig(
      name: "old",
      serverPort: 1,
      schedule: FrameSchedule(events: @[ScheduledEvent(id: "old-event")])
    )
    let alias = target
    let source = FrameConfig(
      name: "new",
      serverPort: 2,
      schedule: FrameSchedule(events: @[ScheduledEvent(id: "new-event")])
    )

    updateFrameConfigFrom(target, source)

    check alias.name == "new"
    check alias.serverPort == 2
    check alias.schedule.events.len == 1
    check alias.schedule.events[0].id == "new-event"
