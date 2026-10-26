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

  test "565 onto 565 follows the RGBX path within a 565 step":
    let source = photo(64, 48)
    let lean = toRgb565Copy(source)
    for (sx, sy, sw, sh, w, h) in [(3.25, 2.5, 40.0, 30.0, 53, 41),
                                   (0.0, 0.0, 64.0, 48.0, 100, 75),
                                   (0.0, 0.0, 64.0, 48.0, 64, 48)]:
      let reference = newImage(w, h)
      drawRectBilinear(reference, source, sx, sy, sw, sh)
      let target = newImage565(w, h)
      drawRectBilinear(target, lean, sx, sy, sw, sh)
      var worst = 0
      for y in 0 ..< h:
        for x in 0 ..< w:
          let got = rgb565ToRgbx(target.data16[target.dataIndex(x, y)])
          let want = reference.unsafe[x, y]
          worst = max(worst, max(abs(got.r.int - want.r.int),
            max(abs(got.g.int - want.g.int), abs(got.b.int - want.b.int))))
      # The copy's dither offset (up to 8), its 5-bit rounding (up to 4) and
      # 5-bit weights across the photo's hard edge (90 / 32, up to 3).
      check worst <= 15

  test "565 at 1:1 is the copy":
    let lean = toRgb565Copy(photo(21, 13))
    let target = newImage565(21, 13)
    drawRectBilinear(target, lean, 0, 0, 21, 13)
    for y in 0 ..< 13:
      for x in 0 ..< 21:
        check target.data16[target.dataIndex(x, y)] == lean.data16[lean.dataIndex(x, y)]
