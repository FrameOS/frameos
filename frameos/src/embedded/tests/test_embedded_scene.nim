import std/[os, strutils, unittest]
import pixie
import frameos/utils/qr
import frameos/utils/status_screen
import frameos/panel_shape
import ../embedded_scene

# What an ESP32 shows before it has scenes (the status screen), and while its
# setup hotspot is up: the portal's screen, the QR code a phone joins the
# hotspot by with the network, its password and the setup page's address as
# words (renderPortalInto).
#
# FRAMEOS_PORTAL_SHOTS=<dir> writes each portal screen as a PNG to look at.

const
  Ssid = "FrameOS-1A2B"
  Pass = "abcdefghjk"

proc ink(canvas: Image; x, y: int): bool = canvas.data[canvas.dataIndex(x, y)].r < 128

proc codeFor(w, h: int; pass = Pass; round = false): (PortalPlan, Image, int) =
  ## The plan for a panel, the code as the screen must show it there, and
  ## its pixels a module.
  let qr = qrEncode(wifiJoinCode(Ssid, pass))
  let plan = planPortal(w, h, qr.size, portalLines(Ssid, pass, "").len, round)
  (plan, (if plan.code > 0: qr.qrImage(plan.code, padding = 2) else: nil), plan.code div (qr.size + 4))

proc findCode(canvas, code: Image; unit: int): seq[(int, int)] =
  ## Where `code` is on the canvas pixel for pixel: unscaled, on whole
  ## pixels, nothing drawn over it.
  for y in 0 .. canvas.height - code.height:
    for x in 0 .. canvas.width - code.width:
      # A finder pattern's corner (dark) just inside the quiet zone (light).
      if not canvas.ink(x + 2 * unit, y + 2 * unit) or canvas.ink(x + 2 * unit - 1, y + 2 * unit - 1):
        continue
      var same = true
      for cy in 0 ..< code.height:
        for cx in 0 ..< code.width:
          let a = canvas.data[canvas.dataIndex(x + cx, y + cy)]
          let b = code.data[code.dataIndex(cx, cy)]
          if a.r != b.r or a.g != b.g or a.b != b.b:
            same = false
            break
        if not same: break
      if same: result.add((x, y))

proc drawPortal(w, h: int; dark: bool; pass = Pass; round = false): Image =
  setPortalScreen(Ssid, pass, "192.168.4.1")
  check portalScreenOn()
  result = renderPortalInto(newImage(w, h), dark, round)
  clearPortalScreen()
  check not portalScreenOn()

proc shot(canvas: Image; name: string) =
  let shots = getEnv("FRAMEOS_PORTAL_SHOTS")
  if shots.len > 0:
    createDir(shots)
    canvas.writeFile(shots / (name & ".png"))

suite "the ESP32's portal screen":
  test "the hotspot's join code escapes what the format reserves":
    check wifiJoinCode("FrameOS-23D0", "kq7v;x2m") == "WIFI:T:WPA;S:FrameOS-23D0;P:kq7v\\;x2m;;"
    check wifiJoinCode("a,b", "p:q\"r\\s") == "WIFI:T:WPA;S:a\\,b;P:p\\:q\\\"r\\\\s;;"
    check wifiJoinCode("Open", "") == "WIFI:T:nopass;S:Open;;"

  test "the words: the network, its password, the setup page":
    check portalLines(Ssid, Pass, "") == @["Wi-Fi: FrameOS-1A2B", "Password: abcdefghjk", "http://192.168.4.1/"]
    check portalLines(Ssid, "", "10.0.0.1") == @["Wi-Fi: FrameOS-1A2B", "http://10.0.0.1/"]

  test "the code on every panel, pixel for pixel, on the right background":
    for (w, h) in [(800, 480), (480, 800), (1200, 1600), (1600, 1200), (480, 480), (720, 720),
                   (400, 300), (296, 128), (250, 122), (122, 250), (200, 200)]:
      for dark in [false, true]:
        let canvas = drawPortal(w, h, dark)
        canvas.shot("portal_" & $w & "x" & $h & (if dark: "_lcd" else: "_epaper"))
        let (plan, code, unit) = codeFor(w, h)
        checkpoint($w & "x" & $h & (if dark: " dark" else: " light") & " " & $plan)
        # A phone reads it: three pixels a module or more.
        check unit >= 3
        check not code.isNil and code.width == plan.code
        # Its picture stays a megabyte or less, on the largest panels too.
        check plan.code <= 512
        let found = canvas.findCode(code, unit)
        check found.len == 1
        if found.len != 1: continue
        let (x, y) = found[0]
        # White on e-paper, black on an LCD, and nothing against the edge:
        # what did not fit would be cut there.
        var atEdge = 0
        for ex in 0 ..< w:
          for ey in [0, h - 1]:
            if canvas.ink(ex, ey) != dark: inc atEdge
        for ey in 0 ..< h:
          for ex in [0, w - 1]:
            if canvas.ink(ex, ey) != dark: inc atEdge
        check atEdge == 0
        # Beside its words on a wide panel, over them on a tall one.
        check plan.wide == (w * 20 >= h * 23)
        if plan.wide: check x + code.width div 2 < w div 2
        else: check y + code.height div 2 < h * 6 div 10 and abs(2 * x + code.width - w) <= 1
        # A header where the panel has the room.
        check (plan.mark > 0) == (min(w, h) >= 240)

  test "a round panel keeps everything inside its circle":
    for side in [466, 480, 720]:
      for dark in [false, true]:
        let canvas = drawPortal(side, side, dark, round = true)
        canvas.shot("portal_round_" & $side & (if dark: "_lcd" else: "_epaper"))
        let (_, code, unit) = codeFor(side, side, round = true)
        check unit >= 3
        check canvas.findCode(code, unit).len == 1
        # Every pixel that is not the background lies inside the circle,
        # clear of the bezel (RoundInset, less a pixel of antialiasing).
        var outside = 0
        for y in 0 ..< side:
          for x in 0 ..< side:
            if not insideRound(side, side, x, y, RoundInset - 2) and canvas.ink(x, y) != dark:
              inc outside
        check outside == 0

  test "a panel too small for a code gets the facts as text":
    let (plan, code, _) = codeFor(72, 40)
    check plan.code == 0 and code.isNil
    let canvas = drawPortal(72, 40, false)
    canvas.shot("portal_72x40_epaper")
    var inked = 0
    for y in 0 ..< 40:
      for x in 0 ..< 72:
        if canvas.ink(x, y): inc inked
    check inked > 40

  test "an open hotspot has no password line":
    let canvas = drawPortal(800, 480, false, pass = "")
    let (plan, code, unit) = codeFor(800, 480, pass = "")
    check plan.code > 0
    check canvas.findCode(code, unit).len == 1

suite "the ESP32's status screen":
  test "on Wi-Fi there is no hotspot code":
    setStatusInfo("""{"name": "Kitchen", "panel": "waveshare.EPD_10in3", "portal": false, "ip": "10.0.0.5"}""")
    let screen = buildStatusScreen(newImage(800, 480), "")
    check screen.aside.title == "" and screen.aside.qr.isNil
    check "10.0.0.5" in statusScreenText(screen)
