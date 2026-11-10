# The built-in embedded scene: what a frame shows before interpreted scenes
# have been pushed or loaded. It is the FrameOS status screen
# (frameos/utils/status_screen.nim) — the same one a Pi shows while booting
# and as its system/index scene — drawn black on white for e-ink, with the
# facts the C side pushes in through fos_nim_set_status_info_impl before each
# render pass (fos_client.c).

import std/[json, strformat, strutils]
import pixie
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

# The setup hotspot's join code, as the Pi's hotspot scene draws it
# (system/wifiHotspot): a phone's camera joins the network from it, with no
# password to type. Made once per network and size.
var
  hotspotQr: Image = nil
  hotspotQrKey = ""

proc wifiJoinCode(ssid, pass: string): string =
  ## `WIFI:T:WPA;S:…;P:…;;`, with `\ ; , : "` escaped.
  proc esc(text: string): string =
    for c in text:
      if c in {'\\', ';', ',', ':', '"'}: result.add '\\'
      result.add c
  "WIFI:T:WPA;S:" & esc(ssid) & ";P:" & esc(pass) & ";;"

proc hotspotQrImage(canvas: Image; code: string): Image =
  ## A third of the shorter edge in whole modules, as the index scene's link
  ## code: sharp, and never resized by the status screen.
  let target = max(96, int(min(canvas.width, canvas.height).float * 0.34))
  let key = code & ":" & $target
  if hotspotQr.isNil or hotspotQrKey != key:
    try:
      let qr = qrEncode(code)
      let modules = qr.size + 4
      hotspotQr = qr.qrImage(max(2, target div modules) * modules, padding = 2)
      hotspotQrKey = key
    except CatchableError:
      hotspotQr = nil
      hotspotQrKey = ""
  hotspotQr

proc buildStatusScreen*(canvas: Image; frameName: string): StatusScreen =
  ## Keys read from the pushed status: name, panel, ip, portal (bool),
  ## portal_ssid, portal_ip, cloud_url, cloud_state (none|pending|enrolled|
  ## error), cloud_connected (bool), backend_url, version, setup_on_screen
  ## (bool: a touch LCD, set up from the settings panel, no portal).
  let name = if str("name").len > 0: str("name") elif frameName.len > 0: frameName else: "Unnamed frame"
  let panel = if str("panel").len > 0: str("panel") else: "unknown panel"
  let ip = str("ip")
  let portal = flag("portal")
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

  let networkLine =
    if portal: "setup hotspot " & (if str("portal_ssid").len > 0: "“" & str("portal_ssid") & "”" else: "")
    elif ip.len > 0: ip
    else: "not connected"
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
  if ip.len > 0 and not portal:
    result.rows.add(("Frame", &"http://{ip}/"))
  result.footer = if version.len > 0: "FrameOS v" & version else: "FrameOS"
  result.status =
    if onScreen and ip.len == 0:
      "Not on Wi-Fi. Swipe down from the top of the screen to connect."
    elif portal and str("portal_pass").len > 0:
      "Not on Wi-Fi. Scan the code with a phone to join its setup hotspot."
    elif portal:
      "Not on Wi-Fi. Join the setup hotspot and open http://"  &
        (if str("portal_ip").len > 0: str("portal_ip") else: "192.168.4.1") & "/ to set up."
    elif cloudUrl.len > 0 and cloudState == "enrolled" and cloudConnected:
      "Connected to FrameOS Cloud. Add a scene from the workspace to get started."
    elif cloudUrl.len > 0 and cloudState == "enrolled": "Enrolled with FrameOS Cloud. Connecting…"
    elif cloudUrl.len > 0 and cloudState == "pending": "Enrolling with FrameOS Cloud…"
    elif cloudUrl.len > 0 and cloudState == "error":
      "FrameOS Cloud enrollment failed. Provision a new claim token."
    elif backendUrl.len > 0: "Waiting for the backend to deploy a scene."
    else: "No scenes installed yet."
  if portal and str("portal_ssid").len > 0:
    let pass = str("portal_pass")
    let ip = if str("portal_ip").len > 0: str("portal_ip") else: "192.168.4.1"
    # The network in the title: the aside's large code font is for a six-letter
    # link code, and a network's name in it wraps in a landscape column.
    result.aside.title = "Join the Wi-Fi “" & str("portal_ssid") & "”"
    # Short: a long hint takes the room the code needs on a landscape panel.
    result.aside.hint = (if pass.len > 0: "Password " & pass & " · then " else: "Then ") & "http://" & ip & "/"
    if pass.len > 0:
      result.aside.qr = hotspotQrImage(canvas, wifiJoinCode(str("portal_ssid"), pass))
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
