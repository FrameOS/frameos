import json, pixie, os, strutils
import frameos/types
import lib/tz

proc setConfigDefaults*(config: var FrameConfig) =
  if config.serverPort == 0: config.serverPort = 8989
  if config.width == 0: config.width = 1920
  if config.height == 0: config.height = 1080
  if config.device == "": config.device = "web_only"
  if config.metricsInterval == 0: config.metricsInterval = 60
  if config.rotate == 0: config.rotate = 0
  if config.flip == "": config.flip = ""
  if config.scalingMode == "": config.scalingMode = "cover"
  if config.framePort == 0: config.framePort = 8787
  if config.frameHost == "": config.frameHost = "localhost"
  if config.frameAccess == "": config.frameAccess = "private"
  if config.name == "": config.name = config.frameHost
  if config.timeZone == "": config.timeZone = detectSystemTimeZone()

proc loadSchedule*(data: JsonNode): FrameSchedule =
  result = FrameSchedule(events: @[])
  if data == nil or data.kind != JObject or (not data.contains("colors")) or data["events"] == nil or data[
      "events"].kind != JArray:
    return result
  for event in data["events"].items:
    result.events.add(ScheduledEvent(
      id: event{"id"}.getStr(),
      minute: event{"minute"}.getInt(),
      hour: event{"hour"}.getInt(),
      weekday: event{"weekday"}.getInt(),
      event: event{"event"}.getStr(),
      payload: event{"payload"}
    ))

proc loadGPIOButtons*(data: JsonNode): seq[GPIOButton] =
  result = @[]
  if data == nil or data.kind != JArray:
    return result
  for button in data.items:
    result.add(GPIOButton(
      pin: button{"pin"}.getInt(),
      label: button{"label"}.getStr(),
    ))

proc loadControlCode*(data: JsonNode): ControlCode =
  if data == nil or data.kind != JObject:
    result = ControlCode(enabled: false)
  else:
    result = ControlCode(
      enabled: data{"enabled"}.getBool(),
      position: data{"position"}.getStr("top-right"),
      size: data{"size"}.getFloat(2),
      padding: data{"padding"}.getInt(1),
      offsetX: data{"offsetX"}.getInt(0),
      offsetY: data{"offsetY"}.getInt(0),
      qrCodeColor: try: parseHtmlColor(data{"qrCodeColor"}.getStr("#000000")) except: parseHtmlColor("#000000"),
      backgroundColor: try: parseHtmlColor(data{"backgroundColor"}.getStr("#ffffff")) except: parseHtmlColor("#ffffff"),
    )

proc loadNetwork*(data: JsonNode): NetworkConfig =
  if data == nil or data.kind != JObject:
    result = NetworkConfig(networkCheck: false)
  else:
    result = NetworkConfig(
      networkCheck: data{"networkCheck"}.getBool(),
      networkCheckTimeoutSeconds: data{"networkCheckTimeoutSeconds"}.getFloat(30),
      networkCheckUrl: data{"networkCheckUrl"}.getStr("https://networkcheck.frameos.net"),
      wifiHotspot: if data{"networkCheck"}.getBool(): data{"wifiHotspot"}.getStr("disabled") else: "disabled",
      wifiHotspotSsid: data{"wifiHotspotSsid"}.getStr("FrameOS-Setup"),
      wifiHotspotPassword: data{"wifiHotspotPassword"}.getStr("frame1234"),
      wifiHotspotTimeoutSeconds: data{"wifiHotspotTimeoutSeconds"}.getFloat(300),
    )

proc loadDeviceConfig*(data: JsonNode): DeviceConfig =
  var headers: seq[HttpHeaderPair] = @[]
  if data != nil and data.kind == JObject and data.hasKey("uploadHeaders") and data["uploadHeaders"].kind == JArray:
    for header in data["uploadHeaders"].items:
      if header.kind == JObject:
        let name = header{"name"}.getStr("").strip()
        let value = header{"value"}.getStr("")
        if name.len > 0:
          headers.add(HttpHeaderPair(name: name, value: value))

  if data == nil or data.kind != JObject:
    result = DeviceConfig(
      vcom: 0,
      httpUploadUrl: "",
      httpUploadHeaders: headers,
    )
  else:
    result = DeviceConfig(
      vcom: data{"vcom"}.getFloat(0),
      httpUploadUrl: data{"uploadUrl"}.getStr(""),
      httpUploadHeaders: headers,
    )

proc loadPalette*(data: JsonNode): PaletteConfig =
  result = PaletteConfig(colors: @[])
  if data != nil and data.kind == JObject and data.contains("colors") and data["colors"] != nil and data[
      "colors"].kind == JArray:
    for color in data["colors"].items:
      try:
        let color = parseHtmlColor(color.getStr())
        result.colors.add((
          int(color.r * 255),
          int(color.g * 255),
          int(color.b * 255),
        ))
      except:
        echo "Warning: Invalid color in palette: ", color.getStr()
        result.colors = @[]
        return result

proc loadAgent*(data: JsonNode): AgentConfig =
  if data == nil or data.kind != JObject:
    result = AgentConfig(agentEnabled: false)
  else:
    result = AgentConfig(
      agentEnabled: data{"agentEnabled"}.getBool(),
      agentRunCommands: data{"agentRunCommands"}.getBool(),
      agentSharedSecret: data{"agentSharedSecret"}.getStr(""),
    )

proc getConfigFilename*(): string =
  result = getEnv("FRAMEOS_CONFIG")
  if result == "":
    result = "./frame.json"

proc loadConfig*(): FrameConfig =
  let data = parseFile(getConfigFilename())
  # TODO: switch to jsony
  result = FrameConfig(
    name: data{"name"}.getStr(),
    mode: data{"mode"}.getStr("rpios"),
    serverHost: data{"serverHost"}.getStr(),
    serverPort: data{"serverPort"}.getInt(),
    serverApiKey: data{"serverApiKey"}.getStr(),
    frameHost: data{"frameHost"}.getStr(),
    framePort: data{"framePort"}.getInt(),
    frameAccess: data{"frameAccess"}.getStr(),
    frameAccessKey: data{"frameAccessKey"}.getStr(),
    width: data{"width"}.getInt(),
    height: data{"height"}.getInt(),
    device: data{"device"}.getStr(),
    deviceConfig: loadDeviceConfig(data{"deviceConfig"}),
    metricsInterval: data{"metricsInterval"}.getFloat(),
    rotate: data{"rotate"}.getInt(),
    flip: data{"flip"}.getStr(""),
    scalingMode: data{"scalingMode"}.getStr(),
    settings: data{"settings"},
    assetsPath: data{"assetsPath"}.getStr("/srv/assets"),
    saveAssets: if data{"saveAssets"} == nil: %*(false) else: data{"saveAssets"},
    logToFile: data{"logToFile"}.getStr(),
    debug: data{"debug"}.getBool() or commandLineParams().contains("--debug"),
    timeZone: data{"timeZone"}.getStr(""),
    schedule: loadSchedule(data{"schedule"}),
    gpioButtons: loadGPIOButtons(data{"gpioButtons"}),
    controlCode: loadControlCode(data{"controlCode"}),
    network: loadNetwork(data{"network"}),
    palette: loadPalette(data{"palette"}),
  )
  if result.assetsPath.endswith("/"):
    result.assetsPath = result.assetsPath.strip(leading = false, trailing = true, chars = {'/'})
  setConfigDefaults(result)

proc updateSchedule(target: var FrameSchedule, source: FrameSchedule) =
  if target == nil:
    target = source
  else:
    target.events = source.events

proc updateFrameConfigFrom*(target: FrameConfig, source: FrameConfig) =
  if target == nil:
    return
  target.name = source.name
  target.mode = source.mode
  target.serverHost = source.serverHost
  target.serverPort = source.serverPort
  target.serverApiKey = source.serverApiKey
  target.frameHost = source.frameHost
  target.framePort = source.framePort
  target.frameAccessKey = source.frameAccessKey
  target.frameAccess = source.frameAccess
  target.width = source.width
  target.height = source.height
  target.device = source.device
  target.deviceConfig = source.deviceConfig
  target.metricsInterval = source.metricsInterval
  target.rotate = source.rotate
  target.flip = source.flip
  target.scalingMode = source.scalingMode
  target.settings = source.settings
  target.assetsPath = source.assetsPath
  target.saveAssets = source.saveAssets
  target.logToFile = source.logToFile
  target.debug = source.debug
  target.timeZone = source.timeZone
  target.gpioButtons = source.gpioButtons
  target.controlCode = source.controlCode
  target.network = source.network
  target.agent = source.agent
  target.palette = source.palette
  updateSchedule(target.schedule, source.schedule)
