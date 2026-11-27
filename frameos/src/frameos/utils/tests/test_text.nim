import std/[math, options, os, sequtils, unittest]
import pixie
import pixie/blends
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

  test "fit-bounds keeps words whole: a word wider than the box makes the text smaller, not broken":
    # Split screen's rich text panel on a 400 px wide e-paper, the UX bench
    # 2026-11-27: "bananas" came out "banan" / "as" in a narrow, tall box.
    var opts = makeOptions(overflow = "fit-bounds")
    opts.text = "bananas and apples"
    opts.fontSize = 48
    var asked = opts
    asked.overflow = "visible"
    check typesetIntoBounds(asked, 90, 600).textTypeset.breaksWord() # at 48 px it breaks
    let layout = typesetIntoBounds(opts, 90, 600)
    check not layout.textTypeset.breaksWord()
    check layout.fontScaleRatio < 1.0
    # Plenty of room: as asked, nothing shrunk.
    check typesetIntoBounds(opts, 900, 600).fontScaleRatio == 1.0
    # A word that would not fit even at 40 % of the size (a long URL) breaks
    # rather than shrink the text out of sight.
    opts.text = "https://example.com/a-very-long-path/that-goes-on-and-on"
    let url = typesetIntoBounds(opts, 90, 600)
    check url.fontScaleRatio >= 0.39

  test "a render scale makes every length larger: the font, the padding, the border and rich text's sizes":
    var opts = makeOptions(overflow = "visible", borderWidth = 2)
    let plain = typesetIntoBounds(opts, 2000, 400)
    opts.scale = 2.0
    let scaled = typesetIntoBounds(opts, 2000, 400)
    check scaled.fontScaleRatio == 2.0 # the border's stroke goes with it (drawText)
    check scaled.opts.padding == 8.0
    check scaledBorder(scaled) == 4
    let plainW = layoutBounds(plain.textTypeset).x - layoutBoundsTopLeft(plain.textTypeset).x
    let scaledW = layoutBounds(scaled.textTypeset).x - layoutBoundsTopLeft(scaled.textTypeset).x
    check abs(scaledW - 2 * plainW) < 4
    # A size of rich text's own is as much larger, and shrinking to fit
    # still shrinks from the scaled size.
    var rich = makeOptions(overflow = "fit-bounds")
    rich.richTextMode = "basic-caret"
    rich.text = "^(10)small"
    let small = typesetIntoBounds(rich, 2000, 400)
    rich.scale = 2.0
    let twice = typesetIntoBounds(rich, 2000, 400)
    let smallH = layoutBounds(small.textTypeset).y - layoutBoundsTopLeft(small.textTypeset).y
    let twiceH = layoutBounds(twice.textTypeset).y - layoutBoundsTopLeft(twice.textTypeset).y
    check abs(twiceH - 2 * smallH) < 3
    rich.text = "FrameOS text test"
    check typesetIntoBounds(rich, 220, 24).fontScaleRatio < 1.0

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

suite "the text border's grey scratch":
  test "the outline is the RGBA scratch's, a byte a pixel instead of six":
    # The reference: the outline as it was drawn from an RGBA scratch filled
    # in the border color, its alpha dilated into two planes.
    proc referenceOutline(image: Image, arrangement: Arrangement, origin: Vec2, strokeWidth: float, color: Color) =
      let radius = max(1, ceil(strokeWidth).int)
      let
        baseX = floor(origin.x)
        baseY = floor(origin.y)
        fracX = origin.x - baseX
        fracY = origin.y - baseY
        bounds = arrangement.computeBounds(translate(vec2(fracX, fracY)))
        margin = 1 + radius
        x0 = floor(bounds.x).int - margin
        y0 = floor(bounds.y).int - margin
        w = ceil(bounds.x + bounds.w).int + margin - x0
        h = ceil(bounds.y + bounds.h).int + margin - y0
      let scratch = newImage(w, h)
      scratch.fillText(arrangement, translate(vec2(fracX - x0.float32, fracY - y0.float32)))
      var rows = newSeq[uint8](w * h)
      for y in 0 ..< h:
        for x in 0 ..< w:
          var m = 0'u8
          for k in max(0, x - radius) .. min(w - 1, x + radius):
            m = max(m, scratch.unsafe[k, y].a)
          rows[y * w + x] = m
      let c = color.rgbx()
      for y in 0 ..< h:
        for x in 0 ..< w:
          var m = 0'u8
          for k in max(0, y - radius) .. min(h - 1, y + radius):
            m = max(m, rows[k * w + x])
          let (tx, ty) = (baseX.int + x0 + x, baseY.int + y0 + y)
          if m == 0 or tx < 0 or ty < 0 or tx >= image.width or ty >= image.height: continue
          let sa = min(m.uint32, c.a.uint32)
          let src = rgbx(uint8((c.r.uint32 * sa + c.a.uint32 div 2) div c.a.uint32),
            uint8((c.g.uint32 * sa + c.a.uint32 div 2) div c.a.uint32),
            uint8((c.b.uint32 * sa + c.a.uint32 div 2) div c.a.uint32), uint8(sa))
          image.unsafe[tx, ty] = blendNormal(image.unsafe[tx, ty], src)

    let background = rgbx(240, 224, 192, 255)
    for (hex, alpha) in [("#2050c0", 1.0), ("#000000", 1.0), ("#ffffff", 1.0), ("#c02020", 0.6)]:
      var color = parseHtmlColor(hex)
      color.a = alpha
      let font = newFont(getDefaultTypeface(), 30, color)
      let arranged = typeset(@[newSpan("Stamp\nonce, Wg!", font)], vec2(220, 110), CenterAlign, MiddleAlign)
      for strokeWidth in [1.0, 2.0, 3.0]:
        let origin = vec2(7.35, 4.6)
        let reference = newImage(240, 130)
        reference.fill(background)
        referenceOutline(reference, arranged, origin, strokeWidth, color)
        let grey = newImage(240, 130)
        grey.fill(background)
        fillTextApproxStroke(grey, arranged, origin, strokeWidth)
        check lastApproxStroke.path == "dilated"
        # The arrangement keeps its own paints.
        check arranged.fonts[0].paints[0].color == color
        var worst = 0
        for i in 0 ..< reference.width * reference.height:
          let (a, b) = (reference.getPixel(i), grey.getPixel(i))
          worst = max(worst, max(max(abs(a.r.int - b.r.int), abs(a.g.int - b.g.int)),
            max(abs(a.b.int - b.b.int), abs(a.a.int - b.a.int))))
        if worst > 1:
          checkpoint hex & " alpha " & $alpha & " stroke " & $strokeWidth & ": off by " & $worst
          fail()
