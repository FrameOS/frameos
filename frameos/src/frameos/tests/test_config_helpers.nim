import std/[json, unittest]
import ../config
import ../types

suite "config helper loaders":
  test "setConfigDefaults populates key defaults":
    var config = FrameConfig(
      serverPort: 0,
      width: 0,
      height: 0,
      device: "",
      metricsInterval: 0,
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
    check config.framePort == 8787
    check config.frameHost == "localhost"
    check config.httpsProxy != nil
    check config.httpsProxy.port == 8443
    check config.frameAccess == "private"
    check config.name == "localhost"
    check config.timeZone.len > 0

  test "loadSchedule currently requires colors key and parses events":
    let eventNode = %*{
      "id": "e1",
      "minute": 5,
      "hour": 6,
      "weekday": 1,
      "event": "refresh",
      "payload": {"k": "v"}
    }

    let withoutColors = loadSchedule(%*{"events": [eventNode]})
    check withoutColors.events.len == 0

    let withColors = loadSchedule(%*{"colors": [], "events": [eventNode]})
    check withColors.events.len == 1
    check withColors.events[0].id == "e1"
    check withColors.events[0].payload{"k"}.getStr() == "v"

  test "loadDeviceConfig trims and filters upload headers":
    let cfg = loadDeviceConfig(%*{
      "vcom": -1.5,
      "uploadUrl": "http://upload.local",
      "uploadHeaders": [
        {"name": " Authorization ", "value": "Bearer abc"},
        {"name": "", "value": "ignored"},
        {"name": "   ", "value": "ignored"}
      ]
    })

    check cfg.vcom == -1.5
    check cfg.httpUploadUrl == "http://upload.local"
    check cfg.httpUploadHeaders.len == 1
    check cfg.httpUploadHeaders[0].name == "Authorization"
    check cfg.httpUploadHeaders[0].value == "Bearer abc"

  test "loadNetwork keeps hotspot disabled when network checks are disabled":
    let disabled = loadNetwork(%*{"networkCheck": false, "wifiHotspot": "enabled"})
    check disabled.networkCheck == false
    check disabled.wifiHotspot == "disabled"

    let enabled = loadNetwork(%*{"networkCheck": true, "wifiHotspot": "enabled"})
    check enabled.networkCheck == true
    check enabled.wifiHotspot == "enabled"

  test "loadPalette returns empty palette on invalid color":
    let valid = loadPalette(%*{"colors": ["#ffffff", "#000000"]})
    check valid.colors.len == 2

    let invalid = loadPalette(%*{"colors": ["#ffffff", "not-a-color"]})
    check invalid.colors.len == 0

  test "updateFrameConfigFrom replaces schedule events":
    let target = FrameConfig(
      name: "old",
      serverPort: 1,
      schedule: FrameSchedule(events: @[ScheduledEvent(id: "old-event")])
    )
    let source = FrameConfig(
      name: "new",
      serverPort: 2,
      schedule: FrameSchedule(events: @[ScheduledEvent(id: "new-event")])
    )

    updateFrameConfigFrom(target, source)

    check target.name == "new"
    check target.serverPort == 2
    check target.schedule.events.len == 1
    check target.schedule.events[0].id == "new-event"
