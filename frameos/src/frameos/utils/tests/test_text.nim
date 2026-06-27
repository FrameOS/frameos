import std/[options, os, sequtils, unittest]
import pixie
import ../font
import ../text

when not defined(frameosEmbedded):
  proc copiedAssetsRoot(): string =
    normalizedPath(
      currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "assets" / "copied"
    )

proc makeOptions(overflow = "fit-bounds", borderWidth = 0, assetsPath = ""): TextRenderOptions =
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
    assetsPath: assetsPath
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

  when not defined(frameosEmbedded):
    test "drawText renders default-font emoji through Noto fallback":
      let assetsRoot = copiedAssetsRoot()
      check fileExists(assetsRoot / "fonts" / "NotoColorEmoji.ttf")

      let image = newImage(96, 96)
      image.fill(parseHtmlColor("#ffffff"))
      var opts = makeOptions(overflow = "visible", assetsPath = assetsRoot)
      opts.text = "😀"
      opts.fontSize = 64
      opts.padding = 4

      let layout = typesetIntoBounds(opts, image.width, image.height)
      drawText(layout, image)

      check image.data.anyIt(it != rgbx(255, 255, 255, 255))

  test "approximate stroke fallback draws border text":
    let image = newImage(120, 60)
    image.fill(parseHtmlColor("#ffffff"))
    let font = newFont(getDefaultTypeface(), 32, parseHtmlColor("#000000"))
    let arranged = typeset(@[newSpan("Hi", font)], vec2(120, 60), CenterAlign, MiddleAlign)

    fillTextApproxStroke(image, arranged, vec2(0, 0), 2)

    check image.data.anyIt(it != rgbx(255, 255, 255, 255))
