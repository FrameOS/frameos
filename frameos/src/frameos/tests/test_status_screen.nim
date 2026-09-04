import std/strutils
import pixie
import ../utils/status_screen

proc sampleQr(size: int): Image =
  ## A white tile with a black square: enough to see where the QR landed.
  result = newImage(size, size)
  result.fill(color(1, 1, 1, 1))
  var path = newPath()
  path.rect(float32(size div 4), float32(size div 4), float32(size div 2), float32(size div 2))
  result.fillPath(path, color(0, 0, 0, 1))

proc maxWhiteRun(image: Image, x0, x1, y0, y1: int): int =
  ## The longest horizontal run of white pixels in the box: text never makes
  ## one wider than a few px, the QR tile's quiet zone spans its whole width.
  for y in y0 ..< y1:
    var run = 0
    for x in x0 ..< x1:
      let c = image[x, y]
      if c.r > 250 and c.g > 250 and c.b > 250:
        inc run
        result = max(result, run)
      else:
        run = 0

proc linkScreen(): StatusScreen =
  StatusScreen(dark: true, status: "No scenes installed yet.",
    rows: @[("Name", "uus2w"), ("Network", "10.8.0.62 (wlan0)"), ("Managed via", "standalone")],
    notes: @["No scenes installed yet."], footer: "FrameOS v2026.9.6",
    aside: StatusAside(title: "Connect to FrameOS Cloud", code: "S2QU-KRWR",
      hint: "Scan, or enter the code at https://cloud.frameos.net/device", qr: sampleQr(160)))

block test_text_carries_the_aside:
  let text = statusScreenText(linkScreen())
  doAssert text.contains("Connect to FrameOS Cloud\nS2QU-KRWR\nScan, or enter the code"), text
  doAssert not statusScreenText(StatusScreen(status: "x")).contains("Connect"), "no aside, no lines"

block test_landscape_aside_takes_the_right_column:
  let image = newImage(800, 480)
  drawStatusScreen(image, linkScreen())
  # The QR's white tile lands in the right third; the rows on the left are
  # text on black (anti-aliased white pixels, never a tile's worth).
  let right = maxWhiteRun(image, 540, 800, 0, 480)
  let left = maxWhiteRun(image, 0, 260, 0, 480)
  doAssert right >= 100, "QR tile expected on the right, widest white run: " & $right
  doAssert left < 90, "left column should not carry the tile, widest white run: " & $left

block test_portrait_aside_follows_the_notes:
  let image = newImage(480, 800)
  drawStatusScreen(image, linkScreen())
  # Below the rows, not beside them: no tile in the top third, a tile lower down.
  let top = maxWhiteRun(image, 0, 480, 0, 260)
  let lower = maxWhiteRun(image, 0, 480, 260, 800)
  doAssert lower >= 100, "tile expected below the rows, widest white run: " & $lower
  doAssert top < 90, "no tile in the header/rows area, widest white run: " & $top

block test_screen_without_aside_is_unchanged:
  var screen = linkScreen()
  screen.aside = StatusAside()
  doAssert not screen.hasAside()
  let image = newImage(800, 480)
  drawStatusScreen(image, screen)
  doAssert maxWhiteRun(image, 540, 800, 0, 480) < 90
