## A decode into a target draws each line in one loop (jpeg.nim prepareLines
## and drawLineInto): the columns worked out once per decode, the row once per
## line, the bilinear mix in 32 bits (64 where it would overflow) and the store
## per pixel format inline. The other JPEG tests compare that loop with itself
## (the sink against the whole-plane fill, strips against the whole); these
## compare it with oracles that share none of it:
##
## - the per-pixel walk it replaced, written out here: every target pixel
##   through the fit, the EXIF orientation and each channel's sample on its
##   own, the mix in 64-bit ints. Exact, for every file of the corpus, every
##   kind of fit, downscales, upscales, 1:1 and tiny targets;
## - pixie's own per-format store (`setPixel`: the 565 pack, dithered or not,
##   the luma, the sixteen greys keyed on the row and column), against an
##   RGBX decode of the same target, into owned images and into views at odd
##   offsets of a larger one, whose pixels around the view stay as they were;
## - decodeJpeg, a different decode path that turns and flips the finished
##   image: exact at 1:1 where color is not subsampled, and close everywhere
##   else (boxed or nearest for the scaled decodes, and far closer than its
##   mirror images);
## - a synthetic 2560x1920 4:2:0 photo into 2480x1860, where the chroma's
##   bilinear sum no longer fits 32 bits (255 * dx * dy >= 2^32): the 64-bit
##   sum, against the 64-bit walk.

import std/[importutils, os, strutils]
import pixie, pixie/decodebudget
import pixie/fileformats/jpeg {.all.}

privateAccess(DecoderState)
privateAccess(Component)
privateAccess(FillGeometry)

const masters = "tests/fileformats/jpeg/masters/"

# ------------------------------------------------------------ the old walk

proc referenceChannel(comp: Component, sx, sy, gridW, gridH: int): uint8 =
  ## One channel's sample at a storage-order grid position, as channelAt did
  ## it: nearest, or bilinear between the two nearest samples where the
  ## channel was box-downsampled. In `int`: no sum here overflows.
  let
    sampleW = if comp.sampleWidth > 0: comp.sampleWidth else: comp.width
    sampleH = if comp.sampleHeight > 0: comp.sampleHeight else: comp.height
    ax = channelAxis(sx, gridW, sampleW, comp.width)
    ay = channelAxis(sy, gridH, sampleH, comp.height)
  template at(x, row: int): int =
    comp.channel.data[comp.channel.width * row + x].int
  let
    top = at(ax.lo, ay.lo) * (ax.den - ax.frac) + at(ax.hi, ay.lo) * ax.frac
    bottom = at(ax.lo, ay.hi) * (ax.den - ax.frac) + at(ax.hi, ay.hi) * ax.frac
    total = top * (ay.den - ay.frac) + bottom * ay.frac
    area = ax.den * ay.den
  ((total + area div 2) div area).uint8

proc referenceDecode(data: string, w, h: int, fit: ScaledDecodeFit): Image =
  ## The scaled decode of `data` into a new w x h image, each target pixel
  ## sampled on its own (what fillImage did before prepareLines).
  var state = decodeJpegState(data.cstring, data.len, true, w, h, fit)
  doAssert not state.sinkActive and state.components.len in {1, 3}
  for comp in state.components:
    doAssert comp.ringRows == 0, "the reference reads whole channel planes"
  let g = state.fillGeometry(w, h)
  result = newImage(w, h)
  for y in g.rects.dstY ..< g.rects.dstY + g.rects.dstH:
    for x in g.rects.dstX ..< g.rects.dstX + g.rects.dstW:
      let s = state.sourceCoords(g.orientedXFor(x), g.orientedYFor(y),
        g.gridWidth, g.gridHeight)
      result.unsafe[x, y] =
        if state.components.len == 3:
          yCbCrToRgbx(
            state.components[0].referenceChannel(s.x, s.y, g.gridWidth, g.gridHeight),
            state.components[1].referenceChannel(s.x, s.y, g.gridWidth, g.gridHeight),
            state.components[2].referenceChannel(s.x, s.y, g.gridWidth, g.gridHeight))
        else:
          grayScaleToRgbx(
            state.components[0].referenceChannel(s.x, s.y, g.gridWidth, g.gridHeight))

proc firstDifference(a, b: Image): string =
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a.unsafe[x, y] != b.unsafe[x, y]:
        return "first at " & $x & "," & $y & ": " & $a.unsafe[x, y] & " vs " &
          $b.unsafe[x, y]
  "none"

proc sizesFor(width, height: int): seq[(int, int)] =
  @[
    (width, height),                                           # 1:1
    (max(1, width * 5 div 6), max(1, height * 5 div 6)),       # downscale
    (max(1, width div 3 + 1), max(1, height div 4 + 1)),       # far down, odd
    (width * 3 div 2 + 1, max(1, height div 3)),               # wider, shorter
    (width * 2 + 3, height * 2 + 1),                           # upscale
    (7, 5)
  ]

proc decodes(path: string): bool =
  try:
    discard decodeJpeg(readFile(path))
    true
  except PixieError:
    false

var corpus: seq[string]
for path in walkFiles(masters & "*.jpg"):
  if decodes(path):
    corpus.add(path)
doAssert corpus.len >= 50, "the JPEG corpus moved: " & $corpus.len & " files"

block theWalkItReplaced:
  # Every file, every kind of fit, every size: the line loop against the
  # walk, pixel for pixel, both through the whole-plane fill
  # (decodeJpegScaled) and through the sink (decodeJpegScaledInto).
  setDecodeBudgetBytes(0)
  var checked = 0
  for path in corpus:
    let
      data = readFile(path)
      dims = decodeJpegDimensions(data)
      big = dims.width * dims.height > 120_000
    for fit in [fitStretch, fitCover, fitContain, fitCenter, fitTopLeft,
        fitBottomRight]:
      # The 1:1 fits differ in their anchor alone: the middle and two
      # corners. The big ones (mandrill, chair, progressive) at the three
      # scaling fits and one corner: the walk is slow, and the small ones
      # carry the fit matrix.
      if big and fit notin {fitStretch, fitCover, fitContain, fitBottomRight}:
        continue
      for (w, h) in sizesFor(dims.width, dims.height):
        if big and w * h > 400_000:
          continue
        let
          want = referenceDecode(data, w, h, fit)
          filled = decodeJpegScaled(data, w, h, fit)
          sunk = newImage(w, h)
        decodeJpegScaledInto(data, sunk, fit)
        doAssert filled.pixelsEqual(want), path & " " & $fit & " " & $w & "x" & $h &
          " filled: " & firstDifference(filled, want)
        doAssert sunk.pixelsEqual(want), path & " " & $fit & " " & $w & "x" & $h &
          " through the sink: " & firstDifference(sunk, want)
        inc checked
  doAssert checked > 1500, $checked

# ------------------------------------------------------- the per-format store

proc drawnRect(data: string, w, h: int, fit: ScaledDecodeFit):
    tuple[x, y, w, h: int] =
  ## The rectangle of a w x h target the decode draws (the rest, a contain's
  ## letterbox or around a smaller 1:1 picture, it leaves alone).
  var state = decodeJpegState(data.cstring, data.len, true, w, h, fit)
  let r = state.fillGeometry(w, h).rects
  (r.dstX, r.dstY, r.dstW, r.dstH)

proc storedThroughPixie(rgbx: Image, target: Image, rect: tuple[x, y, w, h: int]) =
  ## The pixels of `rgbx` inside `rect` into `target` (same size) through
  ## pixie's own per-format store.
  for y in rect.y ..< rect.y + rect.h:
    for x in rect.x ..< rect.x + rect.w:
      target.unsafe[x, y] = rgbx.unsafe[x, y]

type TargetKind = enum
  tk565, tk565Dithered, tkGray8, tkGray4

proc newTarget(kind: TargetKind, w, h: int): Image =
  case kind
  of tk565: newImage565(w, h)
  of tk565Dithered:
    let image = newImage565(w, h)
    image.ditherStores = true
    image
  of tkGray8: newImageGray8(w, h)
  of tkGray4: newImageGray4(w, h)

block perFormatStores:
  # The sink's store per format against pixie's: the RGBX decode of the same
  # target put through setPixel. Into an owned image, and into a view at an
  # odd offset of a larger one (a sixteen-grey view starts mid-byte, and its
  # ordered dither is keyed on the row and column in the shared buffer); the
  # pixels around the view are left as they were. The transposing
  # orientations (f5..f8) walk the target a column at a time.
  setDecodeBudgetBytes(0)
  var names = @["cat_4_2_0", "cat_4_4_4", "cat_4_1_1", "grayscale_test",
    "testimg", "quality_50"]
  for n in 1 .. 8:
    names.add("f" & $n & "-exif")
  var checked = 0
  for name in names:
    let
      data = readFile(masters & name & ".jpg")
      dims = decodeJpegDimensions(data)
    for fit in [fitStretch, fitCover, fitContain, fitCenter, fitBottomRight]:
      for (w, h) in sizesFor(dims.width, dims.height):
        if w * h > 200_000:
          continue
        let
          rgbx = newImage(w, h)
          rect = drawnRect(data, w, h, fit)
        decodeJpegScaledInto(data, rgbx, fit)
        for kind in TargetKind:
          let
            own = newTarget(kind, w, h)
            want = newTarget(kind, w, h)
          decodeJpegScaledInto(data, own, fit)
          rgbx.storedThroughPixie(want, rect)
          doAssert own.pixelsEqual(want), name & " " & $fit & " " & $w & "x" &
            $h & " " & $kind & ": " & firstDifference(own, want)
          let
            parent = newTarget(kind, w + 6, h + 4)
            wantParent = newTarget(kind, w + 6, h + 4)
          parent.fill(rgbx(9, 99, 199, 255))
          wantParent.fill(rgbx(9, 99, 199, 255))
          decodeJpegScaledInto(data, parent.view(3, 1, w, h), fit)
          rgbx.storedThroughPixie(wantParent.view(3, 1, w, h), rect)
          doAssert parent.pixelsEqual(wantParent), name & " " & $fit & " " &
            $w & "x" & $h & " " & $kind & " in a view: " &
            firstDifference(parent, wantParent)
          inc checked
  doAssert checked > 1000, $checked

# ---------------------------------------------------------- decodeJpeg

proc hasSubsampledColor(data: string): bool =
  for scale in decodeJpegInfo(data).componentScales:
    if scale.xScale != 1 or scale.yScale != 1:
      return true

proc fitRects(sw, sh, tw, th: int, fit: ScaledDecodeFit):
    tuple[srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH: int] =
  ## Where each fit puts the (turned) source, as the fits are documented
  ## (common.nim ScaledDecodeFit), worked out here on its own.
  result = (0, 0, sw, sh, 0, 0, tw, th)
  case fit
  of fitStretch:
    discard
  of fitCover:
    if sw * th > tw * sh:
      result.srcW = max(1, sh * tw div th)
      result.srcX = (sw - result.srcW) div 2
    else:
      result.srcH = max(1, sw * th div tw)
      result.srcY = (sh - result.srcH) div 2
  of fitContain:
    if sw * th > tw * sh:
      result.dstH = max(1, tw * sh div sw)
      result.dstY = (th - result.dstH) div 2
    else:
      result.dstW = max(1, th * sw div sh)
      result.dstX = (tw - result.dstW) div 2
  else:
    let anchor = fit.oneToOneAnchor()
    if sw >= tw:
      result.srcX = (sw - tw) * anchor.x div 2
      result.srcW = tw
      result.dstW = tw
    else:
      result.dstX = (tw - sw) * anchor.x div 2
      result.dstW = sw
    if sh >= th:
      result.srcY = (sh - th) * anchor.y div 2
      result.srcH = th
      result.dstH = th
    else:
      result.dstY = (th - sh) * anchor.y div 2
      result.dstH = sh

proc axisSpan(t, srcStart, srcLen, dstLen: int): (int, int) =
  ## The source pixels one target pixel stands for along an axis: a box on
  ## a downscale (the sampler's source-centric tiling: each source pixel
  ## goes to the target pixel whose span starts at or before it), the
  ## nearest on an upscale, itself at 1:1.
  if srcLen > dstLen:
    let
      a = (t * srcLen + dstLen - 1) div dstLen
      b = max(a + 1, min(srcLen, ((t + 1) * srcLen + dstLen - 1) div dstLen))
    (srcStart + a, srcStart + b)
  else:
    let s = srcStart + t * srcLen div dstLen
    (s, s + 1)

proc resampled(full: Image, r: tuple[srcX, srcY, srcW, srcH, dstX, dstY,
    dstW, dstH: int], x, y: int): tuple[r, g, b: int] =
  ## decodeJpeg's picture under target pixel (x, y), averaged.
  let
    (x0, x1) = axisSpan(x - r.dstX, r.srcX, r.srcW, r.dstW)
    (y0, y1) = axisSpan(y - r.dstY, r.srcY, r.srcH, r.dstH)
    area = (x1 - x0) * (y1 - y0)
  for sy in y0 ..< y1:
    for sx in x0 ..< x1:
      let p = full.unsafe[sx, sy]
      result.r += p.r.int
      result.g += p.g.int
      result.b += p.b.int
  result.r = (result.r + area div 2) div area
  result.g = (result.g + area div 2) div area
  result.b = (result.b + area div 2) div area

proc flipped(image: Image, horizontal: bool): Image =
  result = image.copy()
  if horizontal: result.flipHorizontal() else: result.flipVertical()

proc meanDifference(a, b: Image): float =
  var total = 0
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let (p, q) = (a.unsafe[x, y], b.unsafe[x, y])
      total += max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)),
        abs(p.b.int - q.b.int))
  total / (a.width * a.height)

block againstDecodeJpeg:
  # decodeJpeg builds the whole image and turns and flips it afterwards;
  # nothing of the line loop is in it.
  #
  # At 1:1 (every fit; the 1:1 ones pin a window of it) the picture is
  # decodeJpeg's exactly where color is not subsampled, every EXIF
  # orientation included. decodeJpeg upsamples subsampled color with a
  # filter where the scaled decode takes the nearest sample, so there it is
  # close.
  #
  # Scaled, it is decodeJpeg's picture resampled: boxed on a downscale (the
  # sampler tiles the source in storage order, so a flipped photo's boxes
  # start at its other edge), nearest on an upscale, and a contain resamples
  # twice. So it is close, not equal: within 16 on average, and at least
  # twice as close to the picture as to the picture mirrored either way,
  # which a missed flip or turn, or lines drawn in the wrong order, are not.
  # (Not the 8x8 and 16x16 pixel patterns or the 80x60 leaves of quality_*,
  # whose every pixel is its own detail: any resample is another picture.)
  #
  # The target's pixels outside the fit stay as they were.
  setDecodeBudgetBytes(0)
  let marker = rgbx(9, 99, 199, 255)
  var checked, mirrorChecked = 0
  for path in corpus:
    let
      data = readFile(path)
      full = decodeJpeg(data)
      (sw, sh) = (full.width, full.height)
      exact = not hasSubsampledColor(data)
      name = path.extractFilename
      detailOnly = name.startsWith("8x8") or name.startsWith("16x16") or
        name.startsWith("quality_")
      mirrors = [full.flipped(true), full.flipped(false)]
      asymmetric = full.meanDifference(mirrors[0]) >= 10 and
        full.meanDifference(mirrors[1]) >= 10
    if sw * sh > 120_000:
      continue
    for fit in ScaledDecodeFit:
      for (w, h) in [(sw, sh), (max(1, sw * 5 div 6), max(1, sh * 5 div 6)),
          (max(1, sw div 2), max(1, sh * 2 div 3)), (sw * 3 div 2 + 1, sh + 7)]:
        let
          r = fitRects(sw, sh, w, h, fit)
          target = newImage(w, h)
          oneToOne = r.srcW == r.dstW and r.srcH == r.dstH
        if not oneToOne and detailOnly:
          continue
        target.fill(marker)
        decodeJpegScaledInto(data, target, fit)
        var worst, count, outside = 0
        var totals: array[3, int]
        for y in 0 ..< h:
          for x in 0 ..< w:
            let q = target.unsafe[x, y]
            if x < r.dstX or x >= r.dstX + r.dstW or y < r.dstY or y >= r.dstY + r.dstH:
              if q != marker: inc outside
              continue
            for i, picture in [full, mirrors[0], mirrors[1]]:
              let a =
                if oneToOne:
                  let p = picture.unsafe[r.srcX + x - r.dstX, r.srcY + y - r.dstY]
                  (r: p.r.int, g: p.g.int, b: p.b.int)
                else:
                  picture.resampled(r, x, y)
              let d = max(max(abs(q.r.int - a.r), abs(q.g.int - a.g)), abs(q.b.int - a.b))
              totals[i] += d
              if i == 0: worst = max(worst, d)
            inc count
        let
          mean = totals[0] / max(1, count)
          mirrored = min(totals[1], totals[2]) / max(1, count)
          what = path & " " & $fit & " " & $w & "x" & $h
        doAssert outside == 0, what & ": " & $outside & " pixels outside the fit drawn"
        if oneToOne and exact:
          doAssert worst == 0, what & ": off by " & $worst & " at 1:1"
        elif oneToOne:
          doAssert mean <= 8.0, what & ": off by " & $mean & " on average at 1:1"
        else:
          doAssert mean <= 16.0, what & ": off by " & $mean & " on average (worst " & $worst & ")"
        if asymmetric:
          doAssert mean * 2 < mirrored, what & ": off by " & $mean &
            " on average, and by " & $mirrored & " from the picture mirrored"
          inc mirrorChecked
        inc checked
  doAssert checked > 1500 and mirrorChecked > 1000, $checked & " " & $mirrorChecked

# ------------------------------------------------- the 64-bit bilinear sum

proc dcOnlyJpeg(width, height: int,
    level: proc(component, blockX, blockY: int): int): string =
  ## A baseline 4:2:0 JPEG whose every 8x8 block is one flat level (its DC
  ## coefficient alone, quantized by 1): a photo-sized file in 160 KB,
  ## written here, so the corpus needs no 5 MP master.
  doAssert width mod 16 == 0 and height mod 16 == 0
  var output = "\xFF\xD8"
  proc u16(value: int): string = $char(value shr 8) & $char(value and 255)
  # One quantization table of ones.
  output.add "\xFF\xDB" & u16(67) & "\x00" & repeat('\x01', 64)
  output.add "\xFF\xC0" & u16(17) & "\x08" & u16(height) & u16(width) & "\x03" &
    "\x01\x22\x00" & "\x02\x11\x00" & "\x03\x11\x00"
  # DC: the standard luminance table (categories 0..11). AC: one code, the
  # end of block.
  const
    dcCounts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
  output.add "\xFF\xC4" & u16(2 + 1 + 16 + 12) & "\x00"
  for count in dcCounts: output.add char(count)
  for category in 0 .. 11: output.add char(category)
  output.add "\xFF\xC4" & u16(2 + 1 + 16 + 1) & "\x10\x01" & repeat('\x00', 15) & "\x00"
  output.add "\xFF\xDA" & u16(12) & "\x03" & "\x01\x00" & "\x02\x00" & "\x03\x00" &
    "\x00\x3F\x00"
  # Canonical codes for the DC table.
  var dcCode, dcLength: array[12, int]
  block:
    var (code, category) = (0, 0)
    for length in 1 .. 16:
      for _ in 0 ..< dcCounts[length - 1]:
        dcCode[category] = code
        dcLength[category] = length
        inc code
        inc category
      code = code shl 1
  var (bits, bitCount) = (0, 0)
  proc put(value, count: int) =
    for i in countdown(count - 1, 0):
      bits = (bits shl 1) or ((value shr i) and 1)
      inc bitCount
      if bitCount == 8:
        output.add char(bits)
        if bits == 0xFF: output.add '\x00'
        bits = 0
        bitCount = 0
  var predictor: array[3, int]
  proc blockOf(component, blockX, blockY: int) =
    let
      dc = (level(component, blockX, blockY) - 128) * 8
      diff = dc - predictor[component]
    predictor[component] = dc
    var category = 0
    while (abs(diff) shr category) != 0: inc category
    put(dcCode[category], dcLength[category])
    if category > 0:
      put(if diff > 0: diff else: diff + (1 shl category) - 1, category)
    put(0, 1) # end of block
  for mcuY in 0 ..< height div 16:
    for mcuX in 0 ..< width div 16:
      for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)]:
        blockOf(0, mcuX * 2 + dx, mcuY * 2 + dy)
      blockOf(1, mcuX, mcuY)
      blockOf(2, mcuX, mcuY)
  if bitCount > 0:
    put(0x7F, 8 - bitCount) # pad with ones
  output.add "\xFF\xD9"
  output

block wideBilinear:
  # A 2560x1920 4:2:0 photo into 2480x1860: the color is box-downsampled
  # below its native 1280x960 and mixed between its two nearest samples,
  # with denominators 2 * 2480 and 2 * 1860. 255 * dx * dy is 4.7e9, past
  # 32 bits: a host decoding for a large screen. The line loop must take
  # the 64-bit sum there, and land on the walk's pixels.
  setDecodeBudgetBytes(0)
  let
    (sw, sh) = (2560, 1920)
    (w, h) = (2480, 1860)
    data = dcOnlyJpeg(sw, sh, proc(component, blockX, blockY: int): int =
      case component
      of 0: (blockX * 7 + blockY * 3) mod 256
      # Color high enough for the sum to pass 32 bits over most of it.
      of 1: 160 + (blockX * 5 + blockY * 3) mod 96
      else: 255 - (blockX * 3 xor blockY) mod 48)
  var state = decodeJpegState(data.cstring, data.len, true, w, h, fitStretch)
  let g = state.fillGeometry(w, h)
  doAssert state.components.len == 3
  doAssert state.components[1].sampleWidth < state.components[1].width and
    state.components[1].sampleHeight < state.components[1].height,
    "the color must be box-downsampled, so it interpolates"
  doAssert 255'u64 * (2 * g.gridWidth).uint64 * (2 * g.gridHeight).uint64 >=
    (1'u64 shl 32), "the sum must pass 32 bits"
  # And it does, for real pixels: a 32-bit sum would get these wrong.
  var narrowWrong = 0
  for y in countup(0, h - 1, 7):
    for x in countup(0, w - 1, 5):
      let s = state.sourceCoords(g.orientedXFor(x), g.orientedYFor(y),
        g.gridWidth, g.gridHeight)
      for c in 1 .. 2:
        template comp: untyped = state.components[c]
        let
          ax = channelAxis(s.x, g.gridWidth, comp.sampleWidth, comp.width)
          ay = channelAxis(s.y, g.gridHeight, comp.sampleHeight, comp.height)
        template at(cx, row: int): uint32 =
          comp.channel.data[comp.channel.width * row + cx].uint32
        let
          top = at(ax.lo, ay.lo) * (ax.den - ax.frac).uint32 + at(ax.hi, ay.lo) * ax.frac.uint32
          bottom = at(ax.lo, ay.hi) * (ax.den - ax.frac).uint32 + at(ax.hi, ay.hi) * ax.frac.uint32
          total = top * (ay.den - ay.frac).uint32 + bottom * ay.frac.uint32
          area = (ax.den * ay.den).uint32
          narrow = ((total + area div 2) div area).uint8
        if narrow != comp.referenceChannel(s.x, s.y, g.gridWidth, g.gridHeight):
          inc narrowWrong
  doAssert narrowWrong > 1000, $narrowWrong & " samples need the 64-bit sum"
  let
    want = referenceDecode(data, w, h, fitStretch)
    filled = decodeJpegScaled(data, w, h, fitStretch)
    sunk = newImage(w, h)
  doAssert filled.pixelsEqual(want), "filled: " & firstDifference(filled, want)
  decodeJpegScaledInto(data, sunk, fitStretch)
  doAssert sunk.pixelsEqual(want), "through the sink: " & firstDifference(sunk, want)
