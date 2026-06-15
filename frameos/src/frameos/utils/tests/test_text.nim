import std/[options, sequtils, unittest]
import pixie
import ../font
import ../text

proc makeOptions(overflow = "fit-bounds", borderWidth = 0): TextRenderOptions =
  TextRenderOptions(
    text: "FrameOS text test",
    richTextMode: "disabled",
    position: "center",
    vAlign: "middle",
    padding: 4,
    font: "",
    fontColor: parseHtmlColor("#000000"),
    fontSize: 42,
    borderColor: parseHtmlColor("#ffffff"),
    borderWidth: borderWidth,
    overflow: overflow,
    assetsPath: ""
  )

suite "text layout helpers":
  test "visible overflow preserves scale and creates optional border layout":
    let layout = typesetIntoBounds(makeOptions(overflow = "visible", borderWidth = 2), 220, 100)

    check layout.fontScaleRatio == 1.0
    check layout.borderTypeset.isSome

    let (w, h) = measureTightImage(layout)
    check w > 0
    check h > 0

  test "fit-bounds scales text down in constrained bounds":
    let layout = typesetIntoBounds(makeOptions(overflow = "fit-bounds"), 220, 24)

    check layout.fontScaleRatio > 0
    check layout.fontScaleRatio < 1.0

  test "drawText renders without exceptions with offset":
    let image = newImage(240, 120)
    image.fill(parseHtmlColor("#ffffff"))
    let layout = typesetIntoBounds(makeOptions(overflow = "visible", borderWidth = 1), image.width, image.height)

    drawText(layout, image, offsetX = 3.0, offsetY = 2.0)
    check layout.textTypeset.runes.len > 0

  test "approximate stroke fallback draws border text":
    let image = newImage(120, 60)
    image.fill(parseHtmlColor("#ffffff"))
    let font = newFont(getDefaultTypeface(), 32, parseHtmlColor("#000000"))
    let arranged = typeset(@[newSpan("Hi", font)], vec2(120, 60), CenterAlign, MiddleAlign)

    fillTextApproxStroke(image, arranged, vec2(0, 0), 2)

    check image.data.anyIt(it != rgbx(255, 255, 255, 255))
