# The built-in embedded scene: what a frame shows before interpreted scenes
# have been pushed or loaded. It is the FrameOS status screen
# (frameos/utils/status_screen.nim) — the same one a Pi shows while booting
# and as its system/index scene — drawn black on white for e-ink, with the
# facts the C side pushes in through fos_nim_set_status_info_impl before each
# render pass (fos_client.c).

import std/[json, strformat, strutils]
import pixie
import frameos/utils/font as fontUtils
import frameos/utils/qr
import frameos/utils/status_screen

# Fallback-scene parameters: the backend firmware build extracts these from
# the frame's scene JSON and passes them as -d: defines (see build_nim.sh and
# backend embedded_firmware.py).
const frameosSceneName {.strdefine.}: string = "default"
const frameosSceneBackground {.strdefine.}: string = "#ffffff"

# The last status pushed from C: name, panel, ip, portal ssid, cloud state…
# nil until the first push; the screen then shows what Nim knows on its own.
var statusInfo: JsonNode = nil

proc initScene*() =
  ## Deliberately does nothing but exist.
  ##
  ## This used to parse the default typeface, which is 1.57 MB of PSRAM on an
  ## ESP32-S3 — measured with -d:memProbe, it was the whole of the resident
  ## baseline apart from the 1 MB emergency reserve, and it was paid at boot by
  ## every frame whether or not anything ever drew text. The scene below is
  ## only rendered when no interpreted scene is loaded, and plenty of scenes
  ## (the bundled Weather scene, for one, which draws through SVG) never ask
  ## for a glyph at all.
  ##
  ## getDefaultTypeface already caches behind a lock, so the parse simply
  ## happens on the first piece of text instead of on every boot. Kept as a
  ## no-op rather than removed so the init sequence in embedded_main stays
  ## readable, and so there is somewhere for this explanation to live.
  discard

proc setStatusInfo*(infoJson: string) =
  ## Replaces the status facts (a JSON object; see buildStatusScreen for the
  ## keys). An unparseable payload keeps the previous one.
  try:
    let parsed = parseJson(infoJson)
    if parsed.kind == JObject:
      statusInfo = parsed
  except CatchableError:
    discard

proc str(key: string): string =
  if statusInfo.isNil: "" else: statusInfo{key}.getStr("")

proc flag(key: string): bool =
  if statusInfo.isNil: false else: statusInfo{key}.getBool(false)

proc buildStatusScreen*(canvas: Image; frameName: string): StatusScreen =
  ## Keys read from the pushed status: name, panel, ip, cloud_url,
  ## cloud_state (none|pending|enrolled|error), cloud_connected (bool),
  ## backend_url, version, setup_on_screen (bool: a touch LCD, set up from
  ## the settings panel, no portal). While the setup hotspot is up the
  ## portal's screen shows instead (renderPortalInto).
  let name = if str("name").len > 0: str("name") elif frameName.len > 0: frameName else: "Unnamed frame"
  let panel = if str("panel").len > 0: str("panel") else: "unknown panel"
  let ip = str("ip")
  let cloudUrl = str("cloud_url")
  let cloudState = str("cloud_state")
  let cloudConnected = flag("cloud_connected")
  let backendUrl = str("backend_url")
  let version = str("version")
  let onScreen = flag("setup_on_screen")

  var cloudHost = cloudUrl
  for prefix in ["https://", "http://"]:
    if cloudHost.startsWith(prefix):
      cloudHost = cloudHost[prefix.len .. ^1]
  cloudHost = cloudHost.split('/')[0]

  let networkLine = if ip.len > 0: ip else: "not connected"
  let managedVia =
    if cloudUrl.len > 0 and cloudState == "enrolled":
      &"FrameOS Cloud ({cloudHost}, " & (if cloudConnected: "connected" else: "disconnected") & ")"
    elif cloudUrl.len > 0 and cloudState == "pending": &"FrameOS Cloud ({cloudHost}, enrolling)"
    elif cloudUrl.len > 0 and cloudState == "error": &"FrameOS Cloud ({cloudHost}, enrollment failed)"
    elif backendUrl.len > 0: &"self-hosted backend ({backendUrl})"
    else: "standalone (no server configured)"

  result.dark = false
  result.rows = @[
    ("Name", name),
    ("Device", &"{panel} · {canvas.width}×{canvas.height}"),
    ("Network", networkLine),
    ("Managed via", managedVia),
  ]
  if ip.len > 0:
    result.rows.add(("Frame", &"http://{ip}/"))
  result.footer = if version.len > 0: "FrameOS v" & version else: "FrameOS"
  result.status =
    if onScreen and ip.len == 0:
      "Not on Wi-Fi. Swipe down from the top of the screen to connect."
    elif cloudUrl.len > 0 and cloudState == "enrolled" and cloudConnected:
      "Connected to FrameOS Cloud. Add a scene from the workspace to get started."
    elif cloudUrl.len > 0 and cloudState == "enrolled": "Enrolled with FrameOS Cloud. Connecting…"
    elif cloudUrl.len > 0 and cloudState == "pending": "Enrolling with FrameOS Cloud…"
    elif cloudUrl.len > 0 and cloudState == "error":
      "FrameOS Cloud enrollment failed. Provision a new claim token."
    elif backendUrl.len > 0: "Waiting for the backend to deploy a scene."
    else: "No scenes installed yet."
  result.notes = @["No scenes installed yet."]
  if onScreen:
    result.notes.add("Swipe down from the top for the frame's settings.")
  if frameosSceneName.len > 0 and frameosSceneName != "default":
    result.notes.add("Built-in scene: " & frameosSceneName)

proc renderDemoInto*(canvas: Image; frameName: string; renderCount: int): Image =
  ## Draws the status screen into `canvas` (the persistent canvas) and returns
  ## it. `renderCount` is unused on purpose: a screen that changes every pass
  ## defeats the packed-image hash that spares e-ink a refresh when nothing
  ## changed.
  discard renderCount
  result = canvas
  drawStatusScreen(result, buildStatusScreen(canvas, frameName))
  # A baked non-white background (frameosSceneBackground) used to tint the
  # demo scene; the status screen is black-on-white by design, so the value
  # is only kept for the build that still passes it.
  discard frameosSceneBackground

# ------------------------------------------------------- the portal's screen
#
# What a frame with no Wi-Fi shows while its setup hotspot is up: the two QR
# codes of the Pi's hotspot scene (system/wifiHotspot), one that joins the
# hotspot and one that opens the setup page, each with what it says under it,
# under the status screen's header. The render task draws it once when the
# portal starts (fos_client.c show_portal_screen), between setPortalScreen
# and clearPortalScreen, so no scene render ever draws it. A board without
# the runtime draws the same layout in C, in the 5x7 font
# (embedded/esp32/main/fos_portal_screen.c): keep the two alike.
#
# Plain values in the plan (no seq, no ref): each copy of an object holding
# one is a copy hook in the ESP32 image. Unchecked there, as utils/qr.nim:
# every index is a module of a code or one of two cards, every size comes
# from the panel's; the tests run it with every check on.

when defined(frameosEmbedded):
  {.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

type
  PortalPlan* = object
    columns*: bool          ## side by side; else one above the other
    header*: bool
    unit*: array[2, int]    ## pixels a module; 0: no codes, the captions alone
    x*, y*: array[2, int]   ## each code's first module, quiet zone excluded
    captionX*, captionY*: array[2, float32]
    cardWidth*, captionSize*: float32

const
  PortalStatus = "Set up Wi-Fi with your phone"
  PortalQuiet = 2 # modules of white around a code
  PortalLeading = 1.25'f32

var portalScreen: tuple[on: bool, ssid, pass, ip: string, dark: bool]

proc setPortalScreen*(ssid, pass, ip: string; dark: bool) =
  portalScreen = (true, ssid, pass, ip, dark)

proc clearPortalScreen*() =
  portalScreen = (false, "", "", "", false)

proc portalScreenOn*(): bool = portalScreen.on

proc wifiJoinCode*(ssid, pass: string): string =
  ## `WIFI:T:WPA;S:…;P:…;;` (`T:nopass` without a passphrase), with
  ## `\ ; , : "` escaped, as the Pi's hotspot scene writes it.
  proc esc(text: string): string =
    for c in text:
      if c in {'\\', ';', ',', ':', '"'}: result.add '\\'
      result.add c
  if pass.len == 0: "WIFI:T:nopass;S:" & esc(ssid) & ";;"
  else: "WIFI:T:WPA;S:" & esc(ssid) & ";P:" & esc(pass) & ";;"

proc portalUrl*(ip: string): string =
  "http://" & (if ip.len > 0: ip else: "192.168.4.1") & "/"

proc portalCaptions*(ssid, pass, ip: string): array[2, seq[string]] =
  result[0] = @["1. Join the Wi-Fi", ssid]
  if pass.len > 0: result[0].add("Password: " & pass)
  result[1] = @["2. Then open", portalUrl(ip)]

proc portalFont(size: float32; color: Color): Font =
  result = newFont(fontUtils.getDefaultTypeface())
  result.size = size
  result.paint = newPaint(SolidPaint)
  result.paint.color = color

proc headerHeight(small: float32): float32 = clamp(small * 0.1, 24, 140)
proc portalMargin(small: float32): float32 = max(6'f32, small * 0.05)

proc planPortal*(width, height: int; modules: array[2, int]; captions: array[2, seq[string]]): PortalPlan =
  ## Where everything goes, for codes `modules` wide. The codes first: as
  ## large as the panel allows, side by side on a wide panel and stacked on a
  ## tall one unless the other way gives codes a quarter larger; the captions
  ## at one size that fits the widest line. The header goes when the codes
  ## would be under two pixels a module with it; if they are so without it
  ## too, `unit` is 0.
  let
    w = width.float32
    h = height.float32
    small = min(w, h)
    margin = portalMargin(small)
    gutter = max(w, h) / 20
    wanted = clamp(small * 0.045, 8, 44)
    lines = max(captions[0].len, captions[1].len).float32
  let probe = portalFont(wanted, color(0, 0, 0, 1))
  var widest = 1'f32
  for caption in captions:
    for line in caption:
      widest = max(widest, probe.layoutBounds(line).x)

  for withHeader in [true, false]:
    let top = margin + (if withHeader: headerHeight(small) + margin else: 0)
    let areaW = w - 2 * margin
    let areaH = h - top - margin
    var plans: array[2, PortalPlan] # side by side, stacked
    var sides: array[2, int]
    for arrangement in 0 .. 1:
      let columns = arrangement == 0
      let cardW = if columns: (areaW - gutter) / 2 else: areaW
      let cardH = if columns: areaH else: (areaH - gutter) / 2
      let size = max(8'f32, min(wanted, wanted * cardW * 0.97 / widest))
      let captionH = lines * size * PortalLeading
      let tile = int(min(cardW, cardH - captionH - size * 0.5))
      var plan = PortalPlan(columns: columns, header: withHeader, cardWidth: cardW, captionSize: size)
      var side = 0
      for i in 0 .. 1:
        plan.unit[i] = max(0, tile) div (modules[i] + 2 * PortalQuiet)
        side = max(side, plan.unit[i] * (modules[i] + 2 * PortalQuiet))
      if min(plan.unit[0], plan.unit[1]) < 2: continue
      let blockH = side.float32 + size * 0.5 + captionH
      for i in 0 .. 1:
        let cardX = margin + (if columns: i.float32 * (areaW - cardW) else: 0)
        let cardY = top + (if columns: 0'f32 else: i.float32 * (areaH - cardH))
        let blockTop = cardY + (cardH - blockH) / 2
        let own = plan.unit[i] * (modules[i] + 2 * PortalQuiet)
        plan.x[i] = int(cardX + (cardW - own.float32) / 2) + plan.unit[i] * PortalQuiet
        plan.y[i] = int(blockTop) + (side - own) div 2 + plan.unit[i] * PortalQuiet
        plan.captionX[i] = cardX
        plan.captionY[i] = blockTop + side.float32 + size * 0.5
      plans[arrangement] = plan
      sides[arrangement] = side
    if sides[0] == 0 and sides[1] == 0: continue
    var pick = if w >= h: 0 else: 1
    if sides[1 - pick] * 4 > sides[pick] * 5: pick = 1 - pick
    return plans[pick]
  # Too small for a code a phone reads (the 72x40 OLED): the captions alone.
  result.header = height >= 160
  result.cardWidth = w - 2 * margin
  result.captionSize = max(8'f32, min(wanted, wanted * result.cardWidth * 0.97 / widest))

proc renderPortalInto*(canvas: Image): Image =
  ## The portal's screen over the whole of `canvas` (setPortalScreen's
  ## facts), returned. White on black on an LCD, black on white on e-paper,
  ## the codes on white either way: not every phone reads a light-on-dark one.
  result = canvas
  let s = portalScreen
  let fg = if s.dark: color(1, 1, 1, 1) else: color(0, 0, 0, 1)
  canvas.fill(if s.dark: color(0, 0, 0, 1) else: color(1, 1, 1, 1))
  let ssid = if s.ssid.len > 0: s.ssid else: "FrameOS"
  let codes = [qrEncode(wifiJoinCode(ssid, s.pass)), qrEncode(portalUrl(s.ip))]
  let captions = portalCaptions(ssid, s.pass, s.ip)
  let plan = planPortal(canvas.width, canvas.height, [codes[0].size, codes[1].size], captions)
  let w = canvas.width.float32
  let small = min(w, canvas.height.float32)
  let margin = portalMargin(small)

  var y = margin
  if plan.header:
    # The status screen's header, centred: the mark, the wordmark, one line.
    let mh = headerHeight(small)
    let mark = frameosMark(int(mh), fg, coloredSquares = s.dark)
    let titleFont = portalFont(mh * 0.62, fg)
    let statusFont = portalFont(mh * 0.3, fg)
    let titleH = mh * 0.62 * 1.2
    let statusH = mh * 0.3 * 1.3
    let textW = max(titleFont.layoutBounds("FrameOS").x, statusFont.layoutBounds(PortalStatus).x)
    let x = max(margin, (w - mark.width.float32 - mh * 0.3 - textW) / 2)
    let textX = x + mark.width.float32 + mh * 0.3
    let textY = y + (mh - titleH - statusH) / 2
    canvas.draw(mark, translate(vec2(x, y + (mh - mark.height.float32) / 2)))
    canvas.fillText(titleFont.typeset("FrameOS", bounds = vec2(w, titleH), vAlign = MiddleAlign),
      translate(vec2(textX, textY)))
    canvas.fillText(statusFont.typeset(PortalStatus, bounds = vec2(w, statusH), vAlign = MiddleAlign),
      translate(vec2(textX, textY + titleH)))
    y += mh + margin

  let font = portalFont(plan.captionSize, fg)
  let lineH = plan.captionSize * PortalLeading
  let codesShown = plan.unit[0] > 0
  for i in 0 .. 1:
    var ly = y
    var x = margin
    var align = LeftAlign
    if codesShown:
      let unit = plan.unit[i]
      canvas.draw(codes[i].qrImage(unit * (codes[i].size + 2 * PortalQuiet), padding = PortalQuiet),
        translate(vec2(float32(plan.x[i] - unit * PortalQuiet), float32(plan.y[i] - unit * PortalQuiet))))
      ly = plan.captionY[i]
      x = plan.captionX[i]
      align = CenterAlign
    for line in captions[i]:
      canvas.fillText(font.typeset(line, bounds = vec2(plan.cardWidth, lineH), hAlign = align,
        vAlign = MiddleAlign, wrap = false), translate(vec2(x, ly)))
      ly += lineH
    y = ly # no codes: the second caption under the first

when defined(frameosEmbedded):
  {.pop.}
