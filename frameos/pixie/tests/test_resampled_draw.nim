## drawResampled (images.nim): a picture stretched into an axis-aligned
## rectangle in fixed point, what an SVG `<image>` (a JSX `<img>`) that is
## scaled and moved, not turned, draws through (svg.nim drawSvgImage).
##
## The oracle here shares none of its code: the same definition (a box filter
## where the picture shrinks, bilinear with the edge pixels held where it
## grows, a target pixel drawn when its centre is inside the rectangle) worked
## out in floating point, per target pixel, as a direct double sum over the
## source, then blended over the backdrop in floating point. Plus exact checks
## where the answer is known without arithmetic: 1:1 on whole pixels, whole
## blocks of a picture shrunk by a whole number, source centres of a picture
## grown by one, every target and source format against the RGBX draw put
## through pixie's own stores, a view against the whole, and the SVG path
## against a direct call.

import std/[math]
import pixie, pixie/blends, pixie/fileformats/svg

type Px = array[4, float64]

proc axisWeights(origin, size: float64, n, t: int): seq[(int, float64)] =
  let ratio = n.float64 / size
  if ratio > 1:
    let
      a = max((t.float64 - origin) * ratio, 0.0)
      b = min((t.float64 + 1 - origin) * ratio, n.float64)
    if b <= a:
      return @[(clamp(floor((t.float64 + 0.5 - origin) * ratio).int, 0, n - 1), 1.0)]
    for k in floor(a).int ..< ceil(b).int:
      let overlap = min(b, (k + 1).float64) - max(a, k.float64)
      if overlap > 0:
        result.add((k, overlap / (b - a)))
  else:
    let
      pos = (t.float64 + 0.5 - origin) * ratio - 0.5
      f = floor(pos)
      frac = pos - f
    result = @[(clamp(f.int, 0, n - 1), 1 - frac), (clamp(f.int + 1, 0, n - 1), frac)]

proc channels(c: ColorRGBX): Px = [c.r.float64, c.g.float64, c.b.float64, c.a.float64]

proc oracle(target, picture: Image, x, y, w, h, opacity: float64): seq[Px] =
  ## The target as floats after the draw.
  result = newSeq[Px](target.width * target.height)
  for ty in 0 ..< target.height:
    for tx in 0 ..< target.width:
      let backdrop = channels(target[tx, ty])
      var outPx = backdrop
      if x <= tx.float64 + 0.5 and tx.float64 + 0.5 < x + w and
          y <= ty.float64 + 0.5 and ty.float64 + 0.5 < y + h:
        var s: Px
        for (sy, wy) in axisWeights(y, h, picture.height, ty):
          for (sx, wx) in axisWeights(x, w, picture.width, tx):
            let c = channels(picture[sx, sy])
            for k in 0 .. 3:
              s[k] += c[k] * wx * wy
        for k in 0 .. 3:
          s[k] *= opacity
        let keep = 1 - s[3] / 255
        for k in 0 .. 3:
          outPx[k] = s[k] + backdrop[k] * keep
      result[ty * target.width + tx] = outPx

proc photo(w, h: int, alpha = false): Image =
  ## Smooth gradients with a fine checker over them: detail at every scale.
  result = newImage(w, h)
  for y in 0 ..< h:
    for x in 0 ..< w:
      let
        checker = (if ((x div 3) + (y div 2)) mod 2 == 0: 40 else: 0)
        a = (if alpha: uint8(64 + (x * 191) div max(1, w - 1)) else: 255'u8)
        r = uint8(min(255, (x * 200) div max(1, w - 1) + checker))
        g = uint8(min(255, (y * 220) div max(1, h - 1)))
        b = uint8(min(255, ((x + y) * 9) mod 256))
      result[x, y] = rgba(r, g, b, a).rgbx()

proc backdrop(w, h: int): Image =
  result = newImage(w, h)
  for y in 0 ..< h:
    for x in 0 ..< w:
      result[x, y] = rgba(uint8((x * 37) mod 256), uint8((y * 53) mod 256), 90, 255).rgbx()

proc checkAgainstOracle(picture: Image, tw, th: int, x, y, w, h: float64, opacity = 1.0,
    tolerance = 1.01) =
  ## Within one level of the oracle; a blend over the backdrop rounds once more.
  let target = backdrop(tw, th)
  let expected = oracle(target, picture, x, y, w, h, opacity)
  target.drawResampled(picture, x, y, w, h, opacity)
  var worst = 0.0
  for ty in 0 ..< th:
    for tx in 0 ..< tw:
      let got = channels(target[tx, ty])
      for k in 0 .. 3:
        worst = max(worst, abs(got[k] - expected[ty * tw + tx][k]))
  doAssert worst <= tolerance,
    "picture " & $picture.width & "x" & $picture.height & " into (" & $x & ", " & $y & ", " & $w &
    ", " & $h & ") of " & $tw & "x" & $th & " opacity " & $opacity & ": off by " & $worst

block: # against the oracle: shrunk, grown, both, off every edge, faded, transparent
  let
    big = photo(240, 160)
    small = photo(40, 30)
    tiny = photo(3, 2)
    clear = photo(50, 40, alpha = true)
  checkAgainstOracle(big, 200, 130, 4, 3, 184.8, 117.9)        # 0.77x, the E1003's photo case
  checkAgainstOracle(big, 120, 90, 0.4, 1.7, 61.3, 47.9)       # 0.26x / 0.30x
  checkAgainstOracle(big, 40, 40, 2, 2, 3, 2)                  # 80x down
  checkAgainstOracle(small, 130, 100, 3.25, 2.5, 120, 90)      # 3x up, half pixels
  checkAgainstOracle(tiny, 110, 70, 0, 0, 97, 61)              # 32x up
  checkAgainstOracle(small, 90, 90, 5, 5, 20, 80)              # down in x, up in y
  checkAgainstOracle(big, 60, 50, -37.5, -20.25, 140, 95)      # hanging off every side
  # Over the backdrop three roundings add up: the resampled colour, its alpha
  # (which sets how much of the backdrop shows through), and the row blend's
  # own (blendLineNormal, about one level on every platform). Each is within
  # one level; how they fall differs between an arm64 and an x86-64 build (the
  # weights' float arithmetic is contracted differently), 2.17 seen on x86-64.
  checkAgainstOracle(small, 60, 50, 10, 8, 33.3, 25.1, opacity = 0.5, tolerance = 3)
  checkAgainstOracle(clear, 70, 60, 6.5, 4, 41, 51, tolerance = 3) # alpha over the backdrop
  checkAgainstOracle(clear, 70, 60, 6.5, 4, 41, 51, opacity = 0.3, tolerance = 3)

block: # nothing outside the rectangle changes, however it is placed
  let picture = photo(30, 20)
  for (x, y, w, h) in [(2.4, 3.6, 17.2, 9.9), (2.7, 3.8, 10.0, 6.4), (-5.0, -5.0, 12.0, 12.0),
      (19.5, 0.5, 40.0, 3.0), (100.0, 3.0, 10.0, 10.0), (3.0, 3.0, 0.3, 0.3)]:
    let
      before = backdrop(24, 16)
      after = before.copy()
    after.drawResampled(picture, x, y, w, h)
    for ty in 0 ..< 16:
      for tx in 0 ..< 24:
        let inside = x <= tx.float64 + 0.5 and tx.float64 + 0.5 < x + w and
          y <= ty.float64 + 0.5 and ty.float64 + 0.5 < y + h
        if not inside:
          doAssert after[tx, ty] == before[tx, ty], $(tx, ty, x, y, w, h)
        else:
          doAssert after[tx, ty] != before[tx, ty], $(tx, ty, x, y, w, h)

block: # exact: its own size on whole pixels is a copy, or a blend for alpha
  let
    opaque = photo(17, 11)
    clear = photo(17, 11, alpha = true)
    target = backdrop(30, 20)
    blended = target.copy()
  target.drawResampled(opaque, 5, 4, 17, 11)
  blended.drawResampled(clear, 5, 4, 17, 11)
  let base = backdrop(30, 20)
  for y in 0 ..< 11:
    for x in 0 ..< 17:
      doAssert target[x + 5, y + 4] == opaque[x, y]
      doAssert blended[x + 5, y + 4] == blendNormal(base[x + 5, y + 4], clear[x, y])

block: # exact: shrunk by a whole number, each target pixel is its block
  let picture = newImage(12, 9)
  for y in 0 ..< 9:
    for x in 0 ..< 12:
      picture[x, y] = rgba(uint8(x div 3 * 60), uint8(y div 3 * 70), uint8((x div 3 + y div 3) * 20), 255).rgbx()
  let target = backdrop(4, 3)
  target.drawResampled(picture, 0, 0, 4, 3)
  for y in 0 ..< 3:
    for x in 0 ..< 4:
      doAssert target[x, y] == picture[x * 3, y * 3], $(x, y)

block: # exact: grown by a whole number, a target pixel on a source centre is that pixel
  let
    picture = photo(9, 7)
    target = backdrop(27, 21)
  target.drawResampled(picture, 0, 0, 27, 21)
  for y in 0 ..< 7:
    for x in 0 ..< 9:
      doAssert target[x * 3 + 1, y * 3 + 1] == picture[x, y], $(x, y)

block: # opacity 0 draws nothing; a picture of nothing draws nothing
  let
    target = backdrop(20, 20)
    before = target.copy()
  target.drawResampled(photo(10, 10), 0, 0, 20, 20, opacity = 0)
  target.drawResampled(newImage(10, 10), 0, 0, 20, 20)
  for y in 0 ..< 20:
    for x in 0 ..< 20:
      doAssert target[x, y] == before[x, y]

proc formatted(source: Image, format: PixelFormat, dither = false): Image =
  ## `source` put through pixie's own store for `format`.
  result =
    case format
    of pfRgbx: newImage(source.width, source.height)
    of pfRgb565: newImage565(source.width, source.height)
    of pfGray8: newImageGray8(source.width, source.height)
    of pfGray4: newImageGray4(source.width, source.height)
  result.ditherStores = dither
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      result.setPixel(result.dataIndex(x, y), source[x, y])

block: # every target format: the RGBX draw, put through that format's store
  let picture = photo(60, 45)
  for (format, dither) in [(pfRgb565, false), (pfRgb565, true), (pfGray8, false), (pfGray4, false)]:
    for (x, y, w, h) in [(3.0, 2.0, 41.3, 30.7), (-4.5, 1.0, 90.0, 70.0), (0.0, 0.0, 33.0, 25.0)]:
      let
        rgbx = backdrop(37, 29)
        target = formatted(backdrop(37, 29), format, dither)
      rgbx.drawResampled(picture, x, y, w, h)
      target.drawResampled(picture, x, y, w, h)
      let expected = formatted(rgbx, format, dither)
      for ty in 0 ..< 29:
        for tx in 0 ..< 37:
          let inside = x <= tx.float64 + 0.5 and tx.float64 + 0.5 < x + w and
            y <= ty.float64 + 0.5 and ty.float64 + 0.5 < y + h
          if inside:
            doAssert target[tx, ty] == expected[tx, ty], $(format, dither, tx, ty, x, y, w, h)

block: # a non-RGBX target blends a transparent picture over what it holds
  # The samples alone: drawn over nothing, a blend adds nothing to them (the
  # oracle above checks them). The target's pixel is then pixie's normal blend
  # of that sample over what the target reads back, through its own store.
  # (Not an RGBX draw of the same: pixie's SIMD line blend rounds a channel
  # differently from its scalar blendNormal now and then; a device has no SIMD.)
  let
    clear = photo(30, 30, alpha = true)
    samples = newImage(32, 32)
  samples.drawResampled(clear, 1, 1, 30, 30, opacity = 0.7)
  for format in [pfRgb565, pfGray8, pfGray4]:
    let
      target = formatted(backdrop(32, 32), format)
      expected = formatted(backdrop(32, 32), format)
    target.drawResampled(clear, 1, 1, 30, 30, opacity = 0.7)
    for y in 1 ..< 31:
      for x in 1 ..< 31:
        let s = samples[x, y]
        if s.a != 0:
          expected.setPixel(expected.dataIndex(x, y), blendNormal(expected[x, y], s))
    for y in 0 ..< 32:
      for x in 0 ..< 32:
        doAssert target[x, y] == expected[x, y], $(format, x, y)

block: # every source format reads like its RGBX self
  let base = photo(40, 30)
  for format in [pfRgb565, pfGray8, pfGray4]:
    let
      picture = formatted(base, format)
      asRgbx = newImage(40, 30)
    for y in 0 ..< 30:
      for x in 0 ..< 40:
        asRgbx[x, y] = picture[x, y]
    let
      a = backdrop(50, 50)
      b = backdrop(50, 50)
    a.drawResampled(picture, 2.5, 3, 45, 33.3)
    b.drawResampled(asRgbx, 2.5, 3, 45, 33.3)
    for y in 0 ..< 50:
      for x in 0 ..< 50:
        doAssert a[x, y] == b[x, y], $(format, x, y)

block: # a view of the target draws what a whole draw puts there (the damage repaint)
  let picture = photo(80, 60)
  for format in [pfRgbx, pfRgb565, pfGray4]:
    let
      whole = formatted(backdrop(64, 48), format)
      windowed = formatted(backdrop(64, 48), format)
    whole.drawResampled(picture, 3.3, 2.7, 57.1, 41.9)
    windowed.view(10, 7, 21, 30).drawResampled(picture, 3.3 - 10, 2.7 - 7, 57.1, 41.9)
    for y in 7 ..< 37:
      for x in 10 ..< 31:
        doAssert windowed[x, y] == whole[x, y], $(format, x, y)

proc el(tag: string, attrs: openArray[(string, string)], children: varargs[SvgNode]): SvgNode =
  result = SvgNode(tag: tag)
  for attr in attrs:
    result.attrs.add attr
  for child in children:
    result.children.add child

block: # an SVG <image> that is only scaled and moved draws through it
  let picture = photo(50, 40)
  proc rendered(attrs: openArray[(string, string)]): Image =
    let node = el("image", attrs)
    node.image = picture
    result = backdrop(64, 48)
    parseSvg(el("svg", {"width": "64", "height": "48"}, node), 64, 48).renderInto(result)
  block: # stretched, at a half pixel
    let direct = backdrop(64, 48)
    direct.drawResampled(picture, 3.5, 2.25, 55.0, 41.5)
    let svg = rendered({"x": "3.5", "y": "2.25", "width": "55", "height": "41.5",
      "preserveAspectRatio": "none"})
    for y in 0 ..< 48:
      for x in 0 ..< 64:
        doAssert svg[x, y] == direct[x, y], $(x, y)
  block: # its opacity is in the weights
    let direct = backdrop(64, 48)
    direct.drawResampled(picture, 0, 0, 64, 48, opacity = 0.4)
    let svg = rendered({"width": "64", "height": "48", "preserveAspectRatio": "none", "opacity": "0.4"})
    for y in 0 ..< 48:
      for x in 0 ..< 64:
        doAssert svg[x, y] == direct[x, y], $(x, y)
  block: # slice: clipped to the element's box
    let svg = rendered({"x": "10", "y": "10", "width": "30", "height": "10",
      "preserveAspectRatio": "xMidYMid slice"})
    let before = backdrop(64, 48)
    for y in 0 ..< 48:
      for x in 0 ..< 64:
        if x < 10 or x >= 40 or y < 10 or y >= 20:
          doAssert svg[x, y] == before[x, y], $(x, y)
        else:
          doAssert svg[x, y] != before[x, y], $(x, y)

block: # turned, it keeps the general draw
  let picture = photo(20, 20)
  let node = el("image", {"width": "20", "height": "20"})
  node.image = picture
  let svg = backdrop(40, 40)
  parseSvg(el("svg", {"width": "40", "height": "40"},
    el("g", {"transform": "translate(20 5) rotate(30)"}, node)), 40, 40).renderInto(svg)
  let general = backdrop(40, 40)
  general.draw(picture, translate(vec2(20, 5)) * rotate(30.float32.toRadians))
  for y in 0 ..< 40:
    for x in 0 ..< 40:
      doAssert svg[x, y] == general[x, y], $(x, y)

echo "test_resampled_draw ok"
