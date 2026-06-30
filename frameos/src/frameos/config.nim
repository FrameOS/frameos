import json, pixie, os, strutils
import zippy
import frameos/hal/files
import frameos/types
import frameos/utils/image
import lib/tz

proc setConfigDefaults*(config: var FrameConfig) =
  if config.serverPort == 0: config.serverPort = 8989
  if config.width == 0: config.width = 1920
  if config.height == 0: config.height = 1080
  if config.device == "": config.device = "web_only"
  if config.metricsInterval == 0: config.metricsInterval = 60
  if config.maxHttpResponseBytes <= 0: config.maxHttpResponseBytes = DefaultMaxHttpResponseBytes
  if config.rotate == 0: config.rotate = 0
  if config.flip == "": config.flip = ""
  if config.scalingMode == "": config.scalingMode = "cover"
  if config.imageEngine notin ["", "pixie", "imagemagick"]: config.imageEngine = ""
  if config.framePort == 0: config.framePort = 8787
  if config.frameHost == "": config.frameHost = "localhost"
  if config.httpsProxy == nil: config.httpsProxy = HttpsProxyConfig()
  if config.httpsProxy.port == 0: config.httpsProxy.port = 8443
  if config.frameAccess == "": config.frameAccess = "private"
  if config.name == "": config.name = config.frameHost
  if config.network == nil: config.network = NetworkConfig(networkCheck: false)
  if config.agent == nil: config.agent = AgentConfig(agentEnabled: false)
  if config.mountpoints == nil: config.mountpoints = MountpointsConfig(enabled: false, items: @[])
  if config.errorBehavior == nil: config.errorBehavior = ErrorBehaviorConfig(mode: "show_error_retry")
  if config.errorBehavior.mode notin ["safe_mode", "show_error_retry", "silent_retry"]:
    config.errorBehavior.mode = "show_error_retry"
  if config.errorBehavior.retrySeconds <= 0: config.errorBehavior.retrySeconds = 60
  if config.errorBehavior.silentRetrySeconds <= 0: config.errorBehavior.silentRetrySeconds = 60
  if config.errorBehavior.silentWindowMinutes <= 0: config.errorBehavior.silentWindowMinutes = 10
  if config.errorBehavior.showErrorRetrySeconds <= 0: config.errorBehavior.showErrorRetrySeconds = 60
  if config.timeZone == "": config.timeZone = detectSystemTimeZone()
  if config.timeZoneUpdates == nil:
    config.timeZoneUpdates = TimeZoneUpdatesConfig(enabled: true, hour: 3, url: "https://tz.frameos.net/tzdata.json.gz")
  if config.timeZoneUpdates.hour < 0 or config.timeZoneUpdates.hour > 23:
    config.timeZoneUpdates.hour = 3
  if config.timeZoneUpdates.url == "":
    config.timeZoneUpdates.url = "https://tz.frameos.net/tzdata.json.gz"

proc loadSchedule*(data: JsonNode): FrameSchedule =
  result = FrameSchedule(events: @[])
  if data == nil or data.kind != JObject or (not data.contains("events")) or data["events"] == nil or data[
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

  proc loadPins(data: JsonNode): PinOverrides =
    result = PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1)
    if data != nil and data.kind == JObject:
      result.rst = data{"rst"}.getInt(-1)
      result.dc = data{"dc"}.getInt(-1)
      result.cs = data{"cs"}.getInt(-1)
      result.busy = data{"busy"}.getInt(-1)
      result.sclk = data{"sclk"}.getInt(data{"sck"}.getInt(-1))
      result.mosi = data{"mosi"}.getInt(-1)
      result.pwr = data{"pwr"}.getInt(-1)

  if data == nil or data.kind != JObject:
    result = DeviceConfig(
      vcom: 0,
      partial: false,
      partialMaxAreaPercent: 0.0,
      partialMaxRefreshesBeforeFull: 0,
      httpUploadUrl: "",
      httpUploadHeaders: headers,
      pins: loadPins(nil),
    )
  else:
    result = DeviceConfig(
      vcom: data{"vcom"}.getFloat(0),
      partial: data{"partial"}.getBool(false),
      partialMaxAreaPercent: data{"partialMaxAreaPercent"}.getFloat(0.0),
      partialMaxRefreshesBeforeFull: data{"partialMaxRefreshesBeforeFull"}.getInt(0),
      httpUploadUrl: data{"uploadUrl"}.getStr(""),
      httpUploadHeaders: headers,
      pins: loadPins(data{"pins"}),
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

proc loadMountpoints*(data: JsonNode): MountpointsConfig =
  result = MountpointsConfig(enabled: false, items: @[])
  if data == nil or data.kind != JObject:
    return

  result.enabled = data{"enabled"}.getBool()
  let items = data{"items"}
  if items == nil or items.kind != JArray:
    return

  for item in items.items:
    if item == nil or item.kind != JObject:
      continue
    result.items.add(MountpointConfig(
      enabled: item{"enabled"}.getBool(true),
      source: item{"source"}.getStr("").strip(),
      target: item{"target"}.getStr("").strip(),
      username: item{"username"}.getStr(""),
      password: item{"password"}.getStr(""),
      domain: item{"domain"}.getStr(""),
      options: item{"options"}.getStr("").strip(),
    ))

proc loadErrorBehavior*(data: JsonNode): ErrorBehaviorConfig =
  if data == nil or data.kind != JObject:
    result = ErrorBehaviorConfig(mode: "show_error_retry")
  else:
    let silentWindowMinutes =
      if data{"silentWindowMinutes"} != nil: data{"silentWindowMinutes"}.getFloat(10)
      else: data{"silentRetryMinutes"}.getFloat(10)
    result = ErrorBehaviorConfig(
      mode: data{"mode"}.getStr("show_error_retry"),
      retrySeconds: data{"retrySeconds"}.getFloat(60),
      silentRetrySeconds: data{"silentRetrySeconds"}.getFloat(60),
      silentRetryForever: data{"silentRetryForever"}.getBool(false),
      silentWindowMinutes: silentWindowMinutes,
      showErrorRetrySeconds: data{"showErrorRetrySeconds"}.getFloat(60),
    )
  if result.mode notin ["safe_mode", "show_error_retry", "silent_retry"]:
    result.mode = "show_error_retry"
  if result.retrySeconds <= 0: result.retrySeconds = 60
  if result.silentRetrySeconds <= 0: result.silentRetrySeconds = 60
  if result.silentWindowMinutes <= 0: result.silentWindowMinutes = 10
  if result.showErrorRetrySeconds <= 0: result.showErrorRetrySeconds = 60

proc loadTimeZoneUpdates*(data: JsonNode): TimeZoneUpdatesConfig =
  if data == nil or data.kind != JObject:
    result = TimeZoneUpdatesConfig(enabled: true, hour: 3, url: "https://tz.frameos.net/tzdata.json.gz")
  else:
    result = TimeZoneUpdatesConfig(
      enabled: data{"enabled"}.getBool(true),
      hour: data{"hour"}.getInt(3),
      url: data{"url"}.getStr("https://tz.frameos.net/tzdata.json.gz"),
    )
  if result.hour < 0 or result.hour > 23:
    result.hour = 3
  if result.url == "":
    result.url = "https://tz.frameos.net/tzdata.json.gz"

proc getConfigFilename*(overridePath = ""): string =
  if overridePath.len > 0:
    return overridePath
  result = getEnv("FRAMEOS_CONFIG")
  if result == "":
    result = "./frame.json"

proc readJsonFile(path: string): JsonNode =
  let encoded = readTextFile(path)
  let decoded =
    if path.endsWith(".gz"):
      uncompress(encoded)
    else:
      encoded
  result = parseJson(decoded)

proc loadConfig*(configPath = ""): FrameConfig =
  let data = readJsonFile(getConfigFilename(configPath))
  # TODO: switch to jsony
  result = FrameConfig(
    name: data{"name"}.getStr(),
    mode: data{"mode"}.getStr("rpios"),
    serverHost: data{"serverHost"}.getStr(),
    serverPort: data{"serverPort"}.getInt(),
    serverApiKey: data{"serverApiKey"}.getStr(),
    serverSendLogs: data{"serverSendLogs"}.getBool(true),
    frameHost: data{"frameHost"}.getStr(),
    framePort: data{"framePort"}.getInt(),
    bindHost: data{"bindHost"}.getStr(),
    httpsProxy: HttpsProxyConfig(
      enable: data{"httpsProxy"}{"enable"}.getBool(),
      port: data{"httpsProxy"}{"port"}.getInt(),
      exposeOnlyPort: data{"httpsProxy"}{"exposeOnlyPort"}.getBool(),
      serverCert: data{"httpsProxy"}{"serverCert"}.getStr(""),
      serverKey: data{"httpsProxy"}{"serverKey"}.getStr(""),
    ),
    frameAccess: data{"frameAccess"}.getStr(),
    frameAccessKey: data{"frameAccessKey"}.getStr(),
    frameAdminAuth: if data{"frameAdminAuth"} == nil: %*{} else: data{"frameAdminAuth"},
    width: data{"width"}.getInt(),
    height: data{"height"}.getInt(),
    device: data{"device"}.getStr(),
    deviceConfig: loadDeviceConfig(data{"deviceConfig"}),
    metricsInterval: data{"metricsInterval"}.getFloat(),
    maxHttpResponseBytes: data{"maxHttpResponseBytes"}.getInt(DefaultMaxHttpResponseBytes),
    rotate: data{"rotate"}.getInt(),
    flip: data{"flip"}.getStr(""),
    scalingMode: data{"scalingMode"}.getStr(),
    imageEngine: data{"imageEngine"}.getStr(""),
    settings: data{"settings"},
    assetsPath: data{"assetsPath"}.getStr("/srv/assets"),
    saveAssets: if data{"saveAssets"} == nil: %*(false) else: data{"saveAssets"},
    logToFile: data{"logToFile"}.getStr(),
    debug: data{"debug"}.getBool() or commandLineParams().contains("--debug"),
    timeZone: data{"timeZone"}.getStr(""),
    timeZoneUpdates: loadTimeZoneUpdates(data{"timeZoneUpdates"}),
    schedule: loadSchedule(data{"schedule"}),
    gpioButtons: loadGPIOButtons(data{"gpioButtons"}),
    controlCode: loadControlCode(data{"controlCode"}),
    network: loadNetwork(data{"network"}),
    agent: loadAgent(data{"agent"}),
    mountpoints: loadMountpoints(data{"mountpoints"}),
    errorBehavior: loadErrorBehavior(data{"errorBehavior"}),
    palette: loadPalette(data{"palette"}),
  )
  if result.assetsPath.endswith("/"):
    result.assetsPath = result.assetsPath.strip(leading = false, trailing = true, chars = {'/'})
  setConfigDefaults(result)
  setRuntimeImageEngine(result.imageEngine)

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
  target.serverSendLogs = source.serverSendLogs
  target.frameHost = source.frameHost
  target.framePort = source.framePort
  target.bindHost = source.bindHost
  target.httpsProxy = source.httpsProxy
  target.frameAccessKey = source.frameAccessKey
  target.frameAccess = source.frameAccess
  target.frameAdminAuth = source.frameAdminAuth
  target.width = source.width
  target.height = source.height
  target.device = source.device
  target.deviceConfig = source.deviceConfig
  target.metricsInterval = source.metricsInterval
  target.maxHttpResponseBytes = source.maxHttpResponseBytes
  target.rotate = source.rotate
  target.flip = source.flip
  target.scalingMode = source.scalingMode
  target.imageEngine = source.imageEngine
  setRuntimeImageEngine(target.imageEngine)
  target.settings = source.settings
  target.assetsPath = source.assetsPath
  target.saveAssets = source.saveAssets
  target.logToFile = source.logToFile
  target.debug = source.debug
  target.timeZone = source.timeZone
  target.timeZoneUpdates = source.timeZoneUpdates
  target.gpioButtons = source.gpioButtons
  target.controlCode = source.controlCode
  target.network = source.network
  target.agent = source.agent
  target.mountpoints = source.mountpoints
  target.errorBehavior = source.errorBehavior
  target.palette = source.palette
  updateSchedule(target.schedule, source.schedule)
