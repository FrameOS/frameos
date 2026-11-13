import std/[strutils, unittest]
import pixie
import frameos/utils/qr
import frameos/utils/status_screen
import ../embedded_scene

# What an ESP32 shows before it has scenes: the status screen, and while its
# setup hotspot is up, the code a phone joins that hotspot by.

suite "the ESP32's setup screen":
  test "the hotspot comes with a QR to join it and the password beside it":
    setStatusInfo("""{"name": "Kitchen", "panel": "waveshare.EPD_10in3", "portal": true,
      "portal_ssid": "FrameOS-23D0", "portal_pass": "kq7v;x2m", "portal_ip": "192.168.4.1"}""")
    let canvas = newImage(800, 480)
    let screen = buildStatusScreen(canvas, "")
    check "FrameOS-23D0" in screen.aside.title
    check "kq7v;x2m" in screen.aside.hint
    check "http://192.168.4.1/" in screen.aside.hint
    check not screen.aside.qr.isNil
    # Square, a third of the shorter edge at most, in whole modules.
    check screen.aside.qr.width == screen.aside.qr.height
    check screen.aside.qr.width <= 163 and screen.aside.qr.width >= 96
    # The code a phone reads: the password's `;` escaped, as the Pi's scene does.
    let expected = qrEncode("WIFI:T:WPA;S:FrameOS-23D0;P:kq7v\\;x2m;;")
    let modules = expected.size + 4
    check screen.aside.qr.width mod modules == 0
    drawStatusScreen(canvas, screen)

  test "on Wi-Fi there is no hotspot code":
    setStatusInfo("""{"name": "Kitchen", "panel": "waveshare.EPD_10in3", "portal": false, "ip": "10.0.0.5"}""")
    let screen = buildStatusScreen(newImage(800, 480), "")
    check screen.aside.title == "" and screen.aside.qr.isNil
