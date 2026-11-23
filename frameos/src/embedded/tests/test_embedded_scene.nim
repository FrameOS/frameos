import std/[os, strutils, unittest]
import pixie
import frameos/utils/qr
import frameos/utils/status_screen
import ../embedded_scene

# What an ESP32 shows before it has scenes (the status screen), and while its
# setup hotspot is up: the portal's screen, two QR codes, one that joins the
# hotspot and one that opens the setup page (renderPortalInto).
#
# FRAMEOS_PORTAL_SHOTS=<dir> writes each portal screen as a PNG to look at.

proc readsBack(canvas: Image; plan: PortalPlan; i: int; qr: QrCode): bool =
  ## Every module's centre on the canvas is the code's.
  let unit = plan.unit[i]
  for my in 0 ..< qr.size:
    for mx in 0 ..< qr.size:
      let px = canvas[plan.x[i] + mx * unit + unit div 2, plan.y[i] + my * unit + unit div 2]
      if (px.r < 128) != qr[mx, my]:
        return false
  true

proc planFor(w, h: int; pass = "abcdefghjk"; ip = "192.168.4.1"): (PortalPlan, array[2, QrCode]) =
  let codes = [qrEncode(wifiJoinCode("FrameOS-1A2B", pass)), qrEncode(portalUrl(ip))]
  (planPortal(w, h, [codes[0].size, codes[1].size], portalCaptions("FrameOS-1A2B", pass, ip)), codes)

suite "the ESP32's portal screen":
  test "the hotspot's join code escapes what the format reserves":
    check wifiJoinCode("FrameOS-23D0", "kq7v;x2m") == "WIFI:T:WPA;S:FrameOS-23D0;P:kq7v\\;x2m;;"
    check wifiJoinCode("a,b", "p:q\"r\\s") == "WIFI:T:WPA;S:a\\,b;P:p\\:q\\\"r\\\\s;;"
    check wifiJoinCode("Open", "") == "WIFI:T:nopass;S:Open;;"

  test "both codes on every panel, readable, on the right background":
    let shots = getEnv("FRAMEOS_PORTAL_SHOTS")
    for (w, h) in [(800, 480), (480, 800), (1200, 1600), (1600, 1200), (480, 480), (720, 720),
                   (400, 300), (250, 122), (122, 250)]:
      for dark in [false, true]:
        setPortalScreen("FrameOS-1A2B", "abcdefghjk", "192.168.4.1", dark)
        check portalScreenOn()
        let canvas = renderPortalInto(newImage(w, h))
        clearPortalScreen()
        let (plan, codes) = planFor(w, h)
        check plan.unit[0] >= 2 and plan.unit[1] >= 2
        check canvas.readsBack(plan, 0, codes[0])
        check canvas.readsBack(plan, 1, codes[1])
        # White on e-paper, black on an LCD.
        let corner = canvas[0, h - 1]
        check (corner.r < 128) == dark
        # Wide panels side by side, tall ones stacked.
        if w * 3 >= h * 5: check plan.columns
        if h * 3 >= w * 5: check not plan.columns
        if shots.len > 0:
          createDir(shots)
          canvas.writeFile(shots / ("portal_" & $w & "x" & $h & (if dark: "_lcd" else: "_epaper") & ".png"))
    check not portalScreenOn()

  test "a panel too small for a code gets the facts as text":
    let (plan, _) = planFor(72, 40)
    check plan.unit[0] == 0
    setPortalScreen("FrameOS-1A2B", "abcdefghjk", "192.168.4.1", false)
    discard renderPortalInto(newImage(72, 40))
    clearPortalScreen()

  test "an open hotspot has no password line":
    let captions = portalCaptions("FrameOS-1A2B", "", "")
    check captions[0] == @["1. Join the Wi-Fi", "FrameOS-1A2B"]
    check captions[1][1] == "http://192.168.4.1/"
    let (plan, codes) = planFor(800, 480, pass = "", ip = "")
    setPortalScreen("FrameOS-1A2B", "", "", false)
    let canvas = renderPortalInto(newImage(800, 480))
    clearPortalScreen()
    check canvas.readsBack(plan, 0, codes[0])

suite "the ESP32's status screen":
  test "on Wi-Fi there is no hotspot code":
    setStatusInfo("""{"name": "Kitchen", "panel": "waveshare.EPD_10in3", "portal": false, "ip": "10.0.0.5"}""")
    let screen = buildStatusScreen(newImage(800, 480), "")
    check screen.aside.title == "" and screen.aside.qr.isNil
    check "10.0.0.5" in statusScreenText(screen)
