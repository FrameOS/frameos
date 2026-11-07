import bumpy, chroma, vmath

type
  PixieError* = object of CatchableError ## Raised if an operation fails.

  BlendMode* = enum
    NormalBlend
    DarkenBlend
    MultiplyBlend
    # BlendLinearBurn
    ColorBurnBlend
    LightenBlend
    ScreenBlend
    # BlendLinearDodge
    ColorDodgeBlend
    OverlayBlend
    SoftLightBlend
    HardLightBlend
    DifferenceBlend
    ExclusionBlend
    HueBlend
    SaturationBlend
    ColorBlend
    LuminosityBlend

    MaskBlend         ## Special blend mode that is used for masking
    OverwriteBlend    ## Special blend mode that just copies pixels
    SubtractMaskBlend ## Inverse mask
    ExcludeMaskBlend

  ImageDimensions* = object
    width*, height*: int

  ScaledDecodeFit* = enum
    ## How a scaled decode maps the source onto the target image.
    fitStretch ## fill the whole target, ignoring aspect ratio
    fitCover   ## fill the whole target, cropping the source centered
    fitContain ## fit the whole source centered, leaving target borders untouched
    fitCenter  ## the source 1:1, centered: the middle of a larger one, a
               ## smaller one whole, leaving target borders untouched
    # The source 1:1 like fitCenter, anchored at an edge or a corner instead:
    # the part of a larger source on that side, a smaller one whole on it.
    fitTopLeft, fitTopCenter, fitTopRight, fitCenterLeft, fitCenterRight,
    fitBottomLeft, fitBottomCenter, fitBottomRight

  PixelFormat* = enum
    ## How an image stores its pixels. Everything in pixie composites in
    ## premultiplied RGBA (`ColorRGBX`); the storage format only decides what
    ## those values are packed into on the way in and out of memory.
    pfRgbx   ## 32-bit premultiplied RGBA — the format every image had before
    pfRgb565 ## 16-bit packed RGB (5/6/5), no alpha; reads back fully opaque
    pfGray8  ## 8-bit luma, no alpha; reads back as an opaque grey. A canvas
             ## for a greyscale panel: a quarter of RGBX's memory, half of
             ## 565's, and nothing a grey panel can show is lost

  Image* {.acyclic.} = ref object
    ## Image object that holds bitmap data in premultiplied alpha RGBA format.
    ##
    ## Or — since `pfRgb565` exists — in a 16-bit RGB format that halves the
    ## memory and drops alpha. A 565 image is a *presentation surface*: a
    ## final canvas that opaque geometry and decoded pictures are composited
    ## onto and that a display driver then reads. Everything that draws onto
    ## an image works on one (solid fills, antialiased paths and text, image
    ## draws with any blend mode, gradients, opacity), and so does reading
    ## pixels back, copying and viewing. What does NOT work is using one as
    ## an *alpha mask* or as a filter scratch buffer — `shadow`, `spread`,
    ## `blur`, `minifyBy2`/`magnifyBy2`, `invert`, `ceil`, `rotate90` and
    ## the opaque/transparent predicates raise `PixieError` rather than
    ## guess, because those operations are defined by an alpha channel a 565
    ## image does not have. Drawing a 565 image onto another image works
    ## (it reads back opaque); scaling one is done through an RGBX copy.
    ##
    ## `pfGray8` is the same kind of presentation surface with one byte of
    ## luma per pixel (BT.601 weights, `rgbxToGray8`). Everything said about
    ## 565 holds for it. Blending onto it blends the grey backdrop with the
    ## colour source and keeps the luma of the result, so for every blend
    ## mode whose channels are independent (normal, multiply, screen,
    ## overlay, ...) it is exactly the grey of what an RGBX canvas would
    ## hold; only the modes that read the backdrop's hue (hue, saturation,
    ## color, luminosity) see a backdrop that has none.
    ##
    ## Premultiplied colour written into a 565 image keeps its premultiplied
    ## RGB and forgets the alpha, which is exactly what a display driver that
    ## reads `.r/.g/.b` off an RGBA canvas saw anyway: a half-transparent
    ## pixel over nothing reads as a half-dark one. Reads come back with
    ## alpha 255, so compositing onto a 565 image is compositing onto an
    ## opaque backdrop, which is what a canvas filled with a background
    ## colour is.
    ##
    ## `{.acyclic.}` is load-bearing, not an optimisation. `root` makes this
    ## type look cyclic to ORC, but a view's `root` always points at an owner
    ## (see `subImageView`), never at another view, so no cycle can form.
    ## Without the pragma every non-final decref registers the image with the
    ## cycle collector's root list, and FrameOS hands Images across a shared
    ## library boundary (driver .so files carry their own ORC runtime): the
    ## .so registers the object in ITS root list, the host later unregisters
    ## it from ITS OWN, and the host dies in `unregisterCycle`. Marking the
    ## type acyclic keeps it on plain refcounts, which are safe to share.
    ##
    ## An image either **owns** its pixels or is a **view** into another
    ## image's. A view shares the owner's buffer and addresses a rectangle
    ## inside it, so handing a caller a sub-region costs nothing and writes
    ## through to the original — which is what lets a tiled render draw its
    ## cells in place instead of copying each one out and back.
    ##
    ## `stride` is the distance between rows in the shared buffer, so it equals
    ## `width` for an owner and the owner's `width` for a view. Everything that
    ## addresses pixels through `dataIndex` is therefore correct for both.
    ## Anything that walks the buffer flat, assuming rows are contiguous across
    ## the whole image, is correct only for an owner — see `isContiguous`.
    width*, height*: int
    stride*: int  ## elements between vertically adjacent pixels
    origin*: int  ## index of (0, 0) within the shared buffer
    format*: PixelFormat ## how `pixels` / `pixels16` are laid out
    ditherStores*: bool ## 565 only: offset each store by a per-pixel
                        ## fraction of one step before rounding, so smooth
                        ## gradients survive quantisation for a later
                        ## error-diffusion pass. See rgbxToRgb565Dithered.
    storage: seq[ColorRGBX] ## owned pixels; empty for a view or a 565 image
    storage16: seq[uint16]  ## owned 565 pixels; empty for a view, an RGBX
                            ## image, or a 565 image over a borrowed buffer
    storage8: seq[uint8]    ## owned luma pixels, like storage16 for pfGray8
    root: Image             ## the owner whose buffer this views; nil if owner
    pixels: ptr UncheckedArray[ColorRGBX] ## the RGBX buffer, owned or borrowed
    pixels16: ptr UncheckedArray[uint16]  ## the 565 buffer, owned or borrowed
    pixels8: ptr UncheckedArray[uint8]    ## the luma buffer, owned or borrowed

  ImageSourceProc* = proc(
    dst: pointer, maxBytes: int
  ): int {.gcsafe, raises: [].}
    ## Pull callback for streamed decodes: fill `dst` with up to `maxBytes`
    ## sequential input bytes, returning how many were written (<= 0 on EOF
    ## or read error — the decode then fails with a catchable PixieError).

const OneToOneFits* = {fitCenter, fitTopLeft, fitTopCenter, fitTopRight,
  fitCenterLeft, fitCenterRight, fitBottomLeft, fitBottomCenter, fitBottomRight}
  ## The fits that draw the source at scale 1.

proc oneToOneAnchor*(fit: ScaledDecodeFit): tuple[x, y: int] =
  ## Where a 1:1 fit pins the source, in halves of the free space: 0 the
  ## left/top edge, 1 the middle, 2 the right/bottom edge.
  case fit
  of fitTopLeft: (0, 0)
  of fitTopCenter: (1, 0)
  of fitTopRight: (2, 0)
  of fitCenterLeft: (0, 1)
  of fitCenterRight: (2, 1)
  of fitBottomLeft: (0, 2)
  of fitBottomCenter: (1, 2)
  of fitBottomRight: (2, 2)
  else: (1, 1)

proc oneToOneRects*(
  srcWidth, srcHeight, targetWidth, targetHeight: int, fit: ScaledDecodeFit
): tuple[srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH: int] =
  ## A 1:1 fit's source window and its place on the target: the part of a
  ## larger source that shows, a smaller source whole, pinned where the fit
  ## says. Integer halves, like a `div 2` placement of the drawn image.
  let
    anchor = fit.oneToOneAnchor()
    w = min(srcWidth, targetWidth)
    h = min(srcHeight, targetHeight)
  (
    (srcWidth - w) * anchor.x div 2, (srcHeight - h) * anchor.y div 2, w, h,
    (targetWidth - w) * anchor.x div 2, (targetHeight - h) * anchor.y div 2, w, h
  )

proc scaledFitRects*(
  srcWidth, srcHeight, targetWidth, targetHeight: int, fit: ScaledDecodeFit
): tuple[srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH: int] =
  ## Computes the source crop and target placement rectangles for a fit mode.
  result = (0, 0, srcWidth, srcHeight, 0, 0, targetWidth, targetHeight)
  case fit
  of fitStretch:
    discard
  of fitCover:
    if srcWidth.int64 * targetHeight.int64 >
        targetWidth.int64 * srcHeight.int64:
      let cropW = max(1, (
        srcHeight.int64 * targetWidth.int64 div
        max(1'i64, targetHeight.int64)).int)
      result.srcX = (srcWidth - cropW) div 2
      result.srcW = cropW
    else:
      let cropH = max(1, (
        srcWidth.int64 * targetHeight.int64 div
        max(1'i64, targetWidth.int64)).int)
      result.srcY = (srcHeight - cropH) div 2
      result.srcH = cropH
  of fitContain:
    if srcWidth.int64 * targetHeight.int64 >
        targetWidth.int64 * srcHeight.int64:
      let fitH = max(1, (
        targetWidth.int64 * srcHeight.int64 div
        max(1'i64, srcWidth.int64)).int)
      result.dstY = (targetHeight - fitH) div 2
      result.dstH = fitH
    else:
      let fitW = max(1, (
        targetHeight.int64 * srcWidth.int64 div
        max(1'i64, srcHeight.int64)).int)
      result.dstX = (targetWidth - fitW) div 2
      result.dstW = fitW
  of OneToOneFits:
    result = oneToOneRects(srcWidth, srcHeight, targetWidth, targetHeight, fit)

template data*(image: Image): ptr UncheckedArray[ColorRGBX] =
  ## The pixels this image addresses — its own, or its owner's when it is a
  ## view. Indexed with `dataIndex`, never with a flat running counter unless
  ## `isContiguous` says that is safe.
  ##
  ## Only meaningful for a `pfRgbx` image. Code that can be handed a 565 image
  ## goes through `getPixel`/`setPixel` (or `unsafe[]`), which branch on the
  ## format, and the flat kernels check `image.format` before touching this.
  image.pixels

template data16*(image: Image): ptr UncheckedArray[uint16] =
  ## The 565 pixels of a `pfRgb565` image, addressed like `data`.
  image.pixels16

template data8*(image: Image): ptr UncheckedArray[uint8] =
  ## The luma pixels of a `pfGray8` image, addressed like `data`.
  image.pixels8

template dataIndex*(image: Image, x, y: int): int =
  image.origin + image.stride * y + x

template isRgbx*(image: Image): bool =
  image.format == pfRgbx

template isRgb565*(image: Image): bool =
  image.format == pfRgb565

template isGray8*(image: Image): bool =
  image.format == pfGray8

proc rgbxToGray8*(c: ColorRGBX): uint8 {.inline, raises: [].} =
  ## The luma of a premultiplied RGBX colour: BT.601 weights in 256ths
  ## (77 + 150 + 29 = 256), rounded. Alpha is dropped as for 565: a
  ## translucent pixel lands as the darker grey of its premultiplied RGB.
  ## Idempotent with `gray8ToRgbx`: a grey expands and packs back to itself.
  ((c.r.uint32 * 77 + c.g.uint32 * 150 + c.b.uint32 * 29 + 128) shr 8).uint8

proc gray8ToRgbx*(l: uint8): ColorRGBX {.inline, raises: [].} =
  ## An opaque grey.
  ColorRGBX(r: l, g: l, b: l, a: 255)

proc rgbxToRgb565*(c: ColorRGBX): uint16 {.inline, raises: [].} =
  ## Packs a premultiplied RGBX colour into 5/6/5, rounding each channel to
  ## nearest. Alpha is dropped; the premultiplied RGB is what survives, so a
  ## translucent pixel lands as the darker colour a driver reading the RGBA
  ## canvas's RGB would have seen.
  ##
  ## The multiply-shift forms are exact `round(v * 31 / 255)` and
  ## `round(v * 63 / 255)` for every byte, and they are idempotent with
  ## `rgb565ToRgbx`: expanding then re-packing a 565 value gives it back, so
  ## a read-modify-write that changes nothing changes nothing.
  let
    r = (c.r.uint32 * 249 + 1014) shr 11
    g = (c.g.uint32 * 253 + 505) shr 10
    b = (c.b.uint32 * 249 + 1014) shr 11
  uint16((r shl 11) or (g shl 5) or b)

proc rgb565ToRgbx*(p: uint16): ColorRGBX {.inline, raises: [].} =
  ## Expands a 5/6/5 pixel to an opaque RGBX colour, replicating the top bits
  ## into the low bits so 0 stays 0 and full scale stays 255.
  let
    r = (p.uint32 shr 11) and 31
    g = (p.uint32 shr 5) and 63
    b = p.uint32 and 31
  result.r = ((r shl 3) or (r shr 2)).uint8
  result.g = ((g shl 2) or (g shr 4)).uint8
  result.b = ((b shl 3) or (b shr 2)).uint8
  result.a = 255

template getPixel*(image: Image, index: int): ColorRGBX =
  ## The pixel at a `dataIndex`, whatever the storage format.
  (if image.format == pfRgbx: image.pixels[index]
   elif image.format == pfGray8: gray8ToRgbx(image.pixels8[index])
   else: rgb565ToRgbx(image.pixels16[index]))

proc rgbxToRgb565Dithered*(c: ColorRGBX, index: int): uint16 {.inline, raises: [].} =
  ## `rgbxToRgb565` with a per-pixel rounding offset chosen by the pixel
  ## index, for canvases that will be error-diffused afterwards.
  ##
  ## Rounding every pixel to the nearest 5/6-bit level turns a smooth
  ## gradient into plateaus — a 480-row sky holds 11 blue levels instead of
  ## 90 — and a Floyd–Steinberg pass over plateaus settles into one uniform
  ## texture per plateau, so the plateau edges show on the panel as lines.
  ## Offsetting each pixel by a position-dependent fraction of one 565 step
  ## before rounding keeps the local mean of the stored colour equal to the
  ## true colour; the diffusion pass then sees a gradient again.
  ##
  ## Idempotence is kept the way the plain pack keeps it: a channel that is
  ## already an exact 565 representative (what `rgb565ToRgbx` expands to)
  ## is stored without any offset, so a read-modify-write that changes
  ## nothing still changes nothing, and a blend can be repeated over the
  ## canvas without the stored colour drifting.
  # A multiplicative hash of the index, not a Bayer cell: the store only
  # knows the flat index, and any pattern keyed on it alone lines up row
  # over row whenever the width is a multiple of the pattern's period (800
  # and 1200 both are), which prints vertical stripes. Sixteen hash buckets
  # give offsets of -8..+7 eight-bit units (one 5-bit step is 8.2, one
  # 6-bit step 4.05, so the 6-bit offset is halved); the mean offset is
  # -0.5, well inside a step.
  let
    cell = (index.uint32 * 0x9E3779B1'u32) shr 28
    off5 = cell.int - 8
    off6 = (cell.int - 8) div 2
  template pack5(v: uint8, off: int): uint32 =
    let exact = ((v.uint32 * 249 + 1014) shr 11)
    if ((exact shl 3) or (exact shr 2)) == v.uint32: exact
    else:
      let d = clamp(v.int + off, 0, 255).uint32
      (d * 249 + 1014) shr 11
  template pack6(v: uint8, off: int): uint32 =
    let exact = ((v.uint32 * 253 + 505) shr 10)
    if ((exact shl 2) or (exact shr 4)) == v.uint32: exact
    else:
      let d = clamp(v.int + off, 0, 255).uint32
      (d * 253 + 505) shr 10
  let
    r = pack5(c.r, off5)
    g = pack6(c.g, off6)
    b = pack5(c.b, off5)
  uint16((r shl 11) or (g shl 5) or b)

template setPixel*(image: Image, index: int, color: ColorRGBX) =
  ## Stores a premultiplied pixel at a `dataIndex`, whatever the storage format.
  if image.format == pfRgbx:
    image.pixels[index] = color
  elif image.format == pfGray8:
    image.pixels8[index] = rgbxToGray8(color)
  elif image.ditherStores:
    image.pixels16[index] = rgbxToRgb565Dithered(color, index)
  else:
    image.pixels16[index] = rgbxToRgb565(color)

template bytesPerPixel*(image: Image): int =
  (case image.format
   of pfRgbx: 4
   of pfRgb565: 2
   of pfGray8: 1)

template pixelAddr*(image: Image, index: int): pointer =
  ## The address of the pixel at a `dataIndex`, whatever the storage format:
  ## what a row copy or a row compare starts from.
  (case image.format
   of pfRgbx: cast[pointer](image.pixels[index].addr)
   of pfRgb565: cast[pointer](image.pixels16[index].addr)
   of pfGray8: cast[pointer](image.pixels8[index].addr))

template bufferPointer*(image: Image): pointer =
  ## The start of the pixel buffer this image addresses, whatever its format.
  ## Two images share memory (one is a view of the other, or of the same
  ## owner) exactly when this is equal — the identity question "does this
  ## value alias my canvas?" asked in a way that is not fooled by one side
  ## being RGBX and the other 565.
  (case image.format
   of pfRgb565: cast[pointer](image.pixels16)
   of pfGray8: cast[pointer](image.pixels8)
   of pfRgbx: cast[pointer](image.pixels))

template byteSize*(image: Image): int =
  ## Bytes the image's own pixels occupy: width * height * bytesPerPixel.
  image.width * image.height * image.bytesPerPixel

template requireRgbx*(image: Image, what: string) =
  ## Guard for operations that are only defined on an RGBA image — the ones
  ## whose meaning is the alpha channel. Raising is the honest answer: a 565
  ## image has no alpha to spread, mask, or test, and silently treating it as
  ## opaque would make a mask-based effect produce a rectangle.
  if image.format != pfRgbx:
    raise newException(PixieError, what & " needs an RGBA image, not a " &
      $image.format & " one")

template isContiguous*(image: Image): bool =
  ## True when the image's rows sit back to back in the buffer, which is what a
  ## whole-image flat loop needs. Always true for an owner; true for a view only
  ## when it is full width.
  image.stride == image.width

template forEachSpan*(image: Image, body: untyped) =
  ## Runs `body` over every run of pixels that IS contiguous in the buffer,
  ## injecting `spanStart` (an index into `image.data`) and `spanLen`.
  ##
  ## An image that owns its pixels is one span, so a whole-image operation
  ## written this way costs exactly what it did before the views existed — one
  ## call, one loop, the same SIMD. A view is one span per row. This is the
  ## seam that lets flat operations stay fast and become correct at once.
  block:
    if image.stride == image.width:
      let spanStart {.inject.} = image.origin
      let spanLen {.inject.} = image.width * image.height
      body
    else:
      for spanRow in 0 ..< image.height:
        let spanStart {.inject.} = image.origin + image.stride * spanRow
        let spanLen {.inject.} = image.width
        body

template dataLen*(image: Image): int =
  ## Number of pixels the image addresses. Only the extent of a flat walk when
  ## `isContiguous`.
  image.width * image.height

type RowBoxSampler* = object
  ## The shared sampler for row-streamed scaled decodes (PNG, BMP, PPM).
  ## Full source scanlines are fed in as they decode, and each target pixel
  ## of the fitted rect becomes the rounded average of its exact source
  ## footprint — a proper area filter on downscale axes, so thin strokes
  ## dim instead of disappearing the way nearest decimation swallowed them.
  ## Axes at 1:1 reduce to the identity and upscale axes keep the exact
  ## former nearest replication, byte for byte. Rows may arrive top-down or
  ## bottom-up (BMP), as long as the rows inside one vertical footprint are
  ## contiguous. Peak memory: two target-width accumulator rows.
  srcX, srcY, srcW, srcH: int
  dstX, dstY, dstW, dstH: int
  boxX, boxY: bool
  colCount: seq[uint32]  ## source columns per target column, when boxX
  line: seq[uint64]      ## one scanline folded to target width (RGBX sums)
  sums: seq[uint64]      ## the vertical accumulator, when boxY
  currentTy: int         ## relative target row being accumulated; -1 = none
  rowsInBox: int

proc initRowBoxSampler*(
  srcWidth, srcHeight, targetWidth, targetHeight: int, fit: ScaledDecodeFit
): RowBoxSampler =
  let rects = scaledFitRects(srcWidth, srcHeight, targetWidth, targetHeight, fit)
  result.srcX = rects.srcX
  result.srcY = rects.srcY
  result.srcW = rects.srcW
  result.srcH = rects.srcH
  result.dstX = rects.dstX
  result.dstY = rects.dstY
  result.dstW = rects.dstW
  result.dstH = rects.dstH
  result.boxX = rects.srcW >= rects.dstW
  result.boxY = rects.srcH >= rects.dstH
  result.currentTy = -1
  result.line = newSeq[uint64](rects.dstW * 4)
  if result.boxX:
    result.colCount = newSeq[uint32](rects.dstW)
    for sx in 0 ..< rects.srcW:
      inc result.colCount[(sx.int64 * rects.dstW.int64).int div rects.srcW]
  if result.boxY:
    result.sums = newSeq[uint64](rects.dstW * 4)

proc wantsRow*(sampler: RowBoxSampler, sy: int): bool {.inline.} =
  ## Whether this source row contributes at all — callers skip the pixel
  ## conversion (or the read itself) for rows outside the crop.
  sy >= sampler.srcY and sy < sampler.srcY + sampler.srcH

proc foldRowX(sampler: var RowBoxSampler, row: openArray[ColorRGBX]) =
  if sampler.boxX:
    for i in 0 ..< sampler.line.len:
      sampler.line[i] = 0
    for sx in 0 ..< sampler.srcW:
      let
        tx = (sx.int64 * sampler.dstW.int64).int div sampler.srcW
        px = row[sampler.srcX + sx]
        base = tx * 4
      sampler.line[base + 0] += px.r
      sampler.line[base + 1] += px.g
      sampler.line[base + 2] += px.b
      sampler.line[base + 3] += px.a
  else:
    for tx in 0 ..< sampler.dstW:
      let
        px = row[sampler.srcX + (tx * sampler.srcW) div sampler.dstW]
        base = tx * 4
      sampler.line[base + 0] = px.r
      sampler.line[base + 1] = px.g
      sampler.line[base + 2] = px.b
      sampler.line[base + 3] = px.a

proc writeSampledRow(
  sampler: RowBoxSampler, target: Image, ty: int,
  values: seq[uint64], rows: int
) =
  let outY = sampler.dstY + ty
  for tx in 0 ..< sampler.dstW:
    let
      area = uint64(rows) *
        (if sampler.boxX: sampler.colCount[tx].uint64 else: 1'u64)
      base = tx * 4
      half = area div 2
    # One write point for every row-streamed decode, so a 565 target costs
    # the decoders nothing: the accumulator is 8-bit-per-channel all the way
    # to here and only the final store packs.
    target.setPixel(target.dataIndex(sampler.dstX + tx, outY), ColorRGBX(
      r: ((values[base + 0] + half) div area).uint8,
      g: ((values[base + 1] + half) div area).uint8,
      b: ((values[base + 2] + half) div area).uint8,
      a: ((values[base + 3] + half) div area).uint8
    ))

proc flushBoxRow(sampler: var RowBoxSampler, target: Image) =
  if sampler.currentTy < 0 or sampler.rowsInBox == 0:
    return
  sampler.writeSampledRow(target, sampler.currentTy, sampler.sums, sampler.rowsInBox)
  for i in 0 ..< sampler.sums.len:
    sampler.sums[i] = 0
  sampler.rowsInBox = 0
  sampler.currentTy = -1

proc feedRow*(
  sampler: var RowBoxSampler, target: Image, sy: int, row: openArray[ColorRGBX]
) =
  ## Folds one full source scanline (premultiplied pixels) into the target.
  if not sampler.wantsRow(sy):
    return
  let rel = sy - sampler.srcY
  sampler.foldRowX(row)
  if sampler.boxY:
    let ty = (rel.int64 * sampler.dstH.int64).int div sampler.srcH
    if ty != sampler.currentTy:
      sampler.flushBoxRow(target)
      sampler.currentTy = ty
    for i in 0 ..< sampler.sums.len:
      sampler.sums[i] += sampler.line[i]
    inc sampler.rowsInBox
  else:
    let
      tyLo = ((rel.int64 * sampler.dstH.int64 + sampler.srcH - 1) div
        sampler.srcH).int
      tyHi = min(sampler.dstH, ((int64(rel + 1) * sampler.dstH.int64 +
        sampler.srcH - 1) div sampler.srcH).int)
    for ty in tyLo ..< tyHi:
      sampler.writeSampledRow(target, ty, sampler.line, 1)

proc finish*(sampler: var RowBoxSampler, target: Image) =
  ## Flushes the last vertical footprint; a truncated stream still leaves
  ## every row that fully arrived written.
  sampler.flushBoxRow(target)


proc newImage*(width, height: int): Image {.raises: [PixieError].} =
  ## Creates a new image with the parameter dimensions.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Image width and height must be > 0")

  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.storage = newSeq[ColorRGBX](width * height)
  result.pixels = cast[ptr UncheckedArray[ColorRGBX]](result.storage[0].addr)

proc newImage565*(width, height: int): Image {.raises: [PixieError].} =
  ## Creates a new 16-bit RGB (5/6/5) image, half the memory of `newImage`.
  ## Starts black (which is also what "transparent" packs to). See the notes
  ## on `Image` for what a 565 image can and cannot do.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Image width and height must be > 0")
  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.format = pfRgb565
  result.storage16 = newSeq[uint16](width * height)
  result.pixels16 = cast[ptr UncheckedArray[uint16]](result.storage16[0].addr)

proc newImageGray8*(width, height: int): Image {.raises: [PixieError].} =
  ## Creates a new 8-bit luma image, a quarter of the memory of `newImage`.
  ## Starts black. See the notes on `Image` for what it can and cannot do.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Image width and height must be > 0")
  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.format = pfGray8
  result.storage8 = newSeq[uint8](width * height)
  result.pixels8 = cast[ptr UncheckedArray[uint8]](result.storage8[0].addr)

proc newImageGray8Over*(
  width, height: int, buffer: pointer
): Image {.raises: [PixieError].} =
  ## `newImage565Over` for a luma buffer of `width * height` bytes.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Image width and height must be > 0")
  if buffer.isNil:
    raise newException(PixieError, "newImageGray8Over needs a buffer")
  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.format = pfGray8
  result.pixels8 = cast[ptr UncheckedArray[uint8]](buffer)

proc newImage565Over*(
  width, height: int, buffer: pointer
): Image {.raises: [PixieError].} =
  ## A 565 image over memory the caller owns — `width * height * 2` bytes at
  ## `buffer`, which must outlive the image and everything viewed from it.
  ##
  ## This is how a device keeps one canvas for its whole uptime: allocate the
  ## block once at boot, before anything can fragment the heap, and hand it
  ## to pixie every render instead of asking the allocator for a multi-MB
  ## contiguous run each time. The image is an owner as far as views are
  ## concerned (it is what `root` points at) but frees nothing.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Image width and height must be > 0")
  if buffer.isNil:
    raise newException(PixieError, "newImage565Over needs a buffer")
  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.format = pfRgb565
  result.pixels16 = cast[ptr UncheckedArray[uint16]](buffer)

proc newImageOver*(
  width, height: int, buffer: pointer
): Image {.raises: [PixieError].} =
  ## `newImage565Over` for an RGBX buffer of `width * height * 4` bytes.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Image width and height must be > 0")
  if buffer.isNil:
    raise newException(PixieError, "newImageOver needs a buffer")
  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.pixels = cast[ptr UncheckedArray[ColorRGBX]](buffer)

proc newImageLike*(image: Image, width, height: int): Image {.raises: [PixieError].} =
  ## A fresh image in the same storage format as `image`.
  case image.format
  of pfRgb565: newImage565(width, height)
  of pfGray8: newImageGray8(width, height)
  of pfRgbx: newImage(width, height)

proc newImageFrom*(
  width, height: int, data: sink seq[ColorRGBX]
): Image {.raises: [PixieError].} =
  ## Wraps an existing buffer as an image that owns it, without copying.
  ##
  ## Decoders build their pixels in a seq and hand it over; that move is worth
  ## keeping, so this exists rather than making them copy into a fresh image.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Image width and height must be > 0")
  if data.len < width * height:
    raise newException(PixieError, "Buffer is too small for " & $width & "x" & $height)
  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.storage = data
  result.pixels = cast[ptr UncheckedArray[ColorRGBX]](result.storage[0].addr)

proc toContiguousSeq*(image: Image): seq[ColorRGBX] {.raises: [].} =
  ## The image's pixels as a packed, owned buffer, rows back to back.
  ##
  ## For encoders and anything else that needs to hand a plain array to a
  ## library. It is a copy on purpose: `image.data` is a pointer now, so
  ## `var copy = image.data` aliases rather than copies, and a caller that then
  ## mutates `copy` would be scribbling on the image it was asked to read.
  result = newSeq[ColorRGBX](image.width * image.height)
  if image.width * image.height > 0:
    if image.format == pfRgb565:
      # A 565 image expands to opaque RGBX on the way out: this is the seam
      # every encoder reaches the pixels through, so a 565 canvas can still
      # be saved as a PNG for a preview without the encoders knowing.
      for y in 0 ..< image.height:
        let
          src = image.dataIndex(0, y)
          dst = y * image.width
        for x in 0 ..< image.width:
          result[dst + x] = rgb565ToRgbx(image.pixels16[src + x])
      return
    if image.format == pfGray8:
      for y in 0 ..< image.height:
        let
          src = image.dataIndex(0, y)
          dst = y * image.width
        for x in 0 ..< image.width:
          result[dst + x] = gray8ToRgbx(image.pixels8[src + x])
      return
    for y in 0 ..< image.height:
      copyMem(
        result[y * image.width].addr,
        image.data[image.dataIndex(0, y)].addr,
        image.width * 4
      )

proc toRgbxImage*(image: Image): Image {.raises: [].} =
  ## An RGBX copy of any image. For an RGBX image this is `copy`; for a 565
  ## image it is the expansion a filter or scaler that only knows RGBA needs.
  result = Image()
  result.width = image.width
  result.height = image.height
  result.stride = image.width
  result.origin = 0
  result.storage = newSeq[ColorRGBX](image.width * image.height)
  result.pixels = cast[ptr UncheckedArray[ColorRGBX]](result.storage[0].addr)
  if image.format == pfRgb565:
    for y in 0 ..< image.height:
      let
        src = image.dataIndex(0, y)
        dst = y * image.width
      for x in 0 ..< image.width:
        result.pixels[dst + x] = rgb565ToRgbx(image.pixels16[src + x])
  elif image.format == pfGray8:
    for y in 0 ..< image.height:
      let
        src = image.dataIndex(0, y)
        dst = y * image.width
      for x in 0 ..< image.width:
        result.pixels[dst + x] = gray8ToRgbx(image.pixels8[src + x])
  else:
    for y in 0 ..< image.height:
      copyMem(
        result.pixels[y * image.width].addr,
        image.pixels[image.dataIndex(0, y)].addr,
        image.width * 4
      )

proc toRgb565Image*(image: Image): Image {.raises: [].} =
  ## A 565 copy of any image — the quantising direction.
  result = Image()
  result.width = image.width
  result.height = image.height
  result.stride = image.width
  result.origin = 0
  result.format = pfRgb565
  result.storage16 = newSeq[uint16](image.width * image.height)
  result.pixels16 = cast[ptr UncheckedArray[uint16]](result.storage16[0].addr)
  for y in 0 ..< image.height:
    let
      src = image.dataIndex(0, y)
      dst = y * image.width
    if image.format == pfRgb565:
      copyMem(result.pixels16[dst].addr, image.pixels16[src].addr, image.width * 2)
    else:
      for x in 0 ..< image.width:
        result.pixels16[dst + x] = rgbxToRgb565(image.getPixel(src + x))

proc toGray8Image*(image: Image): Image {.raises: [].} =
  ## A luma copy of any image — the quantising direction, like toRgb565Image.
  result = Image()
  result.width = image.width
  result.height = image.height
  result.stride = image.width
  result.origin = 0
  result.format = pfGray8
  result.storage8 = newSeq[uint8](image.width * image.height)
  result.pixels8 = cast[ptr UncheckedArray[uint8]](result.storage8[0].addr)
  for y in 0 ..< image.height:
    let
      src = image.dataIndex(0, y)
      dst = y * image.width
    if image.format == pfGray8:
      copyMem(result.pixels8[dst].addr, image.pixels8[src].addr, image.width)
    else:
      for x in 0 ..< image.width:
        result.pixels8[dst + x] = rgbxToGray8(image.getPixel(src + x))

proc newImageFromUnchecked*(
  width, height: int, data: sink seq[ColorRGBX]
): Image {.raises: [].} =
  ## `newImageFrom` for callers whose dimensions are already validated and
  ## whose signature promises not to raise — the decoders, which checked the
  ## header long before they got here. Wrong arguments are a programming error,
  ## not a malformed file, so they assert rather than raise.
  doAssert width > 0 and height > 0
  doAssert data.len >= width * height
  result = Image()
  result.width = width
  result.height = height
  result.stride = width
  result.origin = 0
  result.storage = data
  result.pixels = cast[ptr UncheckedArray[ColorRGBX]](result.storage[0].addr)

proc view*(image: Image, x, y, w, h: int): Image {.raises: [PixieError].} =
  ## A window onto part of `image`, sharing its pixels. Writes through.
  ##
  ## Views of views are flattened onto the original owner, so nesting costs one
  ## object and no extra indirection however deep it goes.
  if w <= 0 or h <= 0:
    raise newException(PixieError, "View width and height must be > 0")
  if x < 0 or y < 0 or x + w > image.width or y + h > image.height:
    raise newException(PixieError, "View " & $w & "x" & $h & " at " & $x & "," &
      $y & " does not fit inside " & $image.width & "x" & $image.height)
  result = Image()
  result.width = w
  result.height = h
  result.stride = image.stride
  result.origin = image.dataIndex(x, y)
  result.format = image.format
  result.ditherStores = image.ditherStores
  result.root = if image.root.isNil: image else: image.root
  result.pixels = image.pixels
  result.pixels16 = image.pixels16
  result.pixels8 = image.pixels8

template isView*(image: Image): bool =
  ## True when the image borrows another's pixels rather than owning them.
  not image.root.isNil

proc copy*(image: Image): Image {.raises: [].} =
  ## Copies the image data into a new image, in the same storage format. A
  ## view copies out, so the result always owns its pixels.
  if image.format == pfRgb565:
    return image.toRgb565Image()
  if image.format == pfGray8:
    return image.toGray8Image()
  result = Image()
  result.width = image.width
  result.height = image.height
  result.stride = image.width
  result.origin = 0
  result.storage = newSeq[ColorRGBX](image.width * image.height)
  result.pixels = cast[ptr UncheckedArray[ColorRGBX]](result.storage[0].addr)
  for y in 0 ..< image.height:
    copyMem(
      result.pixels[result.dataIndex(0, y)].addr,
      image.pixels[image.dataIndex(0, y)].addr,
      image.width * 4
    )

proc mix*(a, b: ColorRGBX, t: float32): ColorRGBX {.inline, raises: [].} =
  ## Linearly interpolate between a and b using t.
  let x = round(t * 255).uint32
  result.r = ((a.r.uint32 * (255 - x) + b.r.uint32 * x + 127) div 255).uint8
  result.g = ((a.g.uint32 * (255 - x) + b.g.uint32 * x + 127) div 255).uint8
  result.b = ((a.b.uint32 * (255 - x) + b.b.uint32 * x + 127) div 255).uint8
  result.a = ((a.a.uint32 * (255 - x) + b.a.uint32 * x + 127) div 255).uint8

proc `*`*(color: ColorRGBX, opacity: float32): ColorRGBX {.raises: [].} =
  if opacity == 0:
    rgbx(0, 0, 0, 0)
  else:
    let
      x = round(opacity * 255).uint32
      r = ((color.r * x + 127) div 255).uint8
      g = ((color.g * x + 127) div 255).uint8
      b = ((color.b * x + 127) div 255).uint8
      a = ((color.a * x + 127) div 255).uint8
    rgbx(r, g, b, a)

proc `*`*(rgbx: ColorRGBX, opacity: uint8): ColorRGBX {.inline.} =
  if opacity == 0:
    discard
  elif opacity == 255:
    result = rgbx
  else:
    result = rgbx(
      ((rgbx.r.uint32 * opacity + 127) div 255).uint8,
      ((rgbx.g.uint32 * opacity + 127) div 255).uint8,
      ((rgbx.b.uint32 * opacity + 127) div 255).uint8,
      ((rgbx.a.uint32 * opacity + 127) div 255).uint8
    )

proc snapToPixels*(rect: Rect): Rect {.raises: [].} =
  let
    xMin = rect.x
    xMax = rect.x + rect.w
    yMin = rect.y
    yMax = rect.y + rect.h
  result.x = floor(xMin)
  result.w = ceil(xMax) - result.x
  result.y = floor(yMin)
  result.h = ceil(yMax) - result.y
