## frame.json → FrameConfig.
##
## The file is jsony-parsed straight into the typed config: field names ARE
## the JSON keys (camelCase, as the backend's get_frame_json and the SPA's
## on-device save both write them). What used to be a hand-written getter per
## field now lives in three kinds of hooks:
##
## - `newHook`  — the defaults an absent key or an absent object leaves behind
## - `renameHook` — the few keys whose JSON spelling differs from the field
## - `postHook` — clamps and trims that need the whole object first
##
## plus lenient scalar hooks: frame.json is written by several hands (the
## backend, the SPA form posting straight to the device, the cloud, a person
## with an editor), and a number sometimes arrives quoted, an integer as a
## float, a boolean as "true". Those parse; a value that cannot be read leaves
## the field at its default instead of refusing to boot the frame — the same
## posture the old `getStr(default)` accessors had. Only malformed JSON is
## fatal.
##
## The lenient hooks are exported because jsony resolves hooks at the
## instantiation site: a module that parses one of these config types itself
## needs to see them. Nothing else in the runtime should parse a config type
## from JSON — go through parseFrameConfig / loadConfig.

import json, jsony, pixie, os, strutils, parseutils
import zippy
import frameos/hal/files
import frameos/local_access
import frameos/types
import frameos/utils/font
import frameos/utils/image
import lib/tz

export jsony.fromJson

const
  DefaultTimeZoneUpdatesUrl* = "https://tz.frameos.net/tzdata.json.gz"
  DefaultAssetsPath* = "/srv/assets"

# ---------------------------------------------------------------------------
# Lenient scalars
# ---------------------------------------------------------------------------

proc numberToken(s: string, i: var int): string =
  ## The run of number-ish characters at `i` (empty for anything else).
  var j = i
  while j < s.len and s[j] in {'0'..'9', '.', '-', '+', 'e', 'E'}:
    inc j
  result = s[i ..< j]
  i = j

proc parseHook*(s: string, i: var int, v: var int) =
  eatSpace(s, i)
  var text: string
  if i < s.len and s[i] == '"':
    parseHook(s, i, text)
    text = text.strip()
  else:
    text = numberToken(s, i)
    if text.len == 0:
      skipValue(s, i)
      return
  var parsed: float
  if parseutils.parseFloat(text, parsed) == text.len and text.len > 0:
    v = int(parsed)

proc parseHook*(s: string, i: var int, v: var float) =
  eatSpace(s, i)
  var text: string
  if i < s.len and s[i] == '"':
    parseHook(s, i, text)
    text = text.strip()
  else:
    text = numberToken(s, i)
    if text.len == 0:
      skipValue(s, i)
      return
  var parsed: float
  if parseutils.parseFloat(text, parsed) == text.len and text.len > 0:
    v = parsed

proc parseHook*(s: string, i: var int, v: var bool) =
  eatSpace(s, i)
  if i < s.len and s[i] in {'t', 'f'}:
    jsony.parseHook(s, i, v)
    return
  var text: string
  if i < s.len and s[i] == '"':
    parseHook(s, i, text)
    text = text.strip().toLowerAscii()
  else:
    text = numberToken(s, i)
    if text.len == 0:
      skipValue(s, i)
      return
  if text in ["true", "1", "yes", "on"]:
    v = true
  elif text in ["false", "0", "no", "off"]:
    v = false

proc parseHook*(s: string, i: var int, v: var string) =
  eatSpace(s, i)
  if i < s.len and s[i] == '"':
    jsony.parseHook(s, i, v)
  elif i + 3 < s.len and s[i] == 'n':
    jsony.parseHook(s, i, v) # null: leaves the default
  else:
    # A bare number or boolean where text was expected: take its spelling.
    let text = numberToken(s, i)
    if text.len > 0:
      v = text
    else:
      var flag: bool
      let start = i
      try:
        jsony.parseHook(s, i, flag)
        v = $flag
      except jsony.JsonError:
        i = start
        skipValue(s, i)

proc parseHook*(s: string, i: var int, v: var Color) =
  ## "#rrggbb" (or any pixie-parseable colour). Anything unreadable stays the
  ## zero colour, which the owning object's postHook turns into its default.
  eatSpace(s, i)
  if i < s.len and s[i] == '"':
    var text: string
    parseHook(s, i, text)
    try:
      v = parseHtmlColor(text)
    except Exception: # pixie raises a Defect on "", not a CatchableError
      discard
  else:
    skipValue(s, i)

# ---------------------------------------------------------------------------
# Defaults, renames, clamps
# ---------------------------------------------------------------------------

proc newHook*(v: var HttpsProxyConfig) =
  v = HttpsProxyConfig(port: 8443)

proc newHook*(v: var PinOverrides) =
  ## -1 = keep the driver's default pin.
  v = PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1)

proc renameHook*(v: var PinOverrides, fieldName: var string) =
  if fieldName == "sck":
    fieldName = "sclk"

proc newHook*(v: var DeviceConfig) =
  v = DeviceConfig()
  newHook(v.pins)

proc renameHook*(v: var DeviceConfig, fieldName: var string) =
  case fieldName
  of "uploadUrl": fieldName = "httpUploadUrl"
  of "uploadHeaders": fieldName = "httpUploadHeaders"
  else: discard

proc postHook*(v: var DeviceConfig) =
  if v.pins == nil:
    newHook(v.pins)
  var headers: seq[HttpHeaderPair] = @[]
  for header in v.httpUploadHeaders:
    let name = header.name.strip()
    if name.len > 0:
      headers.add(HttpHeaderPair(name: name, value: header.value))
  v.httpUploadHeaders = headers

proc newHook*(v: var ControlCode) =
  v = ControlCode(enabled: false, position: "top-right", size: 2, padding: 1,
                  qrCodeColor: parseHtmlColor("#000000"),
                  backgroundColor: parseHtmlColor("#ffffff"))

proc postHook*(v: var ControlCode) =
  # An unreadable (or fully transparent) colour is not a QR code anyone can
  # scan; fall back the way the old loader did.
  if v.qrCodeColor.a == 0: v.qrCodeColor = parseHtmlColor("#000000")
  if v.backgroundColor.a == 0: v.backgroundColor = parseHtmlColor("#ffffff")
  if v.position == "": v.position = "top-right"

proc newHook*(v: var NetworkConfig) =
  v = NetworkConfig(
    networkCheck: false,
    networkCheckTimeoutSeconds: 30,
    networkCheckUrl: "https://networkcheck.frameos.net",
    wifiHotspot: "disabled",
    wifiHotspotSsid: "FrameOS-Setup",
    wifiHotspotPassword: "frame1234",
    wifiHotspotTimeoutSeconds: 300,
    networkBackend: "auto",
    allowLocalNetworkAccess: false,
  )

proc newHook*(v: var JsRuntimeConfig) =
  ## Defaults live in js_runtime/burrito.nim (DefaultJs*); -1 means "keep what
  ## this build target chose", so an unset frame.json changes nothing.
  v = JsRuntimeConfig(executionTimeoutMs: -1, memoryLimitMb: -1, maxStackKb: -1, assetSandbox: "frame")

proc postHook*(v: var JsRuntimeConfig) =
  if v.assetSandbox notin ["frame", "scene"]:
    v.assetSandbox = "frame"

proc newHook*(v: var AgentConfig) =
  v = AgentConfig(agentEnabled: false)

proc newHook*(v: var MountpointConfig) =
  v = MountpointConfig(enabled: true)

proc postHook*(v: var MountpointConfig) =
  v.source = v.source.strip()
  v.target = v.target.strip()
  v.options = v.options.strip()

proc newHook*(v: var MountpointsConfig) =
  v = MountpointsConfig(enabled: false, items: @[])

proc postHook*(v: var MountpointsConfig) =
  # A null entry in the list is dropped, not mounted.
  var items: seq[MountpointConfig] = @[]
  for item in v.items:
    if item != nil:
      items.add(item)
  v.items = items

proc newHook*(v: var ErrorBehaviorConfig) =
  v = ErrorBehaviorConfig(mode: "show_error_retry", retrySeconds: 60, silentRetrySeconds: 60,
                          silentRetryForever: false, silentWindowMinutes: 10, showErrorRetrySeconds: 60)

proc renameHook*(v: var ErrorBehaviorConfig, fieldName: var string) =
  # The pre-2026.6 spelling.
  if fieldName == "silentRetryMinutes":
    fieldName = "silentWindowMinutes"

proc postHook*(v: var ErrorBehaviorConfig) =
  if v.mode notin ["safe_mode", "show_error_retry", "silent_retry"]:
    v.mode = "show_error_retry"
  if v.retrySeconds <= 0: v.retrySeconds = 60
  if v.silentRetrySeconds <= 0: v.silentRetrySeconds = 60
  if v.silentWindowMinutes <= 0: v.silentWindowMinutes = 10
  if v.showErrorRetrySeconds <= 0: v.showErrorRetrySeconds = 60

proc newHook*(v: var TimeZoneUpdatesConfig) =
  v = TimeZoneUpdatesConfig(enabled: true, hour: 3, url: DefaultTimeZoneUpdatesUrl)

proc postHook*(v: var TimeZoneUpdatesConfig) =
  if v.hour < 0 or v.hour > 23: v.hour = 3
  if v.url == "": v.url = DefaultTimeZoneUpdatesUrl

proc newHook*(v: var FrameSchedule) =
  v = FrameSchedule(events: @[])

proc postHook*(v: var FrameSchedule) =
  var events: seq[ScheduledEvent] = @[]
  for event in v.events:
    if event != nil:
      events.add(event)
  v.events = events

proc newHook*(v: var PaletteConfig) =
  v = PaletteConfig(colors: @[])

proc parseHook*(s: string, i: var int, v: var PaletteConfig) =
  ## {"colors": ["#rrggbb", …]} → RGB triples. One unreadable colour empties
  ## the whole palette (the driver then uses its built-in one) rather than
  ## shifting every colour after it.
  var data: JsonNode
  parseHook(s, i, data)
  newHook(v)
  if data == nil or data.kind != JObject or data{"colors"} == nil or data{"colors"}.kind != JArray:
    return
  for entry in data["colors"].items:
    try:
      let color = parseHtmlColor(entry.getStr())
      v.colors.add((int(color.r * 255), int(color.g * 255), int(color.b * 255)))
    except Exception:
      echo "Warning: Invalid color in palette: ", entry.getStr()
      v.colors = @[]
      return

proc newHook*(v: var FrameConfig) =
  v = FrameConfig(
    mode: "rpios",
    serverSendLogs: true,
    metricsInterval: 60,
    maxHttpResponseBytes: DefaultMaxHttpResponseBytes,
    frameAdminAuth: %*{},
    assetsPath: DefaultAssetsPath,
    saveAssets: %*false,
    gpioButtons: @[],
  )
  newHook(v.httpsProxy)
  newHook(v.deviceConfig)
  newHook(v.timeZoneUpdates)
  newHook(v.schedule)
  newHook(v.controlCode)
  newHook(v.network)
  newHook(v.agent)
  newHook(v.mountpoints)
  newHook(v.errorBehavior)
  newHook(v.palette)
  newHook(v.js)

proc setConfigDefaults*(config: var FrameConfig) =
  ## Zero values → defaults, and every nested object present. Also the safety
  ## net for configs built by hand (tests, the embedded builds) and for a
  ## frame.json that spells a whole section as `null`.
  if config == nil: newHook(config)
  if config.serverPort == 0: config.serverPort = 8989
  if config.width == 0: config.width = 1920
  if config.height == 0: config.height = 1080
  if config.device == "": config.device = "web_only"
  # 0 means "metrics disabled" (metrics.nim); only a negative value — never a
  # real period — falls back to the default. An absent key defaults in newHook.
  if config.metricsInterval < 0: config.metricsInterval = 60
  if config.maxHttpResponseBytes <= 0: config.maxHttpResponseBytes = DefaultMaxHttpResponseBytes
  if config.scalingMode == "": config.scalingMode = "cover"
  if config.framePort == 0: config.framePort = 8787
  if config.frameHost == "": config.frameHost = "localhost"
  if config.httpsProxy == nil: newHook(config.httpsProxy)
  if config.httpsProxy.port == 0: config.httpsProxy.port = 8443
  if config.frameAccess == "": config.frameAccess = "private"
  if config.frameAdminAuth == nil: config.frameAdminAuth = %*{}
  if config.name == "": config.name = config.frameHost
  if config.deviceConfig == nil: newHook(config.deviceConfig)
  if config.deviceConfig.pins == nil: newHook(config.deviceConfig.pins)
  if config.network == nil: newHook(config.network)
  if config.agent == nil: newHook(config.agent)
  if config.mountpoints == nil: newHook(config.mountpoints)
  if config.controlCode == nil: newHook(config.controlCode)
  if config.schedule == nil: newHook(config.schedule)
  if config.palette == nil: newHook(config.palette)
  if config.js == nil: newHook(config.js)
  if config.errorBehavior == nil: newHook(config.errorBehavior)
  postHook(config.errorBehavior)
  if config.assetsPath == "": config.assetsPath = DefaultAssetsPath
  config.assetsPath = config.assetsPath.strip(leading = false, trailing = true, chars = {'/'})
  if config.saveAssets == nil: config.saveAssets = %*false
  if config.timeZone == "": config.timeZone = detectSystemTimeZone()
  if config.timeZoneUpdates == nil: newHook(config.timeZoneUpdates)
  postHook(config.timeZoneUpdates)

proc parseFrameConfig*(data: string): FrameConfig =
  ## frame.json text → a complete FrameConfig (defaults applied). Pure: no
  ## file, environment or command-line reads — loadConfig layers those on.
  result = data.fromJson(FrameConfig)
  setConfigDefaults(result)

# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

proc getConfigFilename*(overridePath = ""): string =
  if overridePath.len > 0:
    return overridePath
  result = getEnv("FRAMEOS_CONFIG")
  if result == "":
    result = "./frame.json"

proc loadConfig*(configPath = ""): FrameConfig =
  let path = getConfigFilename(configPath)
  let encoded = readTextFile(path)
  result = parseFrameConfig(if path.endsWith(".gz"): uncompress(encoded) else: encoded)
  if commandLineParams().contains("--debug"):
    result.debug = true
  # SVG <text> resolves font-family names against the same fonts directory the
  # text apps use. pixie asks through a global hook, so it has to be told where
  # the assets live once, here, rather than per render.
  setSvgFontAssetsPath(result.assetsPath)
  # The private-network elevation lives in state/, not here — a backend deploy
  # rewrites frame.json wholesale and would drop it. Fold the stored value in
  # on every load, including the reload after a deploy, so the in-memory config
  # every reader consults (the hub's policy refresh, the admin API payload)
  # agrees with what the frame is actually enforcing.
  result.network.allowLocalNetworkAccess =
    resolveLocalNetworkAccess(result.network.allowLocalNetworkAccess)

proc updateFrameConfigFrom*(target: FrameConfig, source: FrameConfig) =
  ## Reload in place: every holder of the FrameConfig ref (the runner, the
  ## scheduler, the hub client, globalFrameConfig) sees the new values.
  if target == nil or source == nil:
    return
  target[] = source[]
