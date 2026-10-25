import std/[math, options, os, sequtils, unittest]
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

      check toSeq(image.items).anyIt(it != rgbx(255, 255, 255, 255))

  test "approximate stroke fallback draws border text":
    let image = newImage(120, 60)
    image.fill(parseHtmlColor("#ffffff"))
    let font = newFont(getDefaultTypeface(), 32, parseHtmlColor("#000000"))
    let arranged = typeset(@[newSpan("Hi", font)], vec2(120, 60), CenterAlign, MiddleAlign)

    fillTextApproxStroke(image, arranged, vec2(0, 0), 2)

    check toSeq(image.items).anyIt(it != rgbx(255, 255, 255, 255))

  test "approximate stroke: one raster grown by the border, where stamping drew sixteen":
    # The reference is the stamped outline the helper drew before (kept here
    # verbatim): one fillText per whole-pixel offset, radius rings of eight.
    # The dilated outline inks every pixel the stamped one did, is solid
    # border color wherever the stamped one is but at a few rim pixels, and
    # may ink a little more at the corners the rings skipped.
    const directions = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)]
    let background = rgbx(240, 224, 192, 255)
    let font = newFont(getDefaultTypeface(), 30, parseHtmlColor("#2050c0"))
    let arranged = typeset(@[newSpan("Stamp\nonce", font)], vec2(200, 110), CenterAlign, MiddleAlign)
    for strokeWidth in [2.0, 3.0]:
      let origin = vec2(7.35, 4.6)
      let stamped = newImage(220, 130)
      stamped.fill(background)
      let radius = max(1, ceil(strokeWidth).int)
      for step in 1 .. radius:
        for (dx, dy) in directions:
          stamped.fillText(arranged, translate(vec2(origin.x + (dx * step).float32, origin.y + (dy * step).float32)))
      let dilated = newImage(220, 130)
      dilated.fill(background)
      fillTextApproxStroke(dilated, arranged, origin, strokeWidth)
      check lastApproxStroke.path == "dilated"
      let solid = parseHtmlColor("#2050c0").rgbx()
      var inked, missed, solidStamped, solidMismatch, extra = 0
      for i in 0 ..< stamped.width * stamped.height:
        let a = stamped.getPixel(i)
        let b = dilated.getPixel(i)
        if a != background:
          inc inked
          if b == background: inc missed
        elif b != background:
          inc extra
        if a == solid:
          inc solidStamped
          if b != solid: inc solidMismatch
      check inked > 500
      check missed == 0
      check solidStamped > 100
      # Stacked copies compound a partly covered rim pixel to solid; the
      # maximum keeps it partly covered: a handful of rim pixels, a shade
      # lighter.
      check solidMismatch * 20 < solidStamped
      # The corners the rings skipped: a thin share, never a different shape.
      check extra < inked div 4
