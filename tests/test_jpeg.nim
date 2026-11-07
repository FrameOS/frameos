import std/strutils
import jpegsuite, pixie, pixie/fileformats/jpeg, pixie/decodebudget

for file in jpegSuiteFiles:
  let
    image = readImage(file)
    dimensions = decodeJpegDimensions(readFile(file))
  doAssert image.width == dimensions.width
  doAssert image.height == dimensions.height

block:
  var data = readFile("tests/fileformats/jpeg/masters/cat_4_2_0.jpg")
  let image = decodeJpegScaled(data, 17, 11)
  doAssert image.width == 17
  doAssert image.height == 11
  doAssert data.len == 0

block:
  var data = readFile("tests/fileformats/jpeg/masters/cat_4_4_4.jpg")
  let target = newImage(13, 9)
  decodeJpegScaledInto(data, target)
  doAssert target.width == 13
  doAssert target.height == 9
  doAssert data.len == 0

block:
  # Little-endian (II) EXIF must decode identically to the big-endian (MM)
  # originals: the orientation SHORT sits in the opposite word of the data
  # field, which `shr 16` alone silently dropped (Sony/Canon files).
  for n in 1 .. 8:
    let
      mm = decodeJpeg(readFile("tests/fileformats/jpeg/masters/f" & $n & "-exif.jpg"))
      ii = decodeJpeg(readFile("tests/fileformats/jpeg/masters/f" & $n & "-exif-ii.jpg"))
    doAssert ii.width == mm.width and ii.height == mm.height
    doAssert ii.pixelsEqual(mm)

block:
  # The decode plan must count what the decode actually allocates. Two things
  # historically escaped it: the reconstruction path magnifies subsampled
  # channels up to full stride resolution (with the half-size source still
  # alive during the last doubling), and buildImage allocates the output image
  # next to everything the plan approved. A plan that under-counts is a check
  # that passes and an allocation that dies on a fragmented embedded heap.
  let budgetData = readFile("tests/fileformats/jpeg/masters/cat_4_2_0.jpg")
  let budgetDims = decodeJpegDimensions(budgetData)

  # 1) The refusal is catchable and its accounted total covers the
  #    full-resolution upsample peak, not the subsampled starting planes.
  setDecodeBudgetBytes(1)
  var plannedK = 0
  try:
    discard decodeJpeg(budgetData)
    doAssert false, "a 1-byte budget cannot admit any decode plan"
  except PixieError as e:
    doAssert "memory budget" in e.msg, e.msg
    let needsAt = e.msg.find("needs ") + 6
    let kAt = e.msg.find("K of decode")
    plannedK = parseInt(e.msg[needsAt ..< kAt])
  let
    strideW = ((budgetDims.width + 15) div 16) * 16
    strideH = ((budgetDims.height + 15) div 16) * 16
    fullMask = strideW * strideH
  doAssert plannedK * 1024 >= fullMask + 2 * (fullMask + fullMask div 2),
    "the plan no longer counts the chroma upsample peak: " & $plannedK & "K"

  # 2) Buffers fit, the output image does not: still a catchable refusal,
  #    naming the output.
  setDecodeBudgetBytes(plannedK * 1024 + 2048)
  try:
    discard decodeJpeg(budgetData)
    doAssert false, "the output image cannot fit in 2K of headroom"
  except PixieError as e:
    doAssert "JPEG output of" in e.msg and "memory budget" in e.msg, e.msg

  # 3) Honest headroom decodes.
  setDecodeBudgetBytes(plannedK * 1024 +
    budgetDims.width * budgetDims.height * 4 + 1024 * 1024)
  doAssert decodeJpeg(budgetData).width == budgetDims.width
  setDecodeBudgetBytes(0)

block:
  # The scaled decode's box sampler: on a non-integer downscale every target
  # pixel must be the area average of its source footprint, not a nearest
  # pick — nearest decimation of fine texture is what made downscaled photos
  # visibly rough. The reference boxes the full decode's pixels with the same
  # source-centric tiling the sampler folds by. 4:4:4 must agree to within
  # fixed-point rounding; 4:2:0 adds half-resolution chroma boxes, so its
  # tolerance is chroma-edge sized. (1:1 and upscales are unchanged nearest:
  # pinned by the scaled paths staying byte-identical there.)
  proc boxCeil(value, scale, divisor: int): int =
    ((value.int64 * scale.int64 + divisor.int64 - 1) div divisor.int64).int

  for (path, tolerance) in [
    ("tests/fileformats/jpeg/masters/cat_4_4_4.jpg", 2),
    ("tests/fileformats/jpeg/masters/cat_4_2_0.jpg", 18)
  ]:
    let
      data = readFile(path)
      full = decodeJpeg(data)
      w = full.width * 5 div 6
      h = full.height * 5 div 6
      scaled = decodeJpegScaled(data, w, h, fitStretch)
    var maxDiff = 0
    for dy in 0 ..< h:
      let
        sy0 = boxCeil(dy, full.height, h)
        sy1 = max(sy0 + 1, min(full.height, boxCeil(dy + 1, full.height, h)))
      for dx in 0 ..< w:
        let
          sx0 = boxCeil(dx, full.width, w)
          sx1 = max(sx0 + 1, min(full.width, boxCeil(dx + 1, full.width, w)))
        var sr, sg, sb: int
        for sy in sy0 ..< sy1:
          for sx in sx0 ..< sx1:
            let p = full.unsafe[sx, sy]
            sr += p.r.int
            sg += p.g.int
            sb += p.b.int
        let
          area = (sy1 - sy0) * (sx1 - sx0)
          q = scaled.unsafe[dx, dy]
        maxDiff = max(maxDiff, max(abs(q.r.int - (sr + area div 2) div area),
          max(abs(q.g.int - (sg + area div 2) div area),
              abs(q.b.int - (sb + area div 2) div area))))
    doAssert maxDiff <= tolerance, path & " maxDiff " & $maxDiff

proc streamedMatchesBufferedDownscale() =
  # The band drain and the streaming window advance together; a streamed
  # downscale must land on exactly the buffered downscale's pixels.
  let data = readFile("tests/fileformats/jpeg/masters/cat_4_2_0.jpg")
  let dims = decodeJpegDimensions(data)
  let
    w = dims.width * 5 div 6
    h = dims.height * 5 div 6
  var pos = 0
  let source = proc(dst: pointer, maxBytes: int): int {.gcsafe, raises: [].} =
    let n = min(min(maxBytes, 977), data.len - pos)
    if n > 0:
      copyMem(dst, data[pos].unsafeAddr, n)
      pos += n
    n
  let
    streamed = decodeJpegStreamScaled(source, data.len, w, h, fitCover)
    buffered = decodeJpegScaled(data, w, h, fitCover)
  doAssert streamed.pixelsEqual(buffered)

streamedMatchesBufferedDownscale()

block:
  # A budget that admits the channel planes but not the bands and accumulator
  # rows beside them must clamp the sampling grid a little further, not
  # refuse: the plan check counts all three, so the clamp has to as well.
  # Before this the refusal handed the caller's degrade ladder a photo that a
  # 94% grid would have decoded, and every 4:4:4 photo bigger than a 13.3"
  # panel came out at half resolution.
  let data = readFile("tests/fileformats/jpeg/masters/cat_4_4_4.jpg")
  let dims = decodeJpegDimensions(data)
  let
    targetW = dims.width div 2
    targetH = dims.height div 2
  # A 1-byte budget clamps the grid to its 64x64 floor and refuses with that
  # floor plan's size — the smallest plan any budget can be asked to hold.
  setDecodeBudgetBytes(1)
  var floorK = 0
  try:
    discard decodeJpegScaled(data, targetW, targetH)
    doAssert false, "a 1-byte budget cannot admit any scaled decode plan"
  except PixieError as e:
    doAssert "memory budget" in e.msg, e.msg
    let needsAt = e.msg.find("needs ") + 6
    let kAt = e.msg.find("K of decode")
    floorK = parseInt(e.msg[needsAt ..< kAt])
  # The full-grid plan for a 4:4:4 source: three target-sized planes, a band
  # of 8 source rows per plane and two accumulator rows per plane.
  let fullPlan = 3 * (targetW * targetH + dims.width * 8 + 2 * targetW * 4)
  doAssert (floorK + 1) * 1024 < fullPlan
  # Every budget between the floor plan and the full plan must decode (at a
  # shaved grid), and the output is always target-sized.
  for budget in [(floorK + 2) * 1024, (fullPlan + (floorK + 2) * 1024) div 2,
      fullPlan - 1024]:
    setDecodeBudgetBytes(budget)
    # Into an existing target, as the frames decode: the plan is the only
    # thing the budget has to hold.
    let target = newImage(targetW, targetH)
    decodeJpegScaledInto(data, target)
    doAssert target.width == targetW and target.height == targetH,
      "budget " & $budget & " refused a decode the floor plan fits"
  setDecodeBudgetBytes(0)

block:
  # A progressive JPEG decoded in strips must land on exactly the pixels of
  # the whole-image decode: every strip reads its own blocks from each scan
  # where the previous pass bookmarked them, so the coefficients come out the
  # same, and the IDCT and the box sampler see the same blocks in the same
  # order. Pinned for every scan script in the corpus (libjpeg's, restart
  # markers, 4:2:0 / 4:2:2 / 4:4:4), every orientation, every fit, at a
  # downscale, an upscale and 1:1, with strips from one MCU row up.
  var progressiveFixtures = @[
    "8x8_progressive", "16x16_progressive", "cat_4_2_0_progressive",
    "cat_4_4_4_progressive", "cat_restart_markers_5_progressive", "testprog",
    "progressive"]
  for n in 1 .. 8:
    progressiveFixtures.add("f" & $n & "-exif-progressive")
  for name in progressiveFixtures:
    let
      path = "tests/fileformats/jpeg/masters/" & name & ".jpg"
      data = readFile(path)
      dims = decodeJpegDimensions(data)
    doAssert decodeJpegInfo(data).progressive, path
    setJpegStripMcuRows(0)
    let whole = decodeJpeg(data)
    for rows in [1, 2, 3, 7]:
      setJpegStripMcuRows(rows)
      doAssert decodeJpeg(data).pixelsEqual(whole), path & " in strips of " & $rows
    for fit in ScaledDecodeFit:
      for (w, h) in [
        (max(1, dims.width * 5 div 6), max(1, dims.height * 5 div 6)),
        (dims.width * 3 div 2 + 1, max(1, dims.height div 3)),
        (dims.width, dims.height)
      ]:
        setJpegStripMcuRows(0)
        # Into a prefilled target: contain leaves its letterbox alone.
        let wholeScaled = newImage(w, h)
        wholeScaled.fill(rgbx(9, 99, 199, 255))
        decodeJpegScaledInto(data, wholeScaled, fit)
        for rows in [1, 3]:
          setJpegStripMcuRows(rows)
          let target = newImage(w, h)
          target.fill(rgbx(9, 99, 199, 255))
          decodeJpegScaledInto(data, target, fit)
          doAssert target.pixelsEqual(wholeScaled),
            path & " " & $fit & " " & $w & "x" & $h & " in strips of " & $rows
  setJpegStripMcuRows(0)

proc oneToOneFits() =
  # fitCenter and the anchored fits draw the source 1:1: into a smaller
  # target, the part of the source that shows at full resolution (a
  # 4032x3024 photo on a 1600x1200 panel samples a 1600x1200 window, not the
  # whole photo); into a larger one, the whole source where the fit pins it,
  # the target's borders left as they were.
  #
  # Against the 1:1 decode of the whole photo: exact where colour is not
  # subsampled. Subsampled colour is sampled from the window's own grid, the
  # way cover's crop is (a cover crop of testimg at scale 1 is off by 55 at
  # its sharpest edge, 2 on average), so there it is the same picture up to
  # chroma phase.
  let marker = rgbx(9, 99, 199, 255)
  for (name, exact) in [("cat_4_4_4", true), ("cat_4_2_0", false), ("testimg", false),
      ("f6-exif", false), ("cat_4_2_0_progressive", false)]:
    let
      path = "tests/fileformats/jpeg/masters/" & name & ".jpg"
      data = readFile(path)
      whole = decodeJpeg(data)
      (w, h) = (whole.width, whole.height)
      native = decodeJpegScaled(data, w, h, fitStretch)
    for fit in OneToOneFits:
      let anchor = fit.oneToOneAnchor()
      var worst, total, count = 0
      proc compare(a, b: ColorRGBX) =
        let d = max(max(abs(a.r.int - b.r.int), abs(a.g.int - b.g.int)), abs(a.b.int - b.b.int))
        worst = max(worst, d)
        total += d
        inc count
      let
        (sw, sh) = (max(1, w * 2 div 3), max(1, h div 2))
        small = newImage(sw, sh)
      small.fill(marker)
      decodeJpegScaledInto(data, small, fit)
      let (x0, y0) = ((w - sw) * anchor.x div 2, (h - sh) * anchor.y div 2)
      for y in 0 ..< sh:
        for x in 0 ..< sw:
          compare(small[x, y], native[x0 + x, y0 + y])
      let big = newImage(w + 11, h + 7)
      big.fill(marker)
      decodeJpegScaledInto(data, big, fit)
      let (dx, dy) = (11 * anchor.x div 2, 7 * anchor.y div 2)
      for y in 0 ..< h:
        for x in 0 ..< w:
          compare(big[dx + x, dy + y], native[x, y])
      var outside = 0
      for y in 0 ..< big.height:
        for x in 0 ..< big.width:
          if (x < dx or x >= dx + w or y < dy or y >= dy + h) and big[x, y] != marker:
            inc outside
      doAssert outside == 0, path & " " & $fit & ": the target's borders are left alone"
      if exact:
        doAssert worst == 0, path & " " & $fit & ": the 1:1 picture, off by " & $worst
      else:
        doAssert total div max(1, count) <= 6, path & " " & $fit & ": the 1:1 picture, off by " &
          $(total div max(1, count)) & " on average"

proc stripsThroughAStream() =
  # The same through a stream. A stream that can rewind is read once per
  # strip; one that cannot still decodes whole when the budget holds the
  # coefficients, and otherwise says so catchably, so the caller retries
  # from a buffer.
  let
    data = readFile("tests/fileformats/jpeg/masters/cat_4_2_0_progressive.jpg")
    dims = decodeJpegDimensions(data)
    w = dims.width * 5 div 6
    h = dims.height * 5 div 6
  var pos = 0
  var rewinds = 0
  let source = proc(dst: pointer, maxBytes: int): int {.gcsafe, raises: [].} =
    let n = min(min(maxBytes, 977), data.len - pos)
    if n > 0:
      copyMem(dst, data[pos].unsafeAddr, n)
      pos += n
    n
  let rewind = proc(): bool {.gcsafe, raises: [].} =
    pos = 0
    inc rewinds
    true
  setJpegStripMcuRows(0)
  let whole = decodeJpegScaled(data, w, h, fitCover)
  # Whole: no rewind needed, and none asked for.
  pos = 0
  doAssert decodeJpegStreamScaled(source, data.len, w, h, fitCover).pixelsEqual(whole)
  # In strips of 2 MCU rows: a pass per strip, every one from byte 0.
  setJpegStripMcuRows(2)
  pos = 0
  doAssert decodeJpegStreamScaled(source, data.len, w, h, fitCover, rewind).pixelsEqual(whole)
  let strips = ((dims.height + 15) div 16 + 1) div 2
  doAssert rewinds == strips - 1, $rewinds & " rewinds for " & $strips & " strips"
  pos = 0
  try:
    discard decodeJpegStreamScaled(source, data.len, w, h, fitCover)
    doAssert false, "a stream without a rewind cannot carry a strip decode"
  except PixieError as e:
    doAssert "cannot be decoded from a stream" in e.msg, e.msg
    doAssert "memory budget" notin e.msg, e.msg
  setJpegStripMcuRows(0)

stripsThroughAStream()
oneToOneFits()

block:
  # With no override the budget sizes the strip: a budget that holds the
  # masks plus a few MCU rows of coefficients decodes (where it used to
  # refuse, the whole image's blocks being the plan), and lands on the
  # whole-image pixels. Too small for even one row stays a budget refusal.
  let
    data = readFile("tests/fileformats/jpeg/masters/progressive.jpg")
    info = decodeJpegInfo(data)
    w = info.width div 2
    h = info.height div 2
  setDecodeBudgetBytes(0)
  let whole = decodeJpegScaled(data, w, h, fitStretch)
  var perRow: int64
  for scale in info.componentScales:
    perRow += ((info.width + 15) div 16).int64 * scale.yScale.int64 *
      scale.xScale.int64 * 128
  let everything = jpegDecodeIntermediateBytes(info, w, h)
  doAssert everything > perRow * 10, "progressive.jpg should be dozens of MCU rows"
  # Masks (plus bands and accumulators, which the estimate leaves out) and
  # three rows of blocks: enough for a strip decode, far short of the whole.
  let masks = everything - perRow * ((info.height + 15) div 16)
  setDecodeBudgetBytes((masks + perRow * 3 + 3 * info.width * 8 * 2 + 6 * w * 4).int)
  let target = newImage(w, h)
  decodeJpegScaledInto(data, target, fitStretch)
  doAssert target.pixelsEqual(whole)
  doAssert jpegDecodeIntermediateBytes(info, w, h) < everything
  setDecodeBudgetBytes(1)
  try:
    decodeJpegScaledInto(data, target, fitStretch)
    doAssert false, "a 1-byte budget cannot hold a row of coefficients"
  except PixieError as e:
    doAssert "memory budget" in e.msg, e.msg
  setDecodeBudgetBytes(0)

block:
  # The same strip decode into a NEW image: the output is allocated beside
  # the plan, so the strips must leave it room. They were sized to the whole
  # budget, and the output check after them refused every progressive photo
  # that needed strips (an ESP32 slideshow, 2026-10-25). The budget below
  # holds the strip plan and the output, and decodes; without the output's
  # room it refuses before the entropy decode, not after it.
  let
    data = readFile("tests/fileformats/jpeg/masters/progressive.jpg")
    info = decodeJpegInfo(data)
    w = info.width div 2
    h = info.height div 2
  setDecodeBudgetBytes(0)
  let whole = decodeJpegScaled(data, w, h, fitStretch)
  var perRow: int64
  for scale in info.componentScales:
    perRow += ((info.width + 15) div 16).int64 * scale.yScale.int64 *
      scale.xScale.int64 * 128
  let everything = jpegDecodeIntermediateBytes(info, w, h)
  let masks = everything - perRow * ((info.height + 15) div 16)
  let output = w.int64 * h.int64 * 4
  setDecodeBudgetBytes((masks + perRow * 3 + 3 * info.width * 8 * 2 + 6 * w * 4 + output).int)
  doAssert decodeJpegScaled(data, w, h, fitStretch).pixelsEqual(whole)
  # Unscaled too: the whole image is the output. A 1-byte budget's refusal
  # names the one-row plan; that plus two more rows and the output decodes.
  setDecodeBudgetBytes(0)
  let full = decodeJpeg(data)
  setDecodeBudgetBytes(1)
  var oneRowK = 0
  try:
    discard decodeJpeg(data)
    doAssert false, "a 1-byte budget cannot hold a row of coefficients"
  except PixieError as e:
    let needsAt = e.msg.find("needs ") + 6
    oneRowK = parseInt(e.msg[needsAt ..< e.msg.find("K of decode")])
  setDecodeBudgetBytes((oneRowK.int64 * 1024 + 1024 + perRow * 2 +
    info.width.int64 * info.height.int64 * 4).int)
  doAssert decodeJpeg(data).pixelsEqual(full)
  # An output the budget cannot hold beside even the smallest plan.
  setDecodeBudgetBytes(output.int)
  try:
    discard decodeJpegScaled(data, w, h, fitStretch)
    doAssert false, "the output alone fills this budget"
  except PixieError as e:
    doAssert "memory budget" in e.msg, e.msg
  setDecodeBudgetBytes(0)

block:
  # The sink: a decode into a target no longer finishes target-sized channel
  # planes and fills the target from them; it keeps a ring of channel rows
  # and draws each target line as soon as every component has its samples.
  # It must land on exactly the pixels the whole-plane fill draws (which
  # decodeJpegScaled, building a new image, still does): every subsampling,
  # a grayscale, restart markers, every orientation, every fit, downscales,
  # upscales, 1:1, a tiny target, and the progressive files in strips.
  var fixtures = @[
    "cat_4_2_0", "cat_4_4_4", "cat_4_2_2", "cat_4_1_1", "mandrill",
    "grayscale_test", "cat_restart_markers_5", "restartmarker", "testimg",
    "cat_4_2_0_progressive", "cat_4_4_4_progressive",
    "cat_restart_markers_5_progressive", "progressive", "testprog"]
  for n in 1 .. 8:
    fixtures.add("f" & $n & "-exif")
    fixtures.add("f" & $n & "-exif-progressive")
  for name in fixtures:
    let
      path = "tests/fileformats/jpeg/masters/" & name & ".jpg"
      data = readFile(path)
      dims = decodeJpegDimensions(data)
      progressive = decodeJpegInfo(data).progressive
    for fit in ScaledDecodeFit:
      for (w, h) in [
        (max(1, dims.width * 5 div 6), max(1, dims.height * 5 div 6)),
        (dims.width * 3 div 2 + 1, max(1, dims.height div 3)),
        (dims.width, dims.height),
        (max(1, dims.width div 4), max(1, dims.height div 4)),
        (7, 5),
        (dims.width * 4 + 3, dims.height * 3 + 1)
      ]:
        setJpegStripMcuRows(0)
        let whole = decodeJpegScaled(data, w, h, fit)
        for rows in (if progressive: @[0, 1, 3] else: @[0]):
          setJpegStripMcuRows(rows)
          let target = newImage(w, h)
          decodeJpegScaledInto(data, target, fit)
          doAssert target.pixelsEqual(whole),
            path & " " & $fit & " " & $w & "x" & $h & " strips " & $rows
  setJpegStripMcuRows(0)

block:
  # What the sink is for: a budget far below the target-sized planes used
  # to clamp the sampling grid, and the picture came out soft. With rings
  # the same budget decodes at full resolution, pixel for pixel what no
  # budget at all decodes.
  # (On a 200-pixel image the bands and accumulators alone are a quarter
  # of the planes, and the grid clamps as it should; the point is the
  # panel-sized ones.)
  for (name, divisor) in [("progressive", 1), ("mandrill", 1)]:
    let
      data = readFile("tests/fileformats/jpeg/masters/" & name & ".jpg")
      info = decodeJpegInfo(data)
      w = info.width div divisor
      h = info.height div divisor
    setDecodeBudgetBytes(0)
    let whole = decodeJpegScaled(data, w, h, fitStretch)
    var planes: int64
    for scale in info.componentScales:
      planes += ((w * scale.yScale + info.maxYScale - 1) div info.maxYScale).int64 *
        ((h * scale.xScale + info.maxXScale - 1) div info.maxXScale).int64
    # A quarter of the planes: rings, bands, accumulators and a strip or
    # two of coefficients fit; the planes never did.
    setDecodeBudgetBytes(int(planes div 4))
    let target = newImage(w, h)
    decodeJpegScaledInto(data, target, fitStretch)
    doAssert target.pixelsEqual(whole), name & " softened under a budget of planes/4"
    setDecodeBudgetBytes(0)
