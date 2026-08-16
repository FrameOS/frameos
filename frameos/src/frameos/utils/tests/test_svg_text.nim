import std/[options, os, strformat, unittest]
import pixie
import ../font
import ../image

## SVG <text> renders through the font bridge in utils/font.nim: pixie asks for
## a typeface per font-family candidate, and FrameOS answers from the frame's
## assets, degrading to the built-in face rather than failing the drawing.

proc inkPixels(image: Image): int =
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      # Rendered onto white, so anything drawn is darker than the background.
      if image[x, y].r < 200:
        inc result

proc render(body: string, width = 200, height = 100): Image =
  let svg = &"""<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}">
    <rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>{body}</svg>"""
  let image = decodeSvgWithFallback(svg, width, height)
  check image.isSome
  image.get()

suite "svg text":
  test "text renders with the built-in font":
    let image = render("""<text x="10" y="60" font-size="40">Hello</text>""")
    check inkPixels(image) > 50

  test "an unknown font-family degrades to the default face, never fails":
    let known = render("""<text x="10" y="60" font-size="40">Hello</text>""")
    let unknown = render(
      """<text x="10" y="60" font-size="40" font-family="Nonesuch Sans">Hello</text>""")
    check inkPixels(unknown) == inkPixels(known)

  test "an empty text element draws nothing and does not fail":
    let image = render("""<text x="10" y="60" font-size="40"></text>""")
    check inkPixels(image) == 0

  test "text elements no longer break the whole drawing":
    # Before <text> support, one text tag made parseSvg raise and the app
    # rendered an error image instead of the picture.
    let image = render(
      """<rect x="0" y="0" width="20" height="20" fill="#000000"/>""" &
      """<text x="10" y="60" font-size="20">and text</text>""")
    check image[5, 5] == rgbx(0, 0, 0, 255)
    check inkPixels(image) > 400

  test "text is positioned on the baseline given by y":
    let high = render("""<text x="10" y="30" font-size="20">Hi</text>""")
    let low = render("""<text x="10" y="90" font-size="20">Hi</text>""")
    var highTop, lowTop = -1
    for y in 0 ..< 100:
      for x in 0 ..< 200:
        if high[x, y].r < 200 and highTop < 0: highTop = y
        if low[x, y].r < 200 and lowTop < 0: lowTop = y
    check highTop >= 0 and lowTop >= 0
    check lowTop - highTop == 60

when not defined(frameosEmbedded):
  suite "svg font-family resolution":
    let root = getTempDir() / "frameos-svg-font-tests"
    let fontsDir = root / "fonts"

    setup:
      if dirExists(root):
        removeDir(root)
      createDir(fontsDir)
      # Never parsed by these tests: resolution picks the file name, and only
      # rendering would read it.
      writeFile(fontsDir / "Comic-Regular.ttf", "")
      writeFile(fontsDir / "Comic-Bold.ttf", "")
      writeFile(fontsDir / "Comic-BoldItalic.ttf", "")
      writeFile(fontsDir / "Plain.ttf", "")
      setSvgFontAssetsPath(root)

    teardown:
      setSvgFontAssetsPath("/srv/assets")
      if dirExists(root):
        removeDir(root)

    test "a family picks the weight and style variant that matches":
      check svgFontFileFor("Comic") == "Comic-Regular.ttf"
      check svgFontFileFor("Comic", weight = 700) == "Comic-Bold.ttf"
      check svgFontFileFor("Comic", weight = 700, italic = true) ==
        "Comic-BoldItalic.ttf"
      # No italic-only file: the regular face still says what the text says.
      check svgFontFileFor("Comic", italic = true) == "Comic-Regular.ttf"

    test "family names match file names loosely":
      check svgFontFileFor("comic") == "Comic-Regular.ttf"
      check svgFontFileFor("Comic Regular") == "Comic-Regular.ttf"
      check svgFontFileFor("Plain") == "Plain.ttf"
      check svgFontFileFor("Plain.ttf") == "Plain.ttf"

    test "generic and unknown families fall through to the default face":
      check svgFontFileFor("sans-serif") == ""
      check svgFontFileFor("monospace") == ""
      check svgFontFileFor("system-ui") == ""
      check svgFontFileFor("Nonesuch") == ""

    test "pointing at another assets path forgets the old answers":
      check svgFontFileFor("Comic") == "Comic-Regular.ttf"
      setSvgFontAssetsPath(getTempDir() / "frameos-svg-font-tests-empty")
      check svgFontFileFor("Comic") == ""
