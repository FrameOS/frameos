import std/unittest
import pixie
import ../resample

# render/zoomPan's per-frame draw: a source rectangle onto the whole canvas,
# bilinear in fixed point. It must agree with the float sampler it replaced
# (pixie's getRgbaSmooth) inside the picture, clamp at the edges instead of
# fading to transparent, and store the same colors into every canvas format.

proc photo(width, height: int): Image =
  ## Smooth ramps and a hard edge, opaque, like a decoded photo.
  result = newImage(width, height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      let edge = if x > width div 2: 90'u8 else: 0'u8
      result.unsafe[x, y] = rgbx(uint8(x * 255 div max(1, width - 1)),
        uint8(y * 255 div max(1, height - 1)), edge, 255)

proc channelGap(a, b: ColorRGBX): int =
  max(max(abs(a.r.int - b.r.int), abs(a.g.int - b.g.int)),
      max(abs(a.b.int - b.b.int), abs(a.a.int - b.a.int)))

suite "drawRectBilinear":
  test "the whole source at 1:1 is the source":
    let source = photo(37, 23)
    let target = newImage(37, 23)
    drawRectBilinear(target, source, 0, 0, 37, 23)
    for y in 0 ..< 23:
      for x in 0 ..< 37:
        check target.unsafe[x, y] == source.unsafe[x, y]

  test "agrees with the float sampler inside the picture":
    let source = photo(64, 48)
    for (sx, sy, sw, sh, w, h) in [(3.25, 2.5, 40.0, 30.0, 53, 41),
                                   (0.0, 0.0, 64.0, 48.0, 100, 75),
                                   (10.7, 5.1, 20.3, 15.2, 31, 23)]:
      let target = newImage(w, h)
      drawRectBilinear(target, source, sx, sy, sw, sh)
      var worst = 0
      for y in 1 ..< h - 1:
        for x in 1 ..< w - 1:
          let fx = (sx + (x.float + 0.5) * (sw / w.float) - 0.5).float32
          let fy = (sy + (y.float + 0.5) * (sh / h.float) - 0.5).float32
          if fx < 0 or fy < 0 or fx > 63 or fy > 47:
            continue
          worst = max(worst, channelGap(target.unsafe[x, y], source.getRgbaSmooth(fx, fy)))
      # 8 bits of weight per axis against float weights.
      check worst <= 2

  test "edges clamp to the outermost pixels, not to transparent":
    let source = photo(16, 16)
    let target = newImage(40, 40)
    drawRectBilinear(target, source, 0, 0, 16, 16)
    for i in 0 ..< 40:
      check target.unsafe[i, 0].a == 255
      check target.unsafe[0, i].a == 255
      check target.unsafe[i, 39].a == 255
      check target.unsafe[39, i].a == 255
    check target.unsafe[0, 0] == source.unsafe[0, 0]
    check target.unsafe[39, 39] == source.unsafe[15, 15]

  test "a 565 or a grey canvas gets the same colors, packed":
    let source = photo(50, 30)
    let rgbx = newImage(40, 24)
    drawRectBilinear(rgbx, source, 4.5, 2.25, 38, 22.5)
    let packed = newImage565(40, 24)
    drawRectBilinear(packed, source, 4.5, 2.25, 38, 22.5)
    let grey = newImageGray8(40, 24)
    drawRectBilinear(grey, source, 4.5, 2.25, 38, 22.5)
    for y in 0 ..< 24:
      for x in 0 ..< 40:
        let index = packed.dataIndex(x, y)
        check packed.data16[index] == rgbxToRgb565(rgbx.unsafe[x, y])
        check grey.data8[grey.dataIndex(x, y)] == rgbxToGray8(rgbx.unsafe[x, y])

  test "a view's rows are its own":
    let owner = photo(30, 30)
    let source = owner.subImage(5, 7, 12, 9)
    let target = newImage(12, 9)
    drawRectBilinear(target, source, 0, 0, 12, 9)
    for y in 0 ..< 9:
      for x in 0 ..< 12:
        check target.unsafe[x, y] == owner.unsafe[x + 5, y + 7]

  test "a dithered 565 canvas keeps a flat color's level":
    # An LCD's canvas: every pixel rounds against a 4x4 threshold, so each
    # 4x4 cell averages back to the color within a level.
    for color in [rgbx(0, 0, 0, 255), rgbx(255, 255, 255, 255), rgbx(100, 150, 200, 255),
                  rgbx(13, 77, 141, 255), rgbx(250, 3, 129, 255)]:
      let source = newImage(5, 5)
      source.fill(color)
      let target = newImage565(16, 8)
      target.ditherStores = true
      drawRectBilinear(target, source, 0.3, 0.7, 4.1, 3.9)
      for cy in 0 ..< 2:
        for cx in 0 ..< 4:
          var r, g, b = 0
          for y in cy * 4 ..< cy * 4 + 4:
            for x in cx * 4 ..< cx * 4 + 4:
              let c = rgb565ToRgbx(target.data16[target.dataIndex(x, y)])
              r += c.r.int
              g += c.g.int
              b += c.b.int
          check abs(r / 16 - color.r.float) <= 1.0
          check abs(g / 16 - color.g.float) <= 1.0
          check abs(b / 16 - color.b.float) <= 1.0

  test "the dither is fixed to the screen, not to the picture":
    # Ken Burns moves the picture a little every frame. A pattern carried by
    # the picture is resampled at a new phase each time, and the pixels that
    # change between two frames of a sky line up in a grid that slides with
    # the zoom: banding on the glass while it moves (2026-10-26).
    let flat = newImage(40, 40)
    flat.fill(rgbx(90, 140, 205, 255))
    let first = newImage565(24, 24)
    first.ditherStores = true
    drawRectBilinear(first, flat, 1.0, 2.0, 30.0, 30.0)
    let moved = newImage565(24, 24)
    moved.ditherStores = true
    drawRectBilinear(moved, flat, 3.37, 1.11, 27.5, 27.5)
    for i in 0 ..< 24 * 24:
      check first.data16[i] == moved.data16[i]
    # A sky that only changes down the picture: column x is column x + 4.
    let sky = newImage(60, 60)
    for y in 0 ..< 60:
      for x in 0 ..< 60:
        sky.unsafe[x, y] = rgbx(uint8(110 + y), uint8(150 + y div 2), uint8(225 - y), 255)
    let target = newImage565(48, 48)
    target.ditherStores = true
    drawRectBilinear(target, sky, 5.3, 4.9, 41.7, 41.7)
    for y in 0 ..< 48:
      for x in 0 ..< 44:
        check target.data16[target.dataIndex(x, y)] == target.data16[target.dataIndex(x + 4, y)]

  test "rows drawn in blocks by two workers are the rows of one pass":
    # The ESP32 shares the rows between its cores (fos_rows.c), each block
    # starting its own two cached source rows.
    let source = photo(64, 48)
    for format in [pfRgbx, pfRgb565, pfGray8]:
      proc canvas(): Image =
        result =
          case format
          of pfRgbx: newImage(53, 41)
          of pfRgb565: newImage565(53, 41)
          of pfGray8: newImageGray8(53, 41)
        result.ditherStores = format == pfRgb565
      let whole = canvas()
      drawRectBilinear(whole, source, 3.25, 2.5, 40.0, 30.0)
      testRowBlocks = 7
      let blocks = canvas()
      drawRectBilinear(blocks, source, 3.25, 2.5, 40.0, 30.0)
      testRowBlocks = 0
      for y in 0 ..< 41:
        for x in 0 ..< 53:
          check whole.unsafe[x, y] == blocks.unsafe[x, y]
