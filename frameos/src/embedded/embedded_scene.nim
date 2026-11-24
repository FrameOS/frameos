# The built-in embedded scene: what a frame shows before interpreted scenes
# have been pushed or loaded. It is the FrameOS status screen
# (frameos/utils/status_screen.nim) — the same one a Pi shows while booting
# and as its system/index scene — drawn black on white for e-ink, with the
# facts the C side pushes in through fos_nim_set_status_info_impl before each
# render pass (fos_client.c).

import std/[json, math, strformat, strutils]
import pixie
import pixie/fileformats/svg
import frameos/panel_shape
import frameos/ui/layout
import frameos/ui/tree
import frameos/utils/image
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
# What a frame with no Wi-Fi shows while its setup hotspot is up: the code a
# phone's camera joins the hotspot by (the first of the two the Pi's hotspot
# scene draws, system/wifiHotspot), with the network's name and password and
# the setup page's address as words. One code: a phone that joins is sent to
# the setup page by the portal itself (fos_wifi.c answers every DNS query),
# and the address is there for one that is not. The render task draws it once
# when the portal starts (fos_client.c show_portal_screen), between
# setPortalScreen and clearPortalScreen, so no scene render ever draws it. A
# board without the runtime shows the same facts as lines of 5x7 text
# (embedded/esp32/main/fos_status_screen.c).
#
# A UI tree built here and laid out by the UI layer, as the built-in scenes'
# and a link's QR card (ui/layout.nim linkCard) are: the sizes are decided
# here, from the panel's, in whole pixels a module, and the layout puts the
# header, the code and the words in their places.

when defined(frameosEmbedded):
  {.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

type
  PortalPlan* = object
    w*, h*: int     ## what it is drawn in: the panel less its margins, or a rectangle inside a round one's circle
    pad*: int       ## the margin, and the gap between its parts
    text*: int      ## the words' size
    mark*: int      ## the header's height; 0: none
    wide*: bool     ## the code beside its words; else over them
    code*: int      ## the code's side, its quiet zone included; 0: none fits, the words alone

const
  PortalStatus = "Set up Wi-Fi with your phone"
  PortalQuiet = 2 # modules of white around the code
  PortalCodeMax = 512
    ## The code's side at most: its picture is four bytes a pixel, so a
    ## megabyte here, where a 13.3" panel has the room for one of four and
    ## its 8 MB board has not the memory.

var portalScreen: tuple[on: bool, ssid, pass, ip: string]

proc setPortalScreen*(ssid, pass, ip: string) =
  portalScreen = (true, ssid, pass, ip)

proc clearPortalScreen*() =
  portalScreen = (false, "", "", "")

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

proc portalLines*(ssid, pass, ip: string): seq[string] =
  ## The words: what the code says, and where the setup page is.
  result = @["Wi-Fi: " & ssid]
  if pass.len > 0: result.add("Password: " & pass)
  result.add("http://" & (if ip.len > 0: ip else: "192.168.4.1") & "/")

proc planPortal*(width, height, modules, lines: int; round: bool): PortalPlan =
  ## The sizes, for a code `modules` wide and `lines` of words. The code gets
  ## the room first: beside its words on a wide panel, over them on a tall or
  ## square one, a header above both where the panel is large enough for one.
  ## On a round panel everything stays in a rectangle inside its circle, the
  ## one that is as wide as the code. If no code a phone reads fits (under
  ## two pixels a module), `code` is 0.
  var small = min(width, height)
  # A round panel's circle, its bezel kept clear, and the square inside it.
  let across = small - 2 * RoundInset
  if round:
    small = across * 70 div 99
  result.pad = max(2, small div 20)
  result.text = clamp(small * 45 div 1000, 8, 44)
  result.wide = not round and width * 20 >= height * 23
  if small >= 240:
    result.mark = clamp(small div 10, 24, 140)
  result.w = width - 2 * result.pad
  result.h = height - 2 * result.pad
  # What stands over and under the code: the header, and the words when they
  # are not beside it.
  var rest = if result.mark > 0: result.mark + result.pad else: 0
  if not result.wide:
    rest += lines * (result.text * 5 div 4) + result.pad
  var side = if result.wide: min(result.h - rest, result.w * 55 div 100) else: min(result.w, result.h - rest)
  if round:
    # side² + (side + rest)² = across²: its corners on the circle.
    side = (int(sqrt(float(max(2 * across * across - rest * rest, 0)))) - rest) div 2
    result.w = side
    result.h = side + rest
  let unit = min(side, PortalCodeMax) div (modules + 2 * PortalQuiet)
  if unit >= 2:
    result.code = unit * (modules + 2 * PortalQuiet)
    if result.wide:
      # The words have the column beside the code: as large as a line of
      # twenty letters (the password's) fits there.
      result.text = clamp((result.w - result.code - result.pad) div 12, 8, 44)

proc renderPortalInto*(canvas: Image; dark, round: bool): Image =
  ## The portal's screen over the whole of `canvas` (setPortalScreen's
  ## facts), returned. White on black on an LCD (`dark`), black on white on
  ## e-paper, the code on white either way: not every phone reads a
  ## light-on-dark one. Raises when it cannot be drawn; the firmware then
  ## shows its lines of text.
  result = canvas
  let
    s = portalScreen
    ssid = if s.ssid.len > 0: s.ssid else: "FrameOS"
    qr = qrEncode(wifiJoinCode(ssid, s.pass))
    lines = portalLines(ssid, s.pass, s.ip)
    plan = planPortal(canvas.width, canvas.height, qr.size, lines.len, round)
    fg = if dark: color(1, 1, 1, 1) else: color(0, 0, 0, 1)
  canvas.fill(if dark: color(0, 0, 0, 1) else: color(1, 1, 1, 1))

  # Words alone start at the top: what does not fit is the last of them.
  var c = if plan.code > 0: "flex flex-col items-center justify-center" else: "flex flex-col items-center"
  c.px("w", plan.w)
  c.px("h", plan.h)
  c.px("gap", plan.pad)
  let box = el("div", move c)
  if plan.mark > 0:
    # The status screen's header: the mark, the wordmark, one line.
    c = "flex items-center"
    c.px("gap", plan.mark * 3 div 10)
    let header = el("div", move c)
    let mark = el("img", "shrink-0")
    mark.image = frameosMark(plan.mark, fg, coloredSquares = dark)
    header.children.add mark
    let words = el("div", "flex flex-col")
    c = "leading-[1.2]"
    c.px("text", plan.mark * 62 div 100)
    words.children.add el("div", move c, SvgNode(text: "FrameOS"))
    c = "leading-[1.3]"
    c.px("text", plan.mark * 3 div 10)
    words.children.add el("div", move c, SvgNode(text: PortalStatus))
    header.children.add words
    box.children.add header
  c = if plan.wide: "flex items-center leading-[1.25]" else: "flex flex-col items-center text-center leading-[1.25]"
  c.px("gap", plan.pad)
  c.px("text", plan.text)
  let body = el("div", move c)
  if plan.code > 0:
    let code = el("img", "shrink-0")
    code.image = qr.qrImage(plan.code, padding = PortalQuiet)
    body.children.add code
  let words = el("div", "")
  for line in lines:
    words.children.add el("div", "", SvgNode(text: line))
  body.children.add words
  box.children.add body
  let root = el("div", if dark: "flex items-center justify-center w-full h-full text-white"
                       else: "flex items-center justify-center w-full h-full text-black", box)
  if not renderSvgIntoTarget(layoutUi(root, canvas.width, canvas.height), canvas):
    raise newException(ValueError, "the portal's screen was not drawn")

when defined(frameosEmbedded):
  {.pop.}
