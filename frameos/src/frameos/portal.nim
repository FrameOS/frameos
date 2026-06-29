import os, httpclient, json, strformat, strutils, times, threadpool, locks, tables
import std/[algorithm, monotimes]
import frameos/config
import frameos/types
import frameos/scenes
import frameos/channels
import frameos/setup_proxy
import frameos/utils/process
import drivers/drivers as frameDrivers

const
  nmHotspotName = "frameos-hotspot"
  nmConnectionName = "frameos-wifi"
  nmHotspotAddress = "10.42.0.1/24"
  # nmcli is invoked with --wait 15; anything slower than this is wedged
  portalCommandTimeoutMs = 60 * 1000
  clockSyncTimeoutMs = 120 * 1000
  hotspotStartAttempts = 6
  hotspotStartRetryDelayMs = 5000
  hotspotDeviceWaitAttempts = 12
  hotspotDeviceWaitDelayMs = 2500

var logger: Logger
var lastErrorLock: Lock
var lastError: string
initLock(lastErrorLock)

type
  PortalRunHook = proc(cmd: string): (string, int) {.gcsafe, nimcall.}
  PortalNmcliConnectHook = proc(args: seq[string]): tuple[rc: int, output: string] {.gcsafe, nimcall.}
  PortalSleepHook = proc(ms: int) {.gcsafe, nimcall.}
  PortalAutoTimeoutEnabledHook = proc(): bool {.gcsafe, nimcall.}

  PortalSetupOptions* = object
    ssid*: string
    password*: string
    serverHost*: string
    serverPort*: string
    hostname*: string
    device*: string
    width*: int
    height*: int
    vcom*: float
    partial*: bool
    partialMaxAreaPercent*: float
    partialMaxRefreshesBeforeFull*: int
    httpUploadUrl*: string
    runDriverSetup*: bool
    adminEnabled*: bool
    adminUser*: string
    adminPass*: string

  SetupDisplayOption* = object
    value: string
    label: string
    driver: string
    steps: seq[string]
    width: int
    height: int
    partialSupported: bool
    partialMaxAreaPercent: float
    partialMaxRefreshesBeforeFull: int
    vcomRequired: bool
    httpUploadUrlRequired: bool

proc defaultPortalRunHook(cmd: string): (string, int) {.gcsafe, nimcall.} =
  runShellCapture(cmd, timeoutMs = portalCommandTimeoutMs)

proc defaultPortalNmcliConnectHook(args: seq[string]): tuple[rc: int, output: string] {.gcsafe, nimcall.} =
  # nmcli is passed --wait 15, so it should finish well within the timeout
  let res = runProcessPiped("sudo", args, timeoutMs = portalCommandTimeoutMs,
                            maxOutputBytes = 1024 * 1024)
  (rc: res.exitCode, output: res.output & res.errorOutput)

proc hotspotAutoTimeoutLoop(frameOS: FrameOS, startedAt: MonoTime) {.gcsafe, nimcall.}

var portalRunHook: PortalRunHook = defaultPortalRunHook
var portalNmcliConnectHook: PortalNmcliConnectHook = defaultPortalNmcliConnectHook
var portalSleepHook: PortalSleepHook = proc(ms: int) {.gcsafe, nimcall.} = sleep(ms)
var portalAutoTimeoutEnabledHook: PortalAutoTimeoutEnabledHook = proc(): bool {.gcsafe, nimcall.} = true

proc getLastError*(): string =
  {.gcsafe.}:
    withLock lastErrorLock:
      return lastError & ""

proc rememberError*(msg: string) =
  {.gcsafe.}:
    let stripped = strip(msg)
    withLock lastErrorLock:
      lastError = stripped[0 ..< min(stripped.len, 160)] # 160‑char cap

proc isHotspotActive*(frameOS: FrameOS): bool =
  frameOS.network.hotspotStatus == HotspotStatus.enabled

proc setLogger*(l: Logger) = logger = l

proc pLog(ev: string, extra: JsonNode = %*{}) =
  {.gcsafe.}:
    let payload = copy(extra); payload["event"] = %*(ev)
    if logger != nil: logger.log(payload)
    else: echo "[portal] ", ev, " ", $extra

# Shell‑safe single‑quote wrapper (POSIX)
proc shQuote(s: string): string =
  "'" & s.replace("'", "'\"'\"'") & "'"

proc masked*(s: string; keep: int = 2): string =
  if s.len <= keep: "*".repeat(s.len) else: s[0..keep-1] & "*".repeat(s.len - keep)

proc maskedPasswordArgs*(args: seq[string]): seq[string] =
  ## Copy of args with the value following any "password" argument masked,
  ## safe to include in logs.
  result = args
  for i in 0 ..< max(result.len - 1, 0):
    if result[i] == "password":
      result[i + 1] = masked(result[i + 1])

proc run(cmd: string, loggedCmd: string = ""): (string, int) {.gcsafe.} =
  ## Execute a shell command (through /bin/sh -c) and log the result.
  ## Pass loggedCmd when cmd contains secrets that must not reach the logs.
  let (output, rc) = portalRunHook(cmd)
  pLog("portal:exec", %*{"cmd": (if loggedCmd.len > 0: loggedCmd else: cmd), "rc": rc, "output": output.strip()})
  (output, rc)

proc parseIntParam(value: string, fallback: int): int =
  try:
    result = parseInt(value.strip())
  except ValueError:
    result = fallback

proc parseFloatParam(value: string, fallback: float): float =
  try:
    result = parseFloat(value.strip())
  except ValueError:
    result = fallback

proc parseBoolParam(value: string): bool =
  value.strip().toLowerAscii() in ["1", "true", "yes", "on", "enabled"]

proc sanitizeHostnameBase(raw: string): string =
  var value = raw.strip().toLowerAscii()
  for prefix in ["https://", "http://"]:
    if value.startsWith(prefix):
      value = value[prefix.len .. ^1]
  if value.endsWith(".local"):
    value = value[0 ..< value.len - ".local".len]
  if value.contains(":"):
    value = value.split(":", 1)[0]
  if value.contains("/"):
    value = value.split("/", 1)[0]

  var lastWasDash = false
  for c in value:
    if c in {'a'..'z'} or c in {'0'..'9'}:
      result.add(c)
      lastWasDash = false
    elif c in {'-', '_', '.', ' '}:
      if result.len > 0 and not lastWasDash:
        result.add('-')
        lastWasDash = true

  result = result.strip(chars = {'-'})
  if result.len > 63:
    result = result[0 ..< 63].strip(chars = {'-'})

proc hostnameBaseFromFrameHost(host: string): string =
  sanitizeHostnameBase(host)

proc randomHostnameSuffix(): string =
  for path in ["/proc/sys/kernel/random/boot_id", "/etc/machine-id"]:
    try:
      let raw = readFile(path).strip().toLowerAscii()
      for c in raw:
        if c in {'a'..'z'} or c in {'0'..'9'}:
          result.add(c)
          if result.len >= 6:
            return
    except CatchableError:
      discard

  let fallback = $(int(epochTime() * 1000))
  if fallback.len <= 6:
    return fallback
  fallback[fallback.len - 6 .. ^1]

proc setupHostnameValue(frameConfig: FrameConfig): string =
  result = hostnameBaseFromFrameHost(frameConfig.frameHost)
  if result.len == 0 or result in ["frame", "localhost"]:
    result = "frame-" & randomHostnameSuffix()

proc frameHostFromHostname(hostname: string): string =
  let base = sanitizeHostnameBase(hostname)
  if base.len == 0:
    return "frame.local"
  base & ".local"

proc normalizedWaveshareVariant(device: string): string =
  const prefix = "waveshare."
  if not device.startsWith(prefix) or device.len <= prefix.len:
    return ""
  result = device[prefix.len .. ^1]
  if result == "epd7in5_V2":
    result = "EPD_7in5_V2"
  elif result == "epd2in13_V3":
    result = "EPD_2in13_V3"

proc driverNameForDevice(device: string): string =
  if device == "framebuffer":
    return "frameBuffer"
  if device == "http.upload":
    return "httpUpload"
  if device == "pimoroni.hyperpixel2r":
    return "inkyHyperPixel2rLegacyFb"
  if device == "pimoroni.hyperpixel2r_native":
    return "inkyHyperPixel2r"
  if device in ["pimoroni.inky_impression", "pimoroni.inky_python"]:
    return "inkyPython"
  if device.startsWith("pimoroni.inky_"):
    return "inky"
  let variant = normalizedWaveshareVariant(device)
  if variant.len > 0:
    return "waveshare_" & variant
  ""

proc addUniqueDriverName(names: var seq[string], name: string) =
  let trimmed = name.strip()
  if trimmed.len > 0 and trimmed notin names:
    names.add(trimmed)

proc availableDriverNames(): seq[string] =
  let generatedNames = frameDrivers.availableDriverNames()
  var diskNames: seq[string] = @[]
  let driversDir = getAppDir() / "drivers"
  if dirExists(driversDir):
    for kind, path in walkDir(driversDir):
      if kind == pcFile and path.endsWith(".so"):
        diskNames.addUniqueDriverName(splitFile(path).name)

  if diskNames.len > 0:
    if generatedNames.len > 0:
      for name in generatedNames:
        if name in diskNames:
          result.addUniqueDriverName(name)
    else:
      for name in diskNames:
        result.addUniqueDriverName(name)
  else:
    for name in generatedNames:
      result.addUniqueDriverName(name)
  result.sort(proc(a, b: string): int = cmpIgnoreCase(a, b))

proc isNativeInkyDevice(device: string): bool =
  device in [
    "pimoroni.inky_impression_7_3",
    "pimoroni.inky_impression_7_color",
    "pimoroni.inky_impression_5_7",
    "pimoroni.inky_impression_5_7_color",
    "pimoroni.inky_impression_4_7_color",
    "pimoroni.inky_impression_4",
    "pimoroni.inky_impression_4_2025",
    "pimoroni.inky_impression_4_spectra6",
    "pimoroni.inky_impression_7",
    "pimoroni.inky_impression_7_2025",
    "pimoroni.inky_impression_13",
    "pimoroni.inky_impression_13_2025",
    "pimoroni.inky_phat_4",
    "pimoroni.inky_phat_4_color",
    "pimoroni.inky_phat_jd79661",
    "pimoroni.inky_phat_black",
    "pimoroni.inky_phat_red",
    "pimoroni.inky_phat_red_ht",
    "pimoroni.inky_phat_yellow",
    "pimoroni.inky_phat_ssd1608",
    "pimoroni.inky_phat_ssd1608_black",
    "pimoroni.inky_phat_ssd1608_red",
    "pimoroni.inky_phat_ssd1608_yellow",
    "pimoroni.inky_what_4",
    "pimoroni.inky_what_4_color",
    "pimoroni.inky_what_jd79668",
    "pimoroni.inky_what_black",
    "pimoroni.inky_what_red",
    "pimoroni.inky_what_red_ht",
    "pimoroni.inky_what_yellow",
    "pimoroni.inky_what_legacy_yellow",
    "pimoroni.inky_what_ssd1683",
    "pimoroni.inky_what_ssd1683_black",
    "pimoroni.inky_what_ssd1683_red",
    "pimoroni.inky_what_ssd1683_yellow",
  ]

proc isInkyButtonDevice(device: string): bool =
  device in [
    "pimoroni.inky_impression",
    "pimoroni.inky_impression_7_3",
    "pimoroni.inky_impression_7_color",
    "pimoroni.inky_impression_5_7",
    "pimoroni.inky_impression_5_7_color",
    "pimoroni.inky_impression_4_7_color",
    "pimoroni.inky_impression_4",
    "pimoroni.inky_impression_4_2025",
    "pimoroni.inky_impression_4_spectra6",
    "pimoroni.inky_impression_7",
    "pimoroni.inky_impression_7_2025",
    "pimoroni.inky_impression_13",
    "pimoroni.inky_impression_13_2025",
  ]

proc isWaveshareNoSpiVariant(variant: string): bool =
  variant in ["EPD_12in48", "EPD_12in48b", "EPD_12in48b_V2", "EPD_13in3e"]

proc isWaveshareBootConfigSpiVariant(variant: string): bool =
  variant == "EPD_10in3"

proc waveshareBootConfigLines(variant: string): seq[string] =
  if variant == "EPD_10in3":
    return @["dtoverlay=spi0-0cs", "#dtparam=spi=on"]
  if variant == "EPD_13in3e":
    return @["gpio=7=op,dl", "gpio=8=op,dl"]
  @[]

proc partialDefaultsForDevice(device: string): tuple[supported: bool, area: float, refreshes: int] =
  if device == "waveshare.EPD_7in5_V2":
    return (supported: true, area: 15.0, refreshes: 30)
  if device == "waveshare.EPD_13in3b":
    return (supported: true, area: 100.0, refreshes: 5)
  (supported: false, area: 0.0, refreshes: 0)

proc setupStepsForDevice(device: string): seq[string] =
  if device == "framebuffer":
    return @["Use the Linux framebuffer output.", "Detect the framebuffer resolution during device setup."]
  if device == "http.upload":
    return @["Upload rendered PNG images to an HTTP endpoint."]
  if device == "pimoroni.hyperpixel2r":
    return @["Use the HyperPixel 2.1 Round framebuffer driver."]
  if device == "pimoroni.hyperpixel2r_native":
    return @["Use the native HyperPixel 2.1 Round driver."]
  if isNativeInkyDevice(device):
    result = @["Enable SPI.", "Add dtoverlay=spi0-0cs to boot config.", "Use the native Pimoroni Inky driver."]
    if isInkyButtonDevice(device):
      result.add("Configure Pimoroni button GPIO defaults.")
    return
  if device in ["pimoroni.inky_impression", "pimoroni.inky_python"]:
    result = @["Enable SPI.", "Enable I2C.", "Use the Pimoroni Inky Python driver."]
    if device == "pimoroni.inky_impression":
      result.add("Configure Pimoroni button GPIO defaults.")
    return
  let variant = normalizedWaveshareVariant(device)
  if variant.len > 0:
    if isWaveshareNoSpiVariant(variant):
      result = @["Disable generic SPI setup for this Waveshare panel."]
    elif isWaveshareBootConfigSpiVariant(variant):
      result = @["Apply Waveshare-specific boot config instead of generic SPI setup."]
    else:
      result = @["Enable SPI."]
    for line in waveshareBootConfigLines(variant):
      result.add("Set boot config: " & line)
    result.add("Use the Waveshare " & variant & " driver.")
    return
  @["Use the selected display driver."]

proc nativeDeviceDimensions(device: string): tuple[width: int, height: int] =
  case device
  of "pimoroni.inky_impression_7_3", "pimoroni.inky_impression_7_color",
      "pimoroni.inky_impression_7", "pimoroni.inky_impression_7_2025":
    (width: 800, height: 480)
  of "pimoroni.inky_impression_5_7", "pimoroni.inky_impression_5_7_color":
    (width: 600, height: 448)
  of "pimoroni.inky_impression_4_7_color":
    (width: 640, height: 400)
  of "pimoroni.inky_impression_4", "pimoroni.inky_impression_4_2025",
      "pimoroni.inky_impression_4_spectra6":
    (width: 600, height: 400)
  of "pimoroni.inky_impression_13", "pimoroni.inky_impression_13_2025":
    (width: 1600, height: 1200)
  of "pimoroni.inky_phat_black", "pimoroni.inky_phat_red",
      "pimoroni.inky_phat_red_ht", "pimoroni.inky_phat_yellow":
    (width: 212, height: 104)
  of "pimoroni.inky_phat_4", "pimoroni.inky_phat_4_color",
      "pimoroni.inky_phat_jd79661", "pimoroni.inky_phat_ssd1608",
      "pimoroni.inky_phat_ssd1608_black", "pimoroni.inky_phat_ssd1608_red",
      "pimoroni.inky_phat_ssd1608_yellow":
    (width: 250, height: 122)
  of "pimoroni.inky_what_4", "pimoroni.inky_what_4_color",
      "pimoroni.inky_what_jd79668", "pimoroni.inky_what_black",
      "pimoroni.inky_what_red", "pimoroni.inky_what_red_ht",
      "pimoroni.inky_what_yellow", "pimoroni.inky_what_legacy_yellow",
      "pimoroni.inky_what_ssd1683", "pimoroni.inky_what_ssd1683_black",
      "pimoroni.inky_what_ssd1683_red", "pimoroni.inky_what_ssd1683_yellow":
    (width: 400, height: 300)
  of "pimoroni.hyperpixel2r", "pimoroni.hyperpixel2r_native":
    (width: 480, height: 480)
  else:
    (width: 0, height: 0)

proc labelForDevice(device: string): string =
  case device
  of "framebuffer":
    "HDMI / Framebuffer"
  of "http.upload":
    "HTTP upload"
  of "pimoroni.inky_impression":
    "Pimoroni Inky Impression - all others (Python driver)"
  of "pimoroni.inky_python":
    "Pimoroni Inky other (Python driver)"
  of "pimoroni.hyperpixel2r":
    "Pimoroni HyperPixel 2.1 Round"
  of "pimoroni.hyperpixel2r_native":
    "Pimoroni HyperPixel 2.1 Round (native)"
  else:
    if device.startsWith("waveshare."):
      "Waveshare " & normalizedWaveshareVariant(device).replace("_", " ")
    elif device.startsWith("pimoroni."):
      "Pimoroni " & device["pimoroni.".len .. ^1].replace("_", " ")
    else:
      device

proc addDisplayOption(options: var seq[SetupDisplayOption], option: SetupDisplayOption) =
  for existing in options:
    if existing.value == option.value:
      return
  options.add(option)

proc makeDisplayOption(device, driverName: string): SetupDisplayOption =
  let dims = nativeDeviceDimensions(device)
  let partial = partialDefaultsForDevice(device)
  result = SetupDisplayOption(
    value: device,
    label: labelForDevice(device),
    driver: driverName,
    steps: setupStepsForDevice(device),
    width: dims.width,
    height: dims.height,
    partialSupported: partial.supported,
    partialMaxAreaPercent: partial.area,
    partialMaxRefreshesBeforeFull: partial.refreshes,
    vcomRequired: device == "waveshare.EPD_10in3",
    httpUploadUrlRequired: device == "http.upload",
  )

proc setupDisplayOptions*(frameOS: FrameOS): seq[SetupDisplayOption] =
  var drivers = availableDriverNames()
  let currentDriver = driverNameForDevice(frameOS.frameConfig.device)
  if drivers.len == 0 and currentDriver.len > 0:
    drivers.add(currentDriver)

  if "frameBuffer" in drivers:
    result.addDisplayOption(makeDisplayOption("framebuffer", "frameBuffer"))
  if "httpUpload" in drivers:
    result.addDisplayOption(makeDisplayOption("http.upload", "httpUpload"))

  if "inkyHyperPixel2rLegacyFb" in drivers:
    result.addDisplayOption(makeDisplayOption("pimoroni.hyperpixel2r", "inkyHyperPixel2rLegacyFb"))
  if "inkyHyperPixel2r" in drivers:
    result.addDisplayOption(makeDisplayOption("pimoroni.hyperpixel2r_native", "inkyHyperPixel2r"))

  if "inkyPython" in drivers:
    for device in ["pimoroni.inky_impression", "pimoroni.inky_python"]:
      result.addDisplayOption(makeDisplayOption(device, "inkyPython"))

  if "inky" in drivers:
    for device in [
      "pimoroni.inky_impression_4_2025",
      "pimoroni.inky_impression_4",
      "pimoroni.inky_impression_4_7_color",
      "pimoroni.inky_impression_4_spectra6",
      "pimoroni.inky_impression_5_7",
      "pimoroni.inky_impression_5_7_color",
      "pimoroni.inky_impression_7_3",
      "pimoroni.inky_impression_7_color",
      "pimoroni.inky_impression_7",
      "pimoroni.inky_impression_7_2025",
      "pimoroni.inky_impression_13",
      "pimoroni.inky_impression_13_2025",
      "pimoroni.inky_phat_4",
      "pimoroni.inky_phat_4_color",
      "pimoroni.inky_phat_jd79661",
      "pimoroni.inky_phat_black",
      "pimoroni.inky_phat_red",
      "pimoroni.inky_phat_red_ht",
      "pimoroni.inky_phat_yellow",
      "pimoroni.inky_phat_ssd1608",
      "pimoroni.inky_phat_ssd1608_black",
      "pimoroni.inky_phat_ssd1608_red",
      "pimoroni.inky_phat_ssd1608_yellow",
      "pimoroni.inky_what_4",
      "pimoroni.inky_what_4_color",
      "pimoroni.inky_what_jd79668",
      "pimoroni.inky_what_black",
      "pimoroni.inky_what_red",
      "pimoroni.inky_what_red_ht",
      "pimoroni.inky_what_yellow",
      "pimoroni.inky_what_legacy_yellow",
      "pimoroni.inky_what_ssd1683",
      "pimoroni.inky_what_ssd1683_black",
      "pimoroni.inky_what_ssd1683_red",
      "pimoroni.inky_what_ssd1683_yellow",
    ]:
      result.addDisplayOption(makeDisplayOption(device, "inky"))

  for driver in drivers:
    if driver.startsWith("waveshare_") and driver.len > "waveshare_".len:
      let variant = driver["waveshare_".len .. ^1]
      result.addDisplayOption(makeDisplayOption("waveshare." & variant, driver))

  if result.len == 0 and frameOS.frameConfig.device.len > 0:
    result.addDisplayOption(makeDisplayOption(frameOS.frameConfig.device, currentDriver))

proc displayOptionsJson(options: seq[SetupDisplayOption]): JsonNode =
  result = newJObject()
  for option in options:
    var steps = newJArray()
    for step in option.steps:
      steps.add(%step)
    result[option.value] = %*{
      "label": option.label,
      "driver": option.driver,
      "width": option.width,
      "height": option.height,
      "partialSupported": option.partialSupported,
      "partialMaxAreaPercent": option.partialMaxAreaPercent,
      "partialMaxRefreshesBeforeFull": option.partialMaxRefreshesBeforeFull,
      "vcomRequired": option.vcomRequired,
      "httpUploadUrlRequired": option.httpUploadUrlRequired,
    }
    result[option.value]["steps"] = steps

proc defaultDeviceConfig(): DeviceConfig =
  DeviceConfig(
    vcom: 0.0,
    partial: false,
    partialMaxAreaPercent: 0.0,
    partialMaxRefreshesBeforeFull: 0,
    httpUploadUrl: "",
    httpUploadHeaders: @[],
    pins: PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1),
  )

proc ensureDeviceConfig(frameConfig: FrameConfig): DeviceConfig =
  if frameConfig.deviceConfig.isNil:
    frameConfig.deviceConfig = defaultDeviceConfig()
  result = frameConfig.deviceConfig
  if result.pins.isNil:
    result.pins = PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1)

proc gpioButtonsForDeviceJson(device: string): JsonNode =
  result = newJArray()
  if not isInkyButtonDevice(device):
    return
  let cPin = if device in ["pimoroni.inky_impression_13", "pimoroni.inky_impression_13_2025"]: 25 else: 16
  for pair in [(5, "A"), (6, "B"), (cPin, "C"), (24, "D")]:
    result.add(%*{"pin": pair[0], "label": pair[1]})

proc applyGpioButtonsForDevice(frameConfig: FrameConfig, data: JsonNode, device: string) =
  if not isInkyButtonDevice(device):
    return
  let buttons = gpioButtonsForDeviceJson(device)
  data["gpioButtons"] = buttons
  frameConfig.gpioButtons = @[]
  for item in buttons.items:
    frameConfig.gpioButtons.add(GPIOButton(pin: item{"pin"}.getInt(), label: item{"label"}.getStr()))

proc loggableSetupParams*(params: Table[string, string]): JsonNode =
  result = newJObject()
  for key, value in params:
    if key in ["password", "adminPass"]:
      result[key] = %masked(value)
    else:
      result[key] = %value

proc parseSetupOptions*(params: Table[string, string], frameConfig: FrameConfig): PortalSetupOptions =
  let device = params.getOrDefault("device", frameConfig.device)
  let deviceConfig = ensureDeviceConfig(frameConfig)
  let adminAuth = if frameConfig.frameAdminAuth == nil: %*{} else: frameConfig.frameAdminAuth
  result = PortalSetupOptions(
    ssid: params.getOrDefault("ssid", ""),
    password: params.getOrDefault("password", ""),
    serverHost: params.getOrDefault(
      "serverHost",
      if frameConfig.serverHost.strip().len > 0: frameConfig.serverHost else: "localhost",
    ),
    serverPort: params.getOrDefault("serverPort", $(if frameConfig.serverPort > 0: frameConfig.serverPort else: 8989)),
    hostname: params.getOrDefault("hostname", setupHostnameValue(frameConfig)),
    device: device,
    width: parseIntParam(params.getOrDefault("width", $frameConfig.width), frameConfig.width),
    height: parseIntParam(params.getOrDefault("height", $frameConfig.height), frameConfig.height),
    vcom: parseFloatParam(params.getOrDefault("vcom", $deviceConfig.vcom), deviceConfig.vcom),
    partial: parseBoolParam(params.getOrDefault("partial", "")),
    partialMaxAreaPercent: parseFloatParam(
      params.getOrDefault("partialMaxAreaPercent", $deviceConfig.partialMaxAreaPercent),
      deviceConfig.partialMaxAreaPercent,
    ),
    partialMaxRefreshesBeforeFull: parseIntParam(
      params.getOrDefault("partialMaxRefreshesBeforeFull", $deviceConfig.partialMaxRefreshesBeforeFull),
      deviceConfig.partialMaxRefreshesBeforeFull,
    ),
    httpUploadUrl: params.getOrDefault("httpUploadUrl", deviceConfig.httpUploadUrl),
    runDriverSetup: parseBoolParam(params.getOrDefault("runDriverSetup", "")),
    adminEnabled: parseBoolParam(params.getOrDefault("adminEnabled", "")),
    adminUser: params.getOrDefault("adminUser", adminAuth{"user"}.getStr("admin")).strip(),
    adminPass: params.getOrDefault("adminPass", ""),
  )
  let defaults = partialDefaultsForDevice(device)
  if defaults.supported:
    if result.partialMaxAreaPercent <= 0:
      result.partialMaxAreaPercent = defaults.area
    if result.partialMaxRefreshesBeforeFull <= 0:
      result.partialMaxRefreshesBeforeFull = defaults.refreshes

proc writeHostnameBestEffort(hostname: string) =
  let base = sanitizeHostnameBase(hostname)
  if base.len == 0:
    return
  try:
    writeFile("/etc/hostname", base & "\n")
  except CatchableError:
    discard run("printf " & shQuote(base & "\n") & " | sudo tee /etc/hostname >/dev/null || true")
  discard run("printf " & shQuote(base & "\n") & " | sudo tee /boot/frameos-hostname >/dev/null 2>/dev/null || true")
  discard run("sudo hostname " & shQuote(base) & " || true")

proc runDriverSetupFromSavedConfig(frameOS: FrameOS, options: PortalSetupOptions): bool {.gcsafe.} =
  if not options.runDriverSetup:
    return true
  let binary = getAppFilename()
  let appDir = getAppDir()
  if binary.len == 0 or appDir.len == 0:
    rememberError("Display setup failed: runtime path not available.")
    return false
  pLog("portal:setup:driverSetup:start", %*{"device": frameOS.frameConfig.device})
  let command = "cd " & shQuote(appDir) & " && sudo -n " & shQuote(binary) & " driver-setup"
  let (output, rc) = run(command)
  if rc == 0 or rc == 2:
    pLog("portal:setup:driverSetup:done", %*{"device": frameOS.frameConfig.device})
    if rc == 2:
      pLog("portal:setup:driverSetup:rebootRequired", %*{"device": frameOS.frameConfig.device})
    return true
  let message = output.strip()
  rememberError("Display setup failed" & (if message.len > 0: ": " & message else: "."))
  pLog("portal:setup:driverSetup:error", %*{"device": frameOS.frameConfig.device, "rc": rc})
  false

proc persistPortalSetup*(frameOS: FrameOS, options: PortalSetupOptions): bool =
  let frameConfig = frameOS.frameConfig
  let filename = getConfigFilename()
  let device = options.device.strip()
  let oldFrameHost = frameConfig.frameHost
  let frameHost = frameHostFromHostname(options.hostname)
  let hostnameBase = hostnameBaseFromFrameHost(frameHost)
  var serverPort = parseIntParam(options.serverPort, frameConfig.serverPort)
  if serverPort <= 0 or serverPort > 65535:
    serverPort = if frameConfig.serverPort > 0: frameConfig.serverPort else: 8989

  try:
    var data =
      if filename.len > 0 and fileExists(filename):
        parseFile(filename)
      else:
        newJObject()
    if data == nil or data.kind != JObject:
      data = newJObject()

    if options.serverHost.strip().len > 0:
      data["serverHost"] = %options.serverHost.strip()
      frameConfig.serverHost = options.serverHost.strip()
    data["serverPort"] = %serverPort
    frameConfig.serverPort = serverPort

    data["frameHost"] = %frameHost
    frameConfig.frameHost = frameHost
    if data{"name"}.getStr("").strip().len == 0 or data{"name"}.getStr("") == oldFrameHost:
      data["name"] = %hostnameBase
      frameConfig.name = hostnameBase

    if device.len > 0:
      data["device"] = %device
      frameConfig.device = device

    let dims = nativeDeviceDimensions(device)
    var width = options.width
    var height = options.height
    if width <= 0 and dims.width > 0:
      width = dims.width
    if height <= 0 and dims.height > 0:
      height = dims.height
    if width > 0:
      data["width"] = %width
      frameConfig.width = width
    if height > 0:
      data["height"] = %height
      frameConfig.height = height

    var deviceConfig = data{"deviceConfig"}
    if deviceConfig == nil or deviceConfig.kind != JObject:
      deviceConfig = newJObject()
    deviceConfig["vcom"] = %options.vcom
    deviceConfig["partial"] = %options.partial
    deviceConfig["partialMaxAreaPercent"] = %options.partialMaxAreaPercent
    deviceConfig["partialMaxRefreshesBeforeFull"] = %options.partialMaxRefreshesBeforeFull
    deviceConfig["uploadUrl"] = %options.httpUploadUrl.strip()
    data["deviceConfig"] = deviceConfig

    let runtimeDeviceConfig = ensureDeviceConfig(frameConfig)
    runtimeDeviceConfig.vcom = options.vcom
    runtimeDeviceConfig.partial = options.partial
    runtimeDeviceConfig.partialMaxAreaPercent = options.partialMaxAreaPercent
    runtimeDeviceConfig.partialMaxRefreshesBeforeFull = options.partialMaxRefreshesBeforeFull
    runtimeDeviceConfig.httpUploadUrl = options.httpUploadUrl.strip()

    applyGpioButtonsForDevice(frameConfig, data, device)

    let existingAdmin = if frameConfig.frameAdminAuth == nil: %*{} else: frameConfig.frameAdminAuth
    let adminUser = options.adminUser.strip()
    let adminPass =
      if options.adminPass.len > 0:
        options.adminPass
      else:
        existingAdmin{"pass"}.getStr("")
    if options.adminEnabled and adminUser.len > 0 and adminPass.len > 0:
      data["frameAdminAuth"] = %*{"enabled": true, "user": adminUser, "pass": adminPass}
    else:
      data["frameAdminAuth"] = %*{"enabled": false, "user": adminUser, "pass": ""}
    frameConfig.frameAdminAuth = data["frameAdminAuth"]

    writeFile(filename, pretty(data, indent = 4) & "\n")
    writeHostnameBestEffort(hostnameBase)
    pLog("portal:setup:persisted", %*{
      "serverHost": frameConfig.serverHost,
      "serverPort": frameConfig.serverPort,
      "frameHost": frameConfig.frameHost,
      "device": frameConfig.device,
      "width": frameConfig.width,
      "height": frameConfig.height,
      "adminEnabled": frameConfig.frameAdminAuth{"enabled"}.getBool(false),
    })
    rememberError("")
    true
  except CatchableError as e:
    rememberError("Failed to save setup: " & e.msg)
    pLog("portal:setup:persistError", %*{"error": e.msg})
    false

proc parseWifiInterfaceFromNmcli(output: string): string =
  for line in output.splitLines():
    let parts = line.split(':')
    if parts.len < 2:
      continue
    if parts[1] != "wifi":
      continue
    if parts.len >= 3 and parts[2] == "unavailable":
      continue
    if parts[0].len > 0:
      return parts[0]
  return ""

proc getWifiDevice*(): string =
  let (output, rc) = run("sudo nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null || true")
  if rc != 0:
    return "wlan0"

  let activeDevice = parseWifiInterfaceFromNmcli(output)
  if activeDevice.len > 0:
    return activeDevice

  for line in output.splitLines():
    let parts = line.split(':')
    if parts.len < 2 or parts[1] != "wifi" or parts[0].len == 0:
      continue
    if parts.len >= 3 and parts[2] == "unavailable":
      continue
    return parts[0]
  return "wlan0"

proc getReadyWifiDevice(): string =
  let (output, rc) = run("sudo nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null || true")
  if rc != 0:
    return ""
  parseWifiInterfaceFromNmcli(output)

proc waitForReadyWifiDevice(): string =
  for attempt in 1..hotspotDeviceWaitAttempts:
    result = getReadyWifiDevice()
    if result.len > 0:
      return
    pLog("portal:startAp:wifiDeviceWait",
         %*{"attempt": attempt, "attempts": hotspotDeviceWaitAttempts})
    if attempt < hotspotDeviceWaitAttempts:
      portalSleepHook(hotspotDeviceWaitDelayMs)

proc availableNetworks*(frameOS: FrameOS): seq[string] =
  ## Return a list of nearby Wi-Fi SSIDs using nmcli
  let (output, rc) = run("sudo nmcli --terse --fields SSID device wifi list 2>/dev/null || true")
  if rc != 0:
    return @[]
  for line in output.splitLines():
    let ssid = line.strip()
    if ssid.len > 0 and ssid notin result:
      result.add ssid

proc hotspotRunning(frameOS: FrameOS): bool =
  let (output, _) = run("sudo nmcli --colors no -t -f NAME connection show --active | grep '^" &
                     nmHotspotName & "$' || true")
  result = output.strip().len > 0
  frameOS.network.hotspotStatus = if result: HotspotStatus.enabled else: HotspotStatus.disabled

proc anyWifiConfigured(frameOS: FrameOS): bool =
  let (output, _) = run("sudo nmcli --colors no -t -f NAME connection show | grep -v '^lo$' || true")
  result = output.strip().len > 0

proc stopAp*(frameOS: FrameOS) {.gcsafe.} =
  ## Tear down the hotspot
  if not hotspotRunning(frameOS):
    pLog("portal:stopAp:notStarted")
    return
  pLog("portal:stopAp")
  frameOS.network.hotspotStatus = HotspotStatus.stopping
  discard run("sudo nmcli connection down " & shQuote(nmHotspotName) & " || true")
  discard run("sudo nmcli connection delete " & shQuote(nmHotspotName) & " || true")
  frameOS.network.hotspotStatus = HotspotStatus.disabled
  stopSetupProxy()
  pLog("portal:stopAp:done")

proc startAp*(frameOS: FrameOS) {.gcsafe.} =
  ## Bring up Wi-Fi AP with hard-coded SSID/pw
  if hotspotRunning(frameOS):
    pLog("portal:startAp:alreadyRunning")
    return
  pLog("portal:startAp")
  frameOS.network.hotspotStatus = HotspotStatus.starting
  discard run("sudo rfkill unblock wifi || true")
  discard run("sudo nmcli radio wifi on || true")

  let wifiHotspotSsid = frameOS.frameConfig.network.wifiHotspotSsid
  let wifiHotspotPassword = frameOS.frameConfig.network.wifiHotspotPassword
  let maskedHotspotPassword = masked(wifiHotspotPassword)

  proc buildHotspotAddCmd(wifiDevice: string): string =
    fmt"sudo nmcli connection add type wifi ifname {shQuote(wifiDevice)} " &
      fmt"con-name {shQuote(nmHotspotName)} autoconnect no ssid {shQuote(wifiHotspotSsid)}"

  proc buildHotspotModifyCmd(password: string): string =
    fmt"sudo nmcli connection modify {shQuote(nmHotspotName)} " &
      "802-11-wireless.mode ap 802-11-wireless.band bg " &
      fmt"802-11-wireless-security.key-mgmt wpa-psk " &
      fmt"802-11-wireless-security.psk {shQuote(password)} " &
      fmt"ipv4.method shared ipv4.addresses {shQuote(nmHotspotAddress)} ipv6.method ignore"

  proc buildHotspotUpCmd(): string =
    fmt"sudo nmcli --wait 15 connection up {shQuote(nmHotspotName)}"

  proc finishStartedHotspot(): bool =
    discard run("sudo nmcli connection modify " & shQuote(nmHotspotName) & " 802-11-wireless.ap-isolation 1 || true")

    frameOS.network.hotspotStatus = HotspotStatus.enabled
    startSetupProxy(frameOS.frameConfig)
    pLog("portal:startAp:setupProxy", %*{"port": setupProxyPort()})
    let hotspotStarted = getMonoTime()
    frameOS.network.hotspotStartedAt = epochTime()
    pLog("portal:startAp:done")
    sendEvent("setCurrentScene", %*{"sceneId": "system/wifiHotspot".SceneId})
    if portalAutoTimeoutEnabledHook():
      spawn hotspotAutoTimeoutLoop(frameOS, hotspotStarted)
    true

  proc startConfiguredHotspot(wifiDevice: string): bool =
    if run("sudo nmcli device set " & shQuote(wifiDevice) & " managed yes || true")[1] != 0:
      frameOS.network.hotspotStatus = HotspotStatus.error
      pLog("portal:startAp:managedFailed", %*{"device": wifiDevice})
      pLog("portal:startAp:error")
      return false

    if run(buildHotspotAddCmd(wifiDevice))[1] != 0:
      pLog("portal:startAp:addFailed", %*{"device": wifiDevice})
      return false

    if run(buildHotspotModifyCmd(wifiHotspotPassword),
           loggedCmd = buildHotspotModifyCmd(maskedHotspotPassword))[1] != 0:
      pLog("portal:startAp:modifyFailed", %*{"device": wifiDevice})
      return false

    if run(buildHotspotUpCmd())[1] != 0:
      pLog("portal:startAp:activateFailed", %*{"device": wifiDevice})
      return false

    return finishStartedHotspot()

  for attempt in 1..hotspotStartAttempts:
    discard run("sudo nmcli connection delete " & shQuote(nmHotspotName) & " 2>/dev/null || true")
    let wifiDevice = waitForReadyWifiDevice()
    if wifiDevice.len == 0:
      frameOS.network.hotspotStatus = HotspotStatus.error
      pLog("portal:startAp:noWifiDevice", %*{"attempt": attempt, "attempts": hotspotStartAttempts})
      pLog("portal:startAp:error")
      return

    if startConfiguredHotspot(wifiDevice):
      return

    pLog("portal:startAp:retry", %*{"attempt": attempt, "attempts": hotspotStartAttempts})
    if attempt < hotspotStartAttempts:
      portalSleepHook(hotspotStartRetryDelayMs)

  frameOS.network.hotspotStatus = HotspotStatus.error
  pLog("portal:startAp:error")


proc hotspotAutoTimeoutLoop(frameOS: FrameOS, startedAt: MonoTime) {.gcsafe, nimcall.} =
  while true:
    portalSleepHook(1000)
    if frameOS.network.hotspotStatus != HotspotStatus.enabled:
      return
    let timeoutSec = frameOS.frameConfig.network.wifiHotspotTimeoutSeconds
    if timeoutSec <= 0:
      return # disabled or mis-configured - bail out immediately

    if (getMonoTime() - startedAt) >= initDuration(milliseconds = int(timeoutSec * 1000)):
      pLog("portal:stopAp:autoTimeout")
      stopAp(frameOS)
      sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})

proc attemptConnect*(frameOS: FrameOS, ssid, password: string): bool {.gcsafe.} =
  frameOS.network.status = NetworkStatus.connecting
  discard run(fmt"sudo -n nmcli connection delete '{nmConnectionName}' 2>/dev/null || true")
  let wifiDevice = getWifiDevice()

  var rc = 1
  var output = ""
  var nmcliArgs = @[
    "--wait", "15", # abort if not connected in 15 s
    "device", "wifi", "connect", ssid,
    "password", password,
    "ifname", wifiDevice, "name", nmConnectionName,
  ]
  let sudoArgs = @["-n", "nmcli"] & nmcliArgs # -n = never prompt for pwd
  let connectResult = portalNmcliConnectHook(sudoArgs)
  rc = connectResult.rc
  output = connectResult.output
  var loggedCommand = "sudo " & $maskedPasswordArgs(sudoArgs)

  if rc != 0:
    nmcliArgs = @[
      "--wait", "15",
      "device", "wifi", "connect", ssid,
      "password", password,
      "name", nmConnectionName,
    ]
    let fallbackArgs = @["-n", "nmcli"] & nmcliArgs
    let fallbackResult = portalNmcliConnectHook(fallbackArgs)
    rc = fallbackResult.rc
    output = fallbackResult.output
    loggedCommand = "sudo " & $maskedPasswordArgs(fallbackArgs)

  pLog("portal:exec",
       %*{"cmd": loggedCommand, "rc": rc, "output": output.strip()})

  result = (rc == 0)
  frameOS.network.status = if result: NetworkStatus.connected else: NetworkStatus.error

  if frameOS.network.status == NetworkStatus.connected:
    portalSleepHook(5000) # give DHCP etc a moment

  sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})

# Immediately sync the clock so HTTPS certificates validate
proc syncClock*() =
  ## Tries the best available tool on the current distro.
  try:
    # Any systemd host: systemd-timesyncd one-shot
    if fileExists("/run/systemd/system"):
      discard runShellWithParentStreams("sudo systemctl restart systemd-timesyncd.service",
                                        timeoutMs = clockSyncTimeoutMs)
    # Classic Debian / Raspberry Pi OS: one‑shot ntpd
    elif findExe("ntpd") != "":
      discard runShellWithParentStreams("sudo ntpd -gq",
                                        timeoutMs = clockSyncTimeoutMs) # exits after first successful poll
    # BusyBox systems (rare): fall back to sntp
    elif findExe("sntp") != "":
      discard runShellWithParentStreams("sudo sntp -sS pool.ntp.org",
                                        timeoutMs = clockSyncTimeoutMs)
  except CatchableError:
    echo "⚠️  Time‑sync failed – will retry later"

proc connectToWifi*(frameOS: FrameOS, options: PortalSetupOptions) {.gcsafe.} =
  let frameConfig = frameOS.frameConfig
  if not runDriverSetupFromSavedConfig(frameOS, options):
    frameOS.network.status = NetworkStatus.error
    sendEvent("setCurrentScene", %*{"sceneId": "system/wifiHotspot".SceneId})
    return

  stopAp(frameOS) # close hotspot before connecting

  if attemptConnect(frameOS, options.ssid, options.password):
    var connected = false
    syncClock()
    for attempt in 0..<4:
      let client = newHttpClient(timeout = 5000)
      try:
        let response = client.get(frameConfig.network.networkCheckUrl)
        if response.status.startsWith("200"):
          pLog("portal:connect:configPersisted",
               %*{"serverHost": frameConfig.serverHost, "serverPort": frameConfig.serverPort,
                   "frameHost": frameConfig.frameHost, "device": frameConfig.device})
          log(%*{"event": "networkCheck", "status": "success"})
          sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})
          rememberError("")
          return
        else:
          log(%*{"event": "networkCheck", "status": "failed", "response": response.status})
          rememberError("Network check failed. Please try again." &
                        fmt" (HTTP {response.status})")
          sleep(3000 * (attempt + 1)) # wait before retrying
      except CatchableError as e:
        log(%*{"event": "networkCheck", "status": "error", "error": e.msg})
        rememberError("Network check failed: " & e.msg)
        sleep(3000 * (attempt + 1)) # wait before retrying
      finally:
        client.close()

    if not connected:
      log(%*{"event": "portal:connect:netCheckFailed"})
      startAp(frameOS) # fall back to AP
  else:
    log(%*{"event": "portal:connectFailed"})
    rememberError("Wifi connection failed. Check your credentials.")
    startAp(frameOS)

proc checkNetwork*(self: FrameOS): bool =
  if not self.frameConfig.network.networkCheck or self.frameConfig.network.networkCheckTimeoutSeconds <= 0:
    return false

  let url = self.frameConfig.network.networkCheckUrl
  let timeout = self.frameConfig.network.networkCheckTimeoutSeconds
  let timer = getMonoTime()
  var attempt = 1
  self.network.status = NetworkStatus.connecting
  self.logger.log(%*{"event": "networkCheck", "url": url})
  while true:
    if (getMonoTime() - timer) >= initDuration(milliseconds = int(timeout*1000)):
      self.network.status = NetworkStatus.timeout
      self.logger.log(%*{"event": "networkCheck", "status": "timeout", "seconds": timeout})
      return false
    let client = newHttpClient(timeout = 5000)
    try:
      let response = client.get(url)
      if response.status.startsWith("200"):
        self.network.status = NetworkStatus.connected
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "success"})
        return true
      else:
        self.network.status = NetworkStatus.error
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "failed",
            "response": response.status})
    except CatchableError as e:
      self.network.status = NetworkStatus.error

      # Error with SSL certificates. Most likely means the clock is wrong after a long downtime.
      if e.msg.contains("certificate verify failed") or e.msg.contains("error:0A000086"):
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "error", "error": e.msg,
            "action": "syncing clock and trying again"})
        syncClock()
        portalSleepHook(min(max(3, attempt), 60) * 1000)
        continue
      else:
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "error", "error": e.msg})

    finally:
      client.close()

    # If no wifi configured (first boot?), bail and show the AP
    if attempt == 1:
      if not anyWifiConfigured(self):
        self.network.status = NetworkStatus.error
        self.logger.log(%*{"event": "networkCheck", "status": "wifi_not_configured"})
        return false
      else:
        self.network.status = NetworkStatus.connecting
        self.logger.log(%*{"event": "networkCheck", "status": "wifi_connecting"})

    portalSleepHook(min(attempt, 60) * 1000)
    attempt += 1
  return false

proc setPortalHooksForTest*(
  runHook: PortalRunHook = nil,
  nmcliConnectHook: PortalNmcliConnectHook = nil,
  sleepHook: PortalSleepHook = nil,
  autoTimeoutEnabledHook: PortalAutoTimeoutEnabledHook = nil
) =
  if runHook != nil: portalRunHook = runHook
  if nmcliConnectHook != nil: portalNmcliConnectHook = nmcliConnectHook
  if sleepHook != nil: portalSleepHook = sleepHook
  if autoTimeoutEnabledHook != nil: portalAutoTimeoutEnabledHook = autoTimeoutEnabledHook

proc resetPortalHooksForTest*() =
  portalRunHook = defaultPortalRunHook
  portalNmcliConnectHook = defaultPortalNmcliConnectHook
  portalSleepHook = proc(ms: int) {.gcsafe, nimcall.} = sleep(ms)
  portalAutoTimeoutEnabledHook = proc(): bool {.gcsafe, nimcall.} = true

proc htmlEscape(input: string): string =
  result = input.replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&apos;")

const styleBlock* = """
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background-color:#111827;color:#f9fafb}
.card{background:color-mix(in oklch,#1f2937 70%,oklch(27.8% 0.033 256.848) 30%);padding:2rem 2.5rem;border-radius:.5rem;width:100%;max-width:36rem;box-shadow:0 2px 6px rgba(0,0,0,.35)}
h1{margin:0 0 1rem;font-size:1.5rem;font-weight:600;line-height:1.2}
p,li{font-size:.875rem;color:#d1d5db;margin:0 0 1rem}
label{display:block;font-weight:500;font-size:.875rem;margin-bottom:.25rem}
input:not([type=checkbox]),select{box-sizing:border-box;width:100%;padding:.5rem .75rem;font-size:.875rem;color:#f9fafb;background-color:#111827;border:1px solid #374151;border-radius:.375rem;margin-bottom:1rem;margin-top:.5rem;}
input[type=checkbox]{width:auto;margin:0 .5rem 0 0}
input:focus,select:focus{outline:none;border-color:#4a4b8c;box-shadow:0 0 0 1px #4a4b8c}
a{text-decoration:none;color:#8283bf;} a:hover{text-decoration:underline;}
button{display:block;width:100%;padding:.5rem;font-size:.875rem;font-weight:500;color:#fff;background-color:#4a4b8c;border:none;border-radius:.375rem;cursor:pointer;text-align:center}
button:hover{background-color:#484984}
button:focus{outline:none;box-shadow:0 0 0 1px #484984}
details{border-top:1px solid #374151;padding-top:1rem;margin-top:1rem}
details:first-of-type{border-top:0;margin-top:0;padding-top:0}
summary{font-size:.875rem;font-weight:600;cursor:pointer;margin-bottom:1rem}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.inline{display:flex;align-items:center;margin:.5rem 0 1rem}
.muted{font-size:.8125rem;color:#9ca3af;margin-top:-.5rem}
.secondary{width:auto;display:inline-block;background:#374151;padding:.5rem .75rem;margin-top:.5rem}
.secondary:hover{background:#4b5563}
.steps{margin:.5rem 0 1rem;padding-left:1.25rem}
.hidden{display:none}
select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='%23d1d5db' d='M5.23 7.21a.75.75 0 0 1 1.06 0L10 10.92l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.24a.75.75 0 0 1-1.06 0L5.23 8.27a.75.75 0 0 1 0-1.06z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .75rem center;background-size:1rem}
</style>"""

proc layout*(inner: string): string =
  fmt"""<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta charset="utf-8"><title>FrameOS Setup</title>{styleBlock}</head>
<body><div class="card">{inner}</div></body></html>"""

proc setupHtml*(frameOS: FrameOS): string =
  let frameConfig = frameOS.frameConfig
  let deviceConfig = if frameConfig.deviceConfig.isNil: defaultDeviceConfig() else: frameConfig.deviceConfig
  let adminAuth = if frameConfig.frameAdminAuth == nil: %*{} else: frameConfig.frameAdminAuth
  let adminUser = adminAuth{"user"}.getStr("admin")
  let hasAdminPass = adminAuth{"pass"}.getStr("").len > 0
  let adminChecked = if adminAuth{"enabled"}.getBool(false) and adminUser.len > 0 and hasAdminPass: " checked" else: ""
  let adminPassExistingAttr = if hasAdminPass: "1" else: "0"
  let adminPassPlaceholder =
    if hasAdminPass:
      "Leave blank to keep current password"
    else:
      "Required when admin UI is enabled"
  let options = setupDisplayOptions(frameOS)

  var currentDevice = frameConfig.device
  var currentOption = SetupDisplayOption()
  var foundCurrent = false
  for option in options:
    if option.value == currentDevice:
      currentOption = option
      foundCurrent = true
      break
  if not foundCurrent and options.len > 0:
    currentDevice = options[0].value
    currentOption = options[0]

  var optionsHtml = ""
  for option in options:
    let selected = if option.value == currentDevice: " selected" else: ""
    optionsHtml &= fmt"""<option value="{htmlEscape(option.value)}"{selected}>{htmlEscape(option.label)}</option>"""

  let displayWidth = if frameConfig.width > 0: frameConfig.width elif currentOption.width > 0: currentOption.width else: 800
  let displayHeight = if frameConfig.height > 0: frameConfig.height elif currentOption.height > 0: currentOption.height else: 480
  let framePort = if frameConfig.framePort > 0: frameConfig.framePort else: 8787
  let serverHost = if frameConfig.serverHost.strip().len > 0: frameConfig.serverHost else: "localhost"
  let serverPort = if frameConfig.serverPort > 0: frameConfig.serverPort else: 8989
  let partialChecked = if deviceConfig.partial: " checked" else: ""
  let partialArea = if deviceConfig.partialMaxAreaPercent > 0: deviceConfig.partialMaxAreaPercent else: currentOption.partialMaxAreaPercent
  let partialRefreshes =
    if deviceConfig.partialMaxRefreshesBeforeFull > 0:
      deviceConfig.partialMaxRefreshesBeforeFull
    else:
      currentOption.partialMaxRefreshesBeforeFull

  let body = fmt"""
<h1>Set up your Frame</h1>
<p>If the connection fails, reconnect to this access point and try again.</p>
<p id="err" style="color:#f87171">{htmlEscape(getLastError())}</p>
<form method="post" action="/setup">
  <details open>
    <summary>Wi-Fi</summary>
    <label><a href='#' onclick='updateNetworks();return false;' style='float:right'>Reload</a>Wi-Fi SSID
      <select id="ssid" name="ssid" required>
        <option disabled selected>Loading...</option>
      </select>
    </label>
    <label>Password<input type="password" name="password"></label>
  </details>

  <details open>
    <summary>Frame</summary>
    <label>Hostname
      <input id="hostname" type="text" name="hostname"
             value="{htmlEscape(setupHostnameValue(frameConfig))}" required>
    </label>
    <button class="secondary" type="button" id="random-hostname">Randomize</button>
    <p class="muted">After reconnecting, open http://&lt;hostname&gt;.local:{framePort}/.</p>
  </details>

  <details open>
    <summary>Display</summary>
    <label>Driver
      <select id="device" name="device" required>
        {optionsHtml}
      </select>
    </label>
    <ul class="steps" id="driver-steps"></ul>
    <label class="inline"><input type="checkbox" name="runDriverSetup" value="1" checked>Run display setup before connecting</label>
    <div class="row">
      <label>Width
        <input id="width" type="number" min="1" name="width" value="{displayWidth}">
      </label>
      <label>Height
        <input id="height" type="number" min="1" name="height" value="{displayHeight}">
      </label>
    </div>
    <div id="partial-fields" class="hidden">
      <label class="inline"><input type="checkbox" name="partial" value="1"{partialChecked}>Partial refresh</label>
      <div class="row">
        <label>Max area %
          <input id="partial-area" type="number" min="0" max="100" step="0.1"
                 name="partialMaxAreaPercent" value="{partialArea}">
        </label>
        <label>Max partials
          <input id="partial-refreshes" type="number" min="0"
                 name="partialMaxRefreshesBeforeFull" value="{partialRefreshes}">
        </label>
      </div>
    </div>
    <div id="vcom-field" class="hidden">
      <label>VCOM
        <input type="number" step="0.01" name="vcom" value="{deviceConfig.vcom}">
      </label>
    </div>
    <div id="http-upload-field" class="hidden">
      <label>Upload URL
        <input type="url" name="httpUploadUrl"
               placeholder="http://example.local/frame.png"
               value="{htmlEscape(deviceConfig.httpUploadUrl)}">
      </label>
    </div>
  </details>

  <details open>
    <summary>Admin access</summary>
    <label class="inline"><input id="admin-enabled" type="checkbox" name="adminEnabled" value="1"{adminChecked}>Enable admin UI</label>
    <label>Admin User
      <input id="admin-user" type="text" name="adminUser" value="{htmlEscape(adminUser)}">
    </label>
    <label>Admin Password
      <input id="admin-pass" type="password" name="adminPass"
             data-existing="{adminPassExistingAttr}"
             placeholder="{htmlEscape(adminPassPlaceholder)}">
    </label>
  </details>

  <details>
    <summary>Server connection</summary>
    <label>Server Host
      <input type="text" name="serverHost"
            placeholder="my.frameos.server"
            value="{htmlEscape(serverHost)}" required>
    </label>

    <label>Server Port
      <input type="number" min="1" max="65535"
            name="serverPort"
            value="{serverPort}">
    </label>
  </details>

  <button type="submit" style="margin-top:1rem">Save &amp; Connect</button>
</form>
"""
  let script = """
<script>
const displayMeta = __DISPLAY_META__;
const sel = document.getElementById('ssid');
const deviceSel = document.getElementById('device');
const widthInput = document.getElementById('width');
const heightInput = document.getElementById('height');
const partialFields = document.getElementById('partial-fields');
const partialArea = document.getElementById('partial-area');
const partialRefreshes = document.getElementById('partial-refreshes');
const vcomField = document.getElementById('vcom-field');
const uploadField = document.getElementById('http-upload-field');
const stepsEl = document.getElementById('driver-steps');
const adminEnabled = document.getElementById('admin-enabled');
const adminUser = document.getElementById('admin-user');
const adminPass = document.getElementById('admin-pass');

function currentDeviceMeta() {
  return displayMeta[deviceSel.value] || {};
}

function updateDriverUi(applyDefaults = false) {
  const meta = currentDeviceMeta();
  if (applyDefaults) {
    if (meta.width > 0) widthInput.value = meta.width;
    if (meta.height > 0) heightInput.value = meta.height;
  }
  stepsEl.innerHTML = '';
  (meta.steps || []).forEach(step => {
    const item = document.createElement('li');
    item.textContent = step;
    stepsEl.appendChild(item);
  });
  partialFields.classList.toggle('hidden', !meta.partialSupported);
  if (meta.partialSupported) {
    if (!partialArea.value || Number(partialArea.value) <= 0) partialArea.value = meta.partialMaxAreaPercent || 0;
    if (!partialRefreshes.value || Number(partialRefreshes.value) <= 0) partialRefreshes.value = meta.partialMaxRefreshesBeforeFull || 0;
  }
  vcomField.classList.toggle('hidden', !meta.vcomRequired);
  uploadField.classList.toggle('hidden', !meta.httpUploadUrlRequired);
}

function updateAdminUi() {
  const enabled = adminEnabled.checked;
  adminUser.required = enabled;
  adminPass.required = enabled && adminPass.dataset.existing !== '1';
}

function randomHostname() {
  const bytes = new Uint8Array(3);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  document.getElementById('hostname').value = 'frame-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function setOptions(list, current) {
  sel.innerHTML = '';
  list.forEach(s => {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  });
  if (current && list.includes(current)) sel.value = current;
}

function loadCached() {
  try {
    const cached = JSON.parse(localStorage.getItem('wifiSsids') || '[]');
    if (Array.isArray(cached) && cached.length) {
      setOptions(cached);
    }
  } catch (e) {
    console.error(e);
  }
}

function updateNetworks() {
  fetch('/wifi')
    .then(r => r.json())
    .then(d => {
      const unique = [...new Set(d.networks.filter(n => n.trim()))]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      localStorage.setItem('wifiSsids', JSON.stringify(unique));
      const current = sel ? sel.value : null;
      setOptions(unique, current);
    })
    .catch(console.error);
}

loadCached();
updateNetworks();
setInterval(updateNetworks, 10000);
setTimeout(updateNetworks, 1000);
setTimeout(updateNetworks, 4000);
deviceSel.addEventListener('change', () => updateDriverUi(true));
adminEnabled.addEventListener('change', updateAdminUi);
document.getElementById('random-hostname').addEventListener('click', randomHostname);
updateDriverUi(false);
updateAdminUi();
</script>""".replace("__DISPLAY_META__", $displayOptionsJson(options))
  layout(body & script)

proc postSetupFrameUrl*(frameOS: FrameOS): string =
  let frameConfig = frameOS.frameConfig
  let scheme = if frameConfig.httpsProxy != nil and frameConfig.httpsProxy.enable: "https" else: "http"
  let host = if frameConfig.frameHost.strip().len > 0: frameConfig.frameHost.strip() else: "frame.local"
  var port =
    if scheme == "https":
      if frameConfig.httpsProxy != nil and frameConfig.httpsProxy.port > 0: frameConfig.httpsProxy.port else: 443
    else:
      if frameConfig.framePort > 0: frameConfig.framePort else: 8787
  let portSuffix =
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443): "" else: ":" & $port
  result = scheme & "://" & host & portSuffix & "/"

proc confirmHtml*(frameOS: FrameOS): string =
  let frameUrl = postSetupFrameUrl(frameOS)
  let adminUrl = frameUrl & "admin"
  layout(
    "<h1>Saved!</h1>\n" &
    "<p>The frame is now attempting to connect to Wi-Fi. After your computer reconnects to the same network, look for the frame at <a href=\"" &
      htmlEscape(frameUrl) & "\">" & htmlEscape(frameUrl) & "</a>.</p>\n" &
    "<p>If you enabled the admin UI, open <a href=\"" & htmlEscape(adminUrl) & "\">" & htmlEscape(adminUrl) & "</a>.</p>\n" &
    "<p>If you left display setup enabled, the frame applies driver setup before joining Wi-Fi. A reboot may still be required before that display is active.</p>\n" &
    """
<h2>Troubleshooting</h2>
<ul>
  <li>Wait about 60 seconds - your device can stay stuck on the setup network for a short time.</li>
  <li>If the "FrameOS-Setup" access-point reappears, the Wi-Fi credentials were likely wrong.</li>
  <li>Reconnect to the access-point and run the setup again, double-checking SSID and password.</li>
</ul><script>
// Reload the page when it comes back
window.setInterval(() => {
  window.fetch('/').then(() => {
    window.location.href = '/';
  }).catch(() => {
    // ignore errors, we just want to reload the page
  });
}, 10000);
</script>""")
