import pixie
import pixie/fileformats/svg
import pixie/fileformats/jpeg as pixie_jpeg
import base64
import json
import math
import os
import options
import sequtils
import strutils
import strformat
import uri
import std/xmltree
import std/strtabs

import frameos/spool
import frameos/channels
import frameos/utils/http_client
import frameos/utils/memory
import frameos/utils/font
# pixie.nim imports the fileformat modules without re-exporting them, so every
# format the streaming decode paths reach for has to be imported by name. Miss
# one and its `when compiles(...)` branch below quietly evaluates false — the
# format silently loses its file-backed decoder.
#
# png is unconditional: pngIsProvablyOpaque needs pngSignature, and it is
# compiled (and unit-tested) everywhere even though only embedded targets act
# on its answer.
import pixie/fileformats/png
when defined(frameosEmbedded):
  import pixie/blends
  import pixie/fileformats/bmp
  import pixie/fileformats/jpeg
  import pixie/fileformats/ppm
  import pixie/fileformats/webp
  import pixie/inflatestream
when not defined(frameosEmbedded) and not defined(frameosWasm):
  # No child processes on FreeRTOS or WebAssembly: the exiftool fallback is
  # compiled out and pixie does all decoding.
  import frameos/utils/process

const MaxImageDownloadBytes = 15 * 1024 * 1024
const MaxExifOutputBytes = 1024 * 1024
const ExifToolTimeoutMs = 10_000
const DisplayDecodeMaxEdge* = 2048
const DisplayDecodeMaxPixels* = DisplayDecodeMaxEdge * DisplayDecodeMaxEdge
const EmbeddedMaxRemoteSourceWidth = 800
when defined(frameosEmbedded):
  const EmbeddedSmallDecodeCopyBytes = 512 * 1024
  const EmbeddedMaxDirectDecodeCopyBytes = 2 * 1024 * 1024
  const EmbeddedMaxDirectPngBytes = 6 * 1024 * 1024
  const EmbeddedMaxDirectRgbaBytes = 5 * 1024 * 1024

proc scaleAndDrawImage*(targetImage: Image, srcImage: Image, scalingMode: string, offsetX: int = 0,
    offsetY: int = 0, blendMode: BlendMode = OverwriteBlend) {.raises: [PixieError].}

proc decodeOutputMaxPixels*(): int =
  ## Largest decoded-output pixel count the current memory headroom allows;
  ## 0 = unknown/unlimited. The output takes 4 bytes per pixel and shares
  ## the headroom with decode intermediates and the canvas.
  let available = availableRenderBytes()
  if available <= 0:
    return 0
  max(65_536, (available div 3) div 4)

proc displayDecodeDimensions*(sourceWidth, sourceHeight: int,
    maxEdge = DisplayDecodeMaxEdge,
    maxPixels = DisplayDecodeMaxPixels): tuple[width: int, height: int] =
  if sourceWidth <= 0 or sourceHeight <= 0:
    raise newException(PixieError, "Invalid image dimensions")

  var effectiveMaxPixels = maxPixels
  let budgetPixels = decodeOutputMaxPixels()
  if budgetPixels > 0 and (effectiveMaxPixels <= 0 or budgetPixels < effectiveMaxPixels):
    effectiveMaxPixels = budgetPixels

  var scaleRatio = 1.0
  if maxEdge > 0:
    scaleRatio = min(scaleRatio, maxEdge.float / max(sourceWidth, sourceHeight).float)
  if effectiveMaxPixels > 0:
    let sourcePixels = sourceWidth.int64 * sourceHeight.int64
    if sourcePixels > effectiveMaxPixels.int64:
      scaleRatio = min(scaleRatio, sqrt(effectiveMaxPixels.float / sourcePixels.float))

  if scaleRatio >= 1.0:
    return (sourceWidth, sourceHeight)

  (
    max(1, floor(sourceWidth.float * scaleRatio).int),
    max(1, floor(sourceHeight.float * scaleRatio).int)
  )

proc displayDecodeDimensions*(dimensions: ImageDimensions,
    maxEdge = DisplayDecodeMaxEdge,
    maxPixels = DisplayDecodeMaxPixels): tuple[width: int, height: int] =
  displayDecodeDimensions(dimensions.width, dimensions.height, maxEdge, maxPixels)

proc scaledFitPlacement*(fit: ScaledDecodeFit): string =
  ## The scaleAndDrawImage placement equivalent to a decode-time fit.
  case fit
  of fitCover: "cover"
  of fitContain: "contain"
  of fitStretch: "stretch"

proc boundedRequestedDimensions*(width, height: int): tuple[width: int, height: int] =
  ## A scene-requested raster size (an SVG's `width`/`height`, a plain
  ## canvas) held to the same ceiling as a decoded image: DisplayDecodeMaxEdge
  ## and the live decode budget. A JS app asking for a 20000x20000 canvas
  ## used to be an allocation failure — on the ESP32 an abort, not an error.
  displayDecodeDimensions(max(1, width), max(1, height))

proc decodeSvgWithFallback*(svg: string, width: int, height: int): Option[Image] =
  ## Rasterises an SVG into a new image of the given size; none when pixie
  ## cannot parse it. pixie fills gradient paints through a coverage mask and
  ## a paint image, sized to the decode budget in row strips (paintStripRows),
  ## so the budget is refreshed here: the render tick's value predates the JS
  ## runtimes and data this SVG was made from.
  refreshDecodeBudget()
  try:
    return some(newImage(parseSvg(svg, width, height)))
  except CatchableError:
    return none(Image)

proc svgDecodeError*(svg: string, width: int, height: int): string =
  ## Why `decodeSvgWithFallback` produced nothing — the parser's own message,
  ## so a JS app's broken markup (an unescaped '&', an unsupported tag) is
  ## reported instead of surfacing as an unexplained "No image provided".
  try:
    discard parseSvg(svg, width, height)
    ""
  except CatchableError as e:
    e.msg

proc renderSvgIntoTarget*(svg: string, target: Image): bool =
  ## Rasterizes an SVG straight into a buffer the caller already owns, rather
  ## than allocating one and blending it away afterwards. Returns false when
  ## this path does not apply, and the caller falls back to
  ## `decodeSvgWithFallback`.
  ##
  ## Compositing, not overwriting: the target may already have content, and a
  ## semi-transparent first path must blend with it rather than replace it —
  ## `renderInto` in the pixie fork is the half of that contract living there.
  ##
  ## The output already exists, so the whole headroom may hold the paint
  ## strips (refreshDecodeBudgetInto). This is the path the 13.3" Weather
  ## scene OOM-aborted on: a 1200x960 cell's gradient background used to cost
  ## a 9.2 MB mask+fill pair here, with no band fallback because an OOM abort
  ## is not a CatchableError.
  if target.isNil or target.width <= 0 or target.height <= 0:
    return false
  refreshDecodeBudgetInto()
  try:
    parseSvg(svg, target.width, target.height).renderInto(target)
    true
  except CatchableError:
    false

proc decodeImageWithFallback*(data: string): Image =
  decodeImage(data)

proc looksLikeSvg(data: string): bool =
  data.len > 5 and (data.startsWith("<?xml") or data.startsWith("<svg"))

proc decodeImageWithDisplayBounds*(data: var string,
    maxEdge = DisplayDecodeMaxEdge,
    maxPixels = DisplayDecodeMaxPixels): Image =
  refreshDecodeBudget()
  # SVG has no compressed-dimensions probe, but its DECLARED size is right
  # there in the document, and rasterizing at that size is an unbounded
  # allocation: a 1KB placeholder declaring 1024x1024 is a 4MB image, which on
  # a fragmented ESP32 heap was an unrecoverable OOM that aborted the render.
  # Parse for the declared size and bound it exactly like a raster decode —
  # it is being rasterized for this display either way.
  if looksLikeSvg(data):
    try:
      let parsed = parseSvg(data)
      if parsed.width > 0 and parsed.height > 0:
        let bounded = displayDecodeDimensions(
          ImageDimensions(width: parsed.width, height: parsed.height),
          maxEdge, maxPixels)
        let image = decodeSvgWithFallback(data, bounded.width, bounded.height)
        if image.isSome:
          data = ""
          return image.get()
    except CatchableError:
      discard # not actually decodable as SVG; the generic decoder gets to say so
  # Formats without a dimension prober decode unscaled below.
  var dimensions = ImageDimensions(width: 0, height: 0)
  try:
    dimensions = decodeImageDimensions(data)
  except PixieError:
    discard
  if dimensions.width > 0 and dimensions.height > 0:
    let target = displayDecodeDimensions(dimensions, maxEdge, maxPixels)
    if target.width != dimensions.width or target.height != dimensions.height:
      return decodeImageScaled(data, target.width, target.height)

  result = decodeImageWithFallback(data)
  data = ""

when defined(frameosEmbedded):
  proc copyImageBuffer(data: pointer, len: int): string =
    result = newString(len)
    if len > 0:
      copyMem(addr result[0], data, len)

  proc embeddedImageFormat(data: pointer, len: int): string =
    if data == nil or len <= 0:
      return "empty"
    if len > 8 and equalMem(data, pngSignature[0].unsafeAddr, 8):
      return "PNG"
    let bytes = cast[ptr UncheckedArray[uint8]](data)
    if len > 2 and bytes[0] == 0xFF'u8 and bytes[1] == 0xD8'u8:
      return "JPEG"
    if len > 2 and bytes[0] == 'B'.uint8 and bytes[1] == 'M'.uint8:
      return "BMP"
    if len > 2 and bytes[0] == 'P'.uint8 and bytes[1] == '6'.uint8:
      return "PPM"
    if len > 6 and bytes[0] == 'G'.uint8 and bytes[1] == 'I'.uint8 and bytes[2] == 'F'.uint8:
      return "GIF"
    if len > 12 and bytes[0] == 'R'.uint8 and bytes[1] == 'I'.uint8 and
        bytes[2] == 'F'.uint8 and bytes[3] == 'F'.uint8:
      return "WEBP"
    "unknown"

  proc guardEmbeddedDirectDecode(data: pointer, len: int, format: string) =
    let dimensions = decodeImageDimensions(data, len)
    let rgbaBytes = dimensions.width.int64 * dimensions.height.int64 * 4'i64
    if rgbaBytes > EmbeddedMaxDirectRgbaBytes:
      raise newException(PixieError,
        &"Direct on-device {format} decode would allocate {rgbaBytes div 1024}K RGBA for {dimensions.width}x{dimensions.height}; using low-memory fallback")

  proc decodeImageWithFallback*(data: pointer, len: int): Image =
    if data == nil or len <= 0:
      raise newException(PixieError, "Unsupported image file format: empty response")
    let format = embeddedImageFormat(data, len)
    if len > 8 and equalMem(data, pngSignature[0].unsafeAddr, 8):
      if len > EmbeddedMaxDirectPngBytes:
        raise newException(PixieError,
          &"Direct on-device PNG decode over {EmbeddedMaxDirectPngBytes div 1024}K needs the low-memory media proxy; fetched {len div 1024}K")
      guardEmbeddedDirectDecode(data, len, format)
      GC_fullCollect()
      return decodePng(data, len).convertToImage()
    if len > 14:
      let bytes = cast[ptr UncheckedArray[uint8]](data)
      if bytes[0] == 'B'.uint8 and bytes[1] == 'M'.uint8:
        guardEmbeddedDirectDecode(data, len, format)
        GC_fullCollect()
        return decodeDib(bytes[14].unsafeAddr, len - 14)
    if format in ["JPEG", "GIF"]:
      guardEmbeddedDirectDecode(data, len, format)
      if len <= EmbeddedMaxDirectDecodeCopyBytes:
        return decodeImageWithFallback(copyImageBuffer(data, len))
      raise newException(PixieError,
        &"Direct on-device {format} decode needs a {len div 1024}K source copy; using low-memory fallback")
    if format == "WEBP":
      raise newException(PixieError,
        &"Direct on-device decode for {format} images uses the low-memory media proxy")
    if len <= EmbeddedSmallDecodeCopyBytes:
      return decodeImageWithFallback(copyImageBuffer(data, len))
    raise newException(PixieError,
      &"Direct on-device decode for {format} images over {EmbeddedSmallDecodeCopyBytes div 1024}K needs a low-memory decoder; fetched {len div 1024}K")

  proc decodeImageWithFallback*(data: pointer, len: int, target: Image,
      fit = fitCover): Image =
    if data == nil or len <= 0:
      raise newException(PixieError, "Unsupported image file format: empty response")
    let format = embeddedImageFormat(data, len)
    if format == "JPEG" and not target.isNil and target.width > 0 and target.height > 0:
      GC_fullCollect()
      when compiles(decodeJpegScaledInto(data, len, target, fit)):
        decodeJpegScaledInto(data, len, target, fit)
        return target
      else:
        if len <= EmbeddedMaxDirectDecodeCopyBytes:
          target.scaleAndDrawImage(decodeImageWithFallback(copyImageBuffer(data, len)), scaledFitPlacement(fit))
          return target
        raise newException(PixieError,
          &"Direct on-device JPEG scaling is not available in this Pixie build; fetched {len div 1024}K")
    if format == "PNG" and not target.isNil and target.width > 0 and target.height > 0:
      if len > EmbeddedMaxDirectPngBytes:
        raise newException(PixieError,
          &"Direct on-device PNG decode over {EmbeddedMaxDirectPngBytes div 1024}K needs the low-memory media proxy; fetched {len div 1024}K")
      GC_fullCollect()
      when compiles(decodePngScaledInto(data, len, target, fit)):
        # Streamed scanline decode: pixie's own decode budget guards the
        # peak (a row plus fixed overhead), so the full-RGBA guard would
        # only reject images this path never allocates whole.
        decodePngScaledInto(data, len, target, fit)
        return target
      else:
        guardEmbeddedDirectDecode(data, len, format)
        target.scaleAndDrawImage(decodeImageWithFallback(data, len), scaledFitPlacement(fit))
        return target
    decodeImageWithFallback(data, len)

  proc decodeImageWithFallback*(data: var string, target: Image,
      fit = fitCover): Image =
    if data.len <= 0:
      raise newException(PixieError, "Unsupported image file format: empty response")
    let format = embeddedImageFormat(data.cstring, data.len)
    if format == "JPEG" and not target.isNil and target.width > 0 and target.height > 0:
      GC_fullCollect()
      when compiles(decodeJpegScaledInto(data, target, fit)):
        decodeJpegScaledInto(data, target, fit)
        return target
      else:
        if data.len <= EmbeddedMaxDirectDecodeCopyBytes:
          target.scaleAndDrawImage(decodeImageWithFallback(data), scaledFitPlacement(fit))
          return target
        raise newException(PixieError,
          &"Direct on-device JPEG scaling is not available in this Pixie build; fetched {data.len div 1024}K")
    if format == "PNG" and not target.isNil and target.width > 0 and target.height > 0:
      if data.len > EmbeddedMaxDirectPngBytes:
        raise newException(PixieError,
          &"Direct on-device PNG decode over {EmbeddedMaxDirectPngBytes div 1024}K needs the low-memory media proxy; fetched {data.len div 1024}K")
      GC_fullCollect()
      when compiles(decodePngScaledInto(data, target, fit)):
        # Streamed scanline decode; see the pointer variant above
        decodePngScaledInto(data, target, fit)
        return target
      else:
        guardEmbeddedDirectDecode(data.cstring, data.len, format)
        target.scaleAndDrawImage(decodeImageWithFallback(data), scaledFitPlacement(fit))
        return target
    decodeImageWithFallback(data)

  proc httpErrorDetail(response: BoundedHttpBufferResponse): string =
    if response.chunks.len == 0 or response.bodyLen <= 0:
      return ""
    let first = response.chunks[0]
    let copyLen = min(first.len, 512)
    var snippet = newString(copyLen)
    if copyLen > 0:
      copyMem(addr snippet[0], first.data, copyLen)
    if response.bodyLen > copyLen:
      snippet.add("...")
    ": " & snippet

when not defined(frameosEmbedded):
  proc decodeImageWithFallback*(data: var string, target: Image,
      fit = fitCover): Image =
    if not target.isNil and target.width > 0 and target.height > 0:
      return decodeImageScaledInto(data, target, fit)
    decodeImageWithFallback(data)

proc readImageWithFallback*(path: string): Image =
  readImage(path)

const ImageHeaderProbeBytes = 256 * 1024

proc probeImageFileHeader(path: string): string =
  ## Reads just enough of a file to determine its format and dimensions.
  var file: File
  if not file.open(path):
    raise newException(PixieError, "Cannot open image file: " & path)
  defer: file.close()
  let probeLen = min(getFileSize(path), ImageHeaderProbeBytes.int64).int
  result = newString(probeLen)
  if probeLen > 0:
    let got = file.readBuffer(addr result[0], probeLen)
    result.setLen(max(0, got))

proc isJpegHeader(data: string): bool =
  data.len > 2 and data[0] == '\xFF' and data[1] == '\xD8'

proc isPngHeader(data: string): bool =
  data.len > 8 and equalMem(data[0].unsafeAddr, pngSignature[0].unsafeAddr, 8)

proc pngIsProvablyOpaque*(header: string): bool =
  ## True when a PNG cannot carry transparency, which is what makes it safe to
  ## stream straight over a canvas: writing its pixels is then equivalent to
  ## compositing them, exactly as for a JPEG.
  ##
  ## Colour types 0 (greyscale) and 2 (truecolour) have no alpha channel. A
  ## tRNS chunk can still declare specific values transparent, so anything with
  ## one is disqualified — as is a file whose header did not fit the probe, on
  ## the principle that "not proven opaque" must read as "may have alpha".
  if not isPngHeader(header) or header.len < 26:
    return false
  let colorType = header[25].uint8
  if colorType != 0'u8 and colorType != 2'u8:
    return false
  # Walk the chunk list looking for tRNS. Reaching IDAT first proves there is
  # none: tRNS is required to precede the image data.
  var offset = 8
  while offset + 8 <= header.len:
    var length = 0'u32
    for i in 0 .. 3:
      length = (length shl 8) or header[offset + i].uint8.uint32
    let chunkType = header[offset + 4 ..< min(offset + 8, header.len)]
    if chunkType == "tRNS":
      return false
    if chunkType == "IDAT":
      return true
    if length > uint32(int32.high):
      return false
    offset += 12 + length.int # length + type + data + crc
  # Ran out of probed header before the image data started.
  false

proc isBmpHeader(data: string): bool =
  data.len > 2 and data[0] == 'B' and data[1] == 'M'

proc isPpmHeader(data: string): bool =
  ## P6 is the binary variant; P3 is ASCII and has no streaming decoder.
  data.len > 2 and data[0] == 'P' and data[1] == '6'

proc bmpIsProvablyOpaque*(header: string): bool =
  ## Same question as `pngIsProvablyOpaque`, for BMP: can this file carry
  ## transparency? If it cannot, streaming its pixels straight over a canvas is
  ## equivalent to compositing them.
  ##
  ## Bit depths up to 24 have no alpha channel at all. 32-bit BMPs usually
  ## carry an ignored padding byte rather than real alpha, but BI_ALPHABITFIELDS
  ## and the V4/V5 headers can declare a genuine alpha mask — and "usually" is
  ## not a basis for overwriting a canvas, so 32-bit is simply not proven.
  if not isBmpHeader(header) or header.len < 34:
    return false
  var bitCount = 0
  for i in 0 .. 1: # DIB header offset 14 + 14 = bit count, little endian
    bitCount = bitCount or (header[28 + i].uint8.int shl (8 * i))
  var compression = 0
  for i in 0 .. 3:
    compression = compression or (header[30 + i].uint8.int shl (8 * i))
  # BI_RGB (0) and BI_RLE8/4 (1/2) carry no alpha mask; BI_BITFIELDS (3) and
  # BI_ALPHABITFIELDS (6) can.
  if compression != 0 and compression != 1 and compression != 2:
    return false
  bitCount in [1, 4, 8, 16, 24]

proc fileJpegSource(file: File): JpegSourceProc =
  result = proc(dst: pointer, maxBytes: int): int =
    try:
      file.readBuffer(dst, maxBytes)
    except IOError, OSError:
      0

proc ensureFileReadBudget(path: string, fileSize: int64) =
  ## Refuses to buffer a whole compressed file when doing so would consume
  ## most of the remaining render memory.
  let available = availableRenderBytes()
  if available > 0 and fileSize > available.int64 div 2:
    raise newException(PixieError,
      "Image file " & path & " is " & $(fileSize div 1024) &
      "K; only " & $(available div 1024) &
      "K of render memory is available")

proc readImageWithDisplayBounds*(path: string,
    maxEdge = DisplayDecodeMaxEdge,
    maxPixels = DisplayDecodeMaxPixels): Image =
  refreshDecodeBudget()
  let fileSize = getFileSize(path)

  # JPEGs stream from disk through a small window, so neither the compressed
  # file nor full-size intermediates ever need to fit in memory.
  var header = probeImageFileHeader(path)
  if isJpegHeader(header):
    var dimensions: ImageDimensions
    var probed = true
    try:
      dimensions = decodeImageDimensions(header)
    except CatchableError:
      # Oversized metadata segments (rare) defeat the probe; fall through to
      # a buffered read below.
      probed = false
    if probed:
      header = ""
      let target = displayDecodeDimensions(dimensions, maxEdge, maxPixels)
      var file: File
      if not file.open(path):
        raise newException(PixieError, "Cannot open image file: " & path)
      try:
        return decodeJpegStreamScaled(
          fileJpegSource(file), fileSize.int, target.width, target.height)
      except PixieError:
        # Progressive JPEGs cannot stream; retry buffered below (bounded by
        # the file-read budget and pixie's decode budget).
        discard
      finally:
        file.close()

  header = ""
  ensureFileReadBudget(path, fileSize)
  var data = readFile(path)
  decodeImageWithDisplayBounds(data, maxEdge, maxPixels)

proc scalingModeToFit(scalingMode: string): Option[ScaledDecodeFit] =
  case scalingMode
  of "cover": some(fitCover)
  of "contain": some(fitContain)
  of "stretch": some(fitStretch)
  else: none(ScaledDecodeFit)

proc decodeIntoTargetWithDegrade*(target: Image, fit: ScaledDecodeFit,
    decode: proc(dst: Image)): Image =
  ## Runs an into-target decode; when the decoder's plan check refuses for
  ## lack of memory ("over the … memory budget"), retries the same decode at
  ## reduced resolution into a temporary image and upscales the result onto
  ## the target. A blurrier render always beats an error frame — the budget
  ## refusal is a planning answer, so degrading the plan is the fix, not
  ## surfacing the message. Non-budget errors pass through untouched.
  try:
    decode(target)
    return target
  except PixieError as refusal:
    if not refusal.msg.contains("memory budget"):
      raise
    let refusalMsg = refusal.msg
    # Halving the target quarters the plan's channel buffers; two rungs cover
    # everything short of a heap that cannot hold even a quarter-res frame.
    for divisor in [2, 4]:
      let tempWidth = max(1, target.width div divisor)
      let tempHeight = max(1, target.height div divisor)
      when defined(frameosEmbedded):
        # An allocation the heap cannot satisfy is not a catchable failure on
        # embedded — the runtime longjmp-aborts the whole render and leaks
        # everything on the stack. Ask first: seen on an 8 MB board whose
        # largest free block was 1.7 MB when the half-res rung wanted 1.9 MB.
        let contiguous = availableRenderBytes()
        if contiguous > 0 and tempWidth * tempHeight * 4 > contiguous:
          continue
      var temp: Image
      try:
        temp = newImage(tempWidth, tempHeight)
      except CatchableError:
        continue
      # The temp allocation itself changed the heap; re-plan against it.
      refreshDecodeBudgetInto()
      try:
        decode(temp)
        # temp shares the target's aspect and the fit was applied during the
        # decode, so the upscale is a pure stretch.
        target.scaleAndDrawImage(temp, "stretch")
        refreshDecodeBudgetInto()
        # A degraded render is silent on the panel — it only looks soft — so
        # say so in the log: a frame that "used to be sharp" is otherwise
        # undiagnosable from the cloud (seen on a 13.3" whose heap had been
        # leaked by an OOM abort: every render quietly fell to this rung).
        log(%*{
          "event": "render:degraded",
          "divisor": divisor,
          "width": temp.width,
          "height": temp.height,
          "targetWidth": target.width,
          "targetHeight": target.height,
          "headroomBytes": availableRenderHeadroomBytes(),
          "reason": refusalMsg,
        })
        return target
      except PixieError as retryRefusal:
        if not retryRefusal.msg.contains("memory budget"):
          raise
        continue
    raise newException(PixieError, refusalMsg)

proc streamDecodeInto*(format: string, source: JpegSourceProc, totalLen: int,
    target: Image, fit: ScaledDecodeFit, rewind: proc(),
    collectBeforeDecode = false): bool =
  ## The format dispatch shared by every sequential-source decode into a
  ## target: an SD-card file (readImageIntoTarget), a download spilled to
  ## storage (decodeSpilledImageInto) and the HTTP socket itself
  ## (downloadImageStreamingInto). `format` is the sniffed name — "JPEG",
  ## "PNG", "BMP", "PPM" or "WEBP". JPEG, PNG and WebP run under the degrade
  ## ladder, with `rewind` putting the source back at byte 0 before every
  ## rung; BMP and PPM decode once. `collectBeforeDecode` runs a GC cycle
  ## right before each decode so the plan check sees the heap it will
  ## allocate from (the download paths want that; the SD path never did).
  ##
  ## Returns false when the format has no streaming decoder in this build,
  ## or when a JPEG's length is unknown (its reader needs the exact count):
  ## the caller picks its own fallback. Decoder errors propagate as
  ## PixieError untouched, and each caller applies its own policy — the SD
  ## and socket paths retry buffered, the spilled path lets them surface.
  if target.isNil or target.width <= 0 or target.height <= 0:
    return false
  proc restart() =
    rewind()
    if collectBeforeDecode:
      GC_fullCollect()
  case format
  of "JPEG":
    if totalLen <= 0:
      return false
    when compiles(decodeJpegStreamScaledInto(source, totalLen, target, fit)):
      # Progressive JPEGs raise here (non-budget); budget refusals degrade
      # to a reduced-resolution decode inside the ladder.
      discard decodeIntoTargetWithDegrade(target, fit, proc(dst: Image) =
        restart()
        decodeJpegStreamScaledInto(source, totalLen, dst, fit))
      return true
  of "PNG":
    when compiles(decodePngStreamScaledInto(source, totalLen, target, fit)):
      # Row-streamed: the compressed body is read incrementally and never
      # held whole, so this needs a fixed inflate window plus a row, not a
      # block the size of the file. Interlaced and 16-bit PNGs raise here.
      discard decodeIntoTargetWithDegrade(target, fit, proc(dst: Image) =
        restart()
        decodePngStreamScaledInto(source, totalLen, dst, fit))
      return true
  of "BMP":
    when compiles(decodeBmpStreamScaledInto(source, totalLen, target, fit)):
      # Uncompressed fixed-stride rows: one source row in RAM at a time, and
      # rows outside the fitted rect are skipped without being converted.
      # RLE bitmaps raise.
      restart()
      decodeBmpStreamScaledInto(source, totalLen, target, fit)
      return true
  of "PPM":
    when compiles(decodePpmStreamScaledInto(source, totalLen, target, fit)):
      # P6 only — ASCII P3 raises.
      restart()
      decodePpmStreamScaledInto(source, totalLen, target, fit)
      return true
  of "WEBP":
    when compiles(decodeWebpStreamScaledInto(source, totalLen, target, fit)):
      # A WebP bitstream cannot be windowed (VP8 partitions interleave
      # macroblock rows; VP8L's LZ77 window is the whole image), so pixie
      # holds the compressed body — budget-checked, refusing catchably —
      # while the full-size RGBA intermediate still never exists.
      discard decodeIntoTargetWithDegrade(target, fit, proc(dst: Image) =
        restart()
        decodeWebpStreamScaledInto(source, totalLen, dst, fit))
      return true
  else:
    discard
  false

proc readImageIntoTarget*(path: string, target: Image, scalingMode: string): bool =
  ## Decodes an image file directly into an existing target image (usually
  ## the render canvas) with aspect-correct fit, keeping peak memory at the
  ## decode intermediates only. Returns false when this fast path does not
  ## apply (unsupported scaling mode or format); raises catchable errors for
  ## unreadable or over-budget files.
  if target.isNil or target.width <= 0 or target.height <= 0:
    return false
  let fitOption = scalingModeToFit(scalingMode)
  if fitOption.isNone:
    return false
  let fit = fitOption.get()

  # Into-target decode: the output is the pre-allocated canvas, so the
  # decode plan may use the whole headroom (see refreshDecodeBudgetInto).
  refreshDecodeBudgetInto()
  let fileSize = getFileSize(path)
  var header = probeImageFileHeader(path)

  # Both streaming decoders write decoded pixels straight over the canvas, so
  # they are only equivalent to compositing when the source cannot be
  # transparent. A JPEG never is, and a PNG whose header proves it has no alpha
  # is not either.
  #
  # PNG streaming is embedded-only, and deliberately so. What it buys is not
  # speed but the absence of one big contiguous allocation: the buffered path
  # needs the whole compressed body in a single block, which is what fails on a
  # fragmented ESP32 heap ("Image file … is 1450K; only 1024K of render memory
  # is available") while several MB sit free in smaller pieces. A host never
  # hits that. What it COSTS is sampling: the streaming decoder picks nearest
  # source pixels while scaleAndDrawImage asks pixie for a smooth scale. On
  # embedded that is no change at all — scaleAndDrawImage already routes
  # through drawScaledNearest there — but on a host it would visibly degrade
  # every scaled PNG, and diverge interpreted scenes (which get a decode
  # target) from compiled ones (which do not).
  let jpeg = isJpegHeader(header)
  var streamablePng = false
  var streamableBmp = false
  var streamablePpm = false
  when defined(frameosEmbedded):
    streamablePng = not jpeg and pngIsProvablyOpaque(header)
    # BMP and PPM already stream in `decodeSpilledImageInto` — a download too
    # big for PSRAM has streamed from storage since Aug 2026. A file on the SD
    # card is the same problem with the same answer, and until now it did not
    # get it: an 800x480 24-bit BMP is 1.1MB of file for a 1.5MB image, and
    # `ensureFileReadBudget` refused to buffer it ("only 1952K of render memory
    # is available") on a frame that could render it perfectly well a row at a
    # time. Every BMP on the Waveshare demo card is one of these.
    streamableBmp = not jpeg and bmpIsProvablyOpaque(header)
    # PPM P6 has no alpha channel at all, so there is nothing to prove.
    streamablePpm = not jpeg and isPpmHeader(header)
  let format =
    if jpeg: "JPEG"
    elif streamablePng: "PNG"
    elif streamableBmp: "BMP"
    elif streamablePpm: "PPM"
    else: ""
  if format.len == 0:
    return false
  header = ""

  var file: File
  if not file.open(path):
    raise newException(PixieError, "Cannot open image file: " & path)
  try:
    # A budget refusal degrades to a reduced-resolution decode inside the
    # ladder; only non-budget errors reach the buffered retry below.
    if streamDecodeInto(format, fileJpegSource(file), fileSize.int, target, fit,
        proc() = file.setFilePos(0)):
      return true
  except PixieError:
    # Progressive JPEGs, interlaced/16-bit PNGs and RLE BMPs cannot stream;
    # retry buffered below.
    discard
  finally:
    file.close()

  ensureFileReadBudget(path, fileSize)
  var data = readFile(path)
  discard decodeImageScaledInto(data, target, fit)
  true

proc decodeDataUrl*(dataUrl: string): Image =
  if not dataUrl.startsWith("data:"):
    raise newException(ValueError, "Invalid data URL.")
  let commaIndex = dataUrl.find(',')
  if commaIndex == -1:
    raise newException(ValueError, "Invalid data URL.")
  let header = dataUrl[5 ..< commaIndex]
  let dataBody = dataUrl[commaIndex + 1 .. ^1]
  let headerParts = if header.len > 0: header.split(';') else: @[""]
  let isBase64 = headerParts.anyIt(it == "base64")
  var decodedData =
    if isBase64:
      dataBody.decode
    else:
      decodeUrl(dataBody)
  # SVG has no dimensions probe; everything else decodes bounded.
  if looksLikeSvg(decodedData):
    return decodeImageWithFallback(decodedData)
  return decodeImageWithDisplayBounds(decodedData)

proc decodeDataUrlInto*(dataUrl: string, target: Image, fit = fitCover): Image =
  if not dataUrl.startsWith("data:"):
    raise newException(ValueError, "Invalid data URL.")
  let commaIndex = dataUrl.find(',')
  if commaIndex == -1:
    raise newException(ValueError, "Invalid data URL.")
  let header = dataUrl[5 ..< commaIndex]
  var dataBody = dataUrl[commaIndex + 1 .. ^1]
  let headerParts = if header.len > 0: header.split(';') else: @[""]
  let isBase64 = headerParts.anyIt(it == "base64")
  var decodedData =
    if isBase64:
      dataBody.decode
    else:
      decodeUrl(dataBody)
  if not target.isNil and decodedData.len > 0:
    return decodeImageWithFallback(decodedData, target, fit)
  return decodeImageWithFallback(decodedData)

proc upsertQueryParam(query, key, value: string): string =
  var parts = if query.len > 0: query.split('&') else: @[]
  var updated = false
  for part in parts.mitems:
    let equals = part.find('=')
    let partKey = if equals >= 0: part[0 ..< equals] else: part
    if partKey == key:
      part = encodeUrl(key) & "=" & encodeUrl(value)
      updated = true
  if not updated:
    parts.add(encodeUrl(key) & "=" & encodeUrl(value))
  parts.join("&")

proc hasQueryParam(query, key: string): bool =
  for part in query.split('&'):
    let equals = part.find('=')
    let partKey = if equals >= 0: part[0 ..< equals] else: part
    if partKey == key:
      return true
  false

proc progressiveJpegBufferedDecodeBytes*(width, height: int):
    tuple[total, largest: int64] =
  ## What decoding a progressive JPEG of this size into the canvas costs on
  ## the buffered path, as pixie plans it (decodeSOF in the fork's jpeg.nim):
  ## a progressive scan cannot stream its blocks, so every component's DCT
  ## coefficients stay resident — 64 int16 per 8x8 block, 3 bytes per pixel
  ## with the 4:2:0 chroma imgix emits; the target-sized channel planes come
  ## on top (1.5 bytes per pixel, the source being no larger than the
  ## canvas here); and the compressed body itself is buffered first — half a
  ## byte per pixel is a generous bound for quality-80 output. The largest
  ## single allocation is the luma coefficient plane.
  let pixels = width.int64 * height.int64
  let lumaCoefficients = pixels * 2
  let coefficients = lumaCoefficients + pixels # two 4:2:0 chroma planes
  let channels = pixels + pixels div 2
  let body = pixels div 2
  (coefficients + channels + body, lumaCoefficients)

proc progressiveJpegFitsBufferedDecode*(width, height: int): bool =
  ## Whether this board, right now, can decode a progressive JPEG of this
  ## size the buffered way — the same two questions the decoder's plan
  ## check asks (refreshDecodeBudgetInto: the whole headroom for the plan,
  ## the largest free block for its biggest buffer). Unknown memory counts
  ## as plenty, which is what every host answers.
  let plan = progressiveJpegBufferedDecodeBytes(width, height)
  let headroom = availableRenderHeadroomBytes()
  if headroom > 0 and plan.total > headroom.int64:
    return false
  let contiguous = availableRenderBytes()
  if contiguous > 0 and plan.largest > contiguous.int64:
    return false
  true

# RULE: NEVER route frame image downloads through a backend/image proxy, and
# don't reach for host-side resize params as the fix either. Frames render
# independently, from the original source. When a source serves images too
# large for on-device decode, THE fix is better streaming on-device
# (incremental inflate + row-by-row unfilter/scale into the target, so a
# multi-MB PNG needs its compressed body plus a few rows — not a full-size
# RGBA buffer). Proxies are for in-browser previews only. The unsplash
# rewrite below predates this rule and stays as-is.
proc embeddedSizedRemoteImageUrl*(url: string, target: Image): string =
  if target.isNil or target.width <= 0 or target.height <= 0:
    return url
  var parsed: Uri
  try:
    parsed = parseUri(url)
  except CatchableError:
    return url
  if parsed.scheme notin ["http", "https"]:
    return url

  case parsed.hostname.toLowerAscii()
  of "images.unsplash.com":
    let requestedWidth = min(target.width, EmbeddedMaxRemoteSourceWidth)
    let requestedHeight = min(target.height, EmbeddedMaxRemoteSourceWidth)
    parsed.query = upsertQueryParam(parsed.query, "w", $requestedWidth)
    parsed.query = upsertQueryParam(parsed.query, "h", $requestedHeight)
    parsed.query = upsertQueryParam(parsed.query, "fit", "crop")
    # An author's explicit format choice stands.
    if not hasQueryParam(parsed.query, "fm") and not hasQueryParam(parsed.query, "auto"):
      # To a non-browser User-Agent imgix answers auto=format with a
      # PROGRESSIVE JPEG (fm=jpg too), and a progressive JPEG is the one
      # format that cannot stream into the canvas: its coefficients must
      # all be resident, so it decodes buffered. Boards with the headroom
      # for that keep the small JPEG body; a board that cannot hold it next
      # to its canvas (the 8 MB E1004 at 1200x1600: measured OOM abort)
      # asks for PNG, whose rows stream off the socket through a fixed
      # inflate window. WebP would be 8x fewer bytes than PNG but its decode
      # wants ~1.4 MB of contiguous buffers at panel size, over what that
      # board has left (measured: budget refusal).
      if progressiveJpegFitsBufferedDecode(requestedWidth, requestedHeight):
        parsed.query = upsertQueryParam(parsed.query, "auto", "format")
      else:
        parsed.query = upsertQueryParam(parsed.query, "fm", "png")
    return $parsed
  else:
    return url

proc boundedDecodeDims*(srcWidth, srcHeight, boundWidth, boundHeight: int):
    tuple[width, height: int] =
  ## The smallest aspect-preserving size that still covers the bounds box —
  ## enough pixels for any placement into it — and never an upscale. Sources
  ## already inside the box come back unchanged.
  result = (srcWidth, srcHeight)
  if srcWidth <= 0 or srcHeight <= 0 or boundWidth <= 0 or boundHeight <= 0:
    return
  if srcWidth <= boundWidth or srcHeight <= boundHeight:
    # The cover scale would be >= 1 on at least one axis: nothing to shrink
    # without dropping below the consumer's useful resolution.
    return
  if srcWidth.int64 * boundHeight.int64 >= boundWidth.int64 * srcHeight.int64:
    # Height is the binding axis of the cover scale.
    result.height = boundHeight
    result.width = max(1, (
      (srcWidth.int64 * boundHeight.int64 + srcHeight.int64 - 1) div
      srcHeight.int64).int)
  else:
    result.width = boundWidth
    result.height = max(1, (
      (srcHeight.int64 * boundWidth.int64 + srcWidth.int64 - 1) div
      srcWidth.int64).int)

proc decodeImageBounded*(content: string, boundWidth, boundHeight: int): Image =
  ## Decodes with at most the useful resolution for a (boundWidth,
  ## boundHeight) consumer: cover-scaled, aspect-preserved, never upscaled.
  ## The requestedBounds floor read — the caller has no target to offer, only
  ## an upper limit on what resolution can matter downstream.
  if looksLikeSvg(content):
    return decodeImageWithFallback(content)
  let dims = decodeImageDimensions(content)
  let target = boundedDecodeDims(dims.width, dims.height, boundWidth, boundHeight)
  if target.width >= dims.width and target.height >= dims.height:
    var native = content
    return decodeImageWithDisplayBounds(native, maxEdge = 0, maxPixels = 0)
  let image = newImage(target.width, target.height)
  # Same-aspect dimensions make stretch a pure scale (within a pixel of
  # rounding); the box-filtered scaled decoders keep it clean.
  discard decodeImageScaledInto(content, image, fitStretch)
  image

when defined(frameosEmbedded):
  proc decodeSpilledImageInto(path: string, totalLen: int, target: Image,
      fit: ScaledDecodeFit): Image =
    ## Decodes an image whose HTTP body was spilled to storage (SD/SPIFFS)
    ## because PSRAM could not buffer it. JPEGs and PNGs stream from the file
    ## through pixie's windowed decoders — neither the compressed body nor a
    ## full-size RGBA intermediate ever lives in RAM. Formats without a
    ## file-backed streaming decoder fail with a clear error: buffering the
    ## file back would recreate the OOM the spill just avoided.
    var file: File
    if not file.open(path):
      raise newException(PixieError, "Cannot open spilled image file: " & path)
    defer: file.close()
    var header = newString(64)
    let got = file.readBuffer(addr header[0], header.len)
    header.setLen(max(0, got))
    let format = embeddedImageFormat(header.cstring, header.len)
    # Errors surface rather than retrying buffered: progressive JPEGs,
    # interlaced/16-bit PNGs, RLE BMPs and ASCII PPMs all raise out of the
    # streaming decoders, and the buffered retry other paths use is exactly
    # the allocation that could not be made. Budget refusals degrade to a
    # reduced-resolution decode instead.
    if streamDecodeInto(format, fileJpegSource(file), totalLen, target, fit,
        proc() = file.setFilePos(0), collectBeforeDecode = true):
      return target
    raise newException(PixieError,
      &"Spilled {format} download ({totalLen div 1024}K) has no file-backed streaming decoder")

  proc decodeImageChunks(chunks: seq[HttpBodyChunk], totalLen: int,
      target: Image, fit: ScaledDecodeFit): Image =
    ## Decodes an image whose bytes arrived in multiple download chunks.
    ## PNGs stream straight from the chunks as inflate segments — no
    ## contiguous copy of the file is ever assembled; other formats
    ## coalesce into one buffer first.
    let first = chunks[0]
    if first.len > 8 and equalMem(first.data, pngSignature[0].unsafeAddr, 8) and
        not target.isNil and target.width > 0 and target.height > 0:
      GC_fullCollect()
      when compiles(decodePngScaledInto([InflateSegment()], target, fit)):
        var segments = newSeq[InflateSegment](chunks.len)
        for i, chunk in chunks:
          segments[i] = InflateSegment(
            data: cast[ptr UncheckedArray[uint8]](chunk.data), len: chunk.len)
        decodePngScaledInto(segments, target, fit)
        return target
    var data = newString(totalLen)
    var pos = 0
    for chunk in chunks:
      if chunk.len > 0:
        copyMem(addr data[pos], chunk.data, chunk.len)
        pos += chunk.len
    if not target.isNil and target.width > 0 and target.height > 0:
      return decodeImageWithFallback(data, target, fit)
    decodeImageWithFallback(data)

  proc decodeBodyBounded(data: pointer, len: int,
      boundWidth, boundHeight: int): Image =
    ## The embedded half of requestedBounds for a contiguous body: probe the
    ## dimensions, decode straight into a bounded target when the source is
    ## larger than useful, and fall back to the display-bounded native decode
    ## when it is not (or when the probe cannot say).
    var
      dims: ImageDimensions
      probed = true
    try:
      dims = decodeImageDimensions(data, len)
    except CatchableError:
      probed = false
    if probed:
      let bounded = boundedDecodeDims(dims.width, dims.height, boundWidth, boundHeight)
      if bounded.width < dims.width or bounded.height < dims.height:
        let target = newImage(bounded.width, bounded.height)
        return decodeImageWithFallback(data, len, target, fitStretch)
    decodeImageWithFallback(data, len)

  proc downloadImageStreamingInto(url: string, maxBytes: int, target: Image,
      headers: seq[SimpleHttpHeader], fit: ScaledDecodeFit): bool =
    ## Decodes a remote JPEG/PNG (BMP/PPM/WebP too) straight off the socket
    ## into `target` — no copy of the compressed body ever lives in PSRAM or
    ## on flash. Returns false when this fetch should go through the
    ## buffered path instead (error status, unknown length, format without
    ## a stream decoder, a decoder refusal such as a progressive JPEG, or a
    ## transport/status failure while re-reading the body), which then
    ## re-requests the URL and produces the same errors it always did. No
    ## IOError leaves here: a transport problem is the buffered path's to
    ## report, exactly as it was before streaming existed.
    ##
    ## Why: the buffered fetch holds the whole body before decoding. On a
    ## board whose canvas already owns most of its PSRAM (8 MB reTerminal
    ## E1004, 1200x1600) that meant every 1-2 MB gallery image spilled to a
    ## /state partition with a few hundred KB free and failed. Budget
    ## refusals still degrade to a reduced-resolution decode; the ladder's
    ## retries rewind the stream, which replays the retained start of the
    ## body when the refusal came from the header (the usual case) and
    ## reopens the request otherwise.
    if target.isNil or target.width <= 0 or target.height <= 0:
      return false
    var stream: HttpBodyStream
    try:
      stream = openHttpBodyStream(url, headers = headers)
    except IOError:
      # Transport failure: let the buffered path report it the usual way.
      return false
    defer: stream.closeHttpBodyStream()
    if stream.httpBodyStreamFailed:
      return false
    if stream.contentLength > 0 and maxBytes > 0 and stream.contentLength > maxBytes:
      return false
    var format = "unknown"
    var totalLen = 0
    try:
      let header = stream.peekHttpBodyStream(64)
      format = embeddedImageFormat(header.cstring, header.len)
      totalLen = if stream.contentLength > 0: stream.contentLength.int else: 0
      refreshDecodeBudgetInto()
      if not streamDecodeInto(format, stream.httpBodyStreamSource(), totalLen,
          target, fit, proc() = stream.rewindHttpBodyStream(),
          collectBeforeDecode = true):
        return false
    except HttpStreamReopenError as e:
      # A degrade rung needed the body again and the re-issued GET did not
      # give it back (rate limited, server error, transport). The buffered
      # path's own request surfaces that status the way it always did.
      log(%*{"event": "image:stream:fallback", "format": format,
             "bytes": totalLen, "reason": e.msg})
      return false
    except PixieError as e:
      if e.msg.contains("memory budget") or format == "WEBP":
        # The degrade ladder already ran out of rungs; buffering the body
        # would only add to the pressure that refused the decode. WebP has
        # nothing to fall back to either: the buffered path would build the
        # full-size RGBA intermediate this decoder exists to avoid.
        raise
      # Progressive JPEG, interlaced/16-bit PNG, truncated body, ...: the
      # buffered decoders handle more shapes, so hand over to them.
      log(%*{"event": "image:stream:fallback", "format": format,
             "bytes": totalLen, "reason": e.msg})
      return false
    except IOError, OSError:
      # Nothing on the streaming path is expected to raise these past the
      # reopen error above; if something does, the buffered fetch still
      # owns the error reporting rather than an app's error frame.
      log(%*{"event": "image:stream:fallback", "format": format,
             "bytes": totalLen, "reason": getCurrentExceptionMsg()})
      return false
    log(%*{"event": "image:streamed", "format": format, "bytes": totalLen,
           "width": target.width, "height": target.height})
    true

  proc downloadImageFromResolvedBuffer(url: string, maxBytes: int, target: Image = nil,
      headers: seq[SimpleHttpHeader] = @[], fit = fitCover,
      boundWidth = 0, boundHeight = 0):
      tuple[image: Image, data: string] =
    if boundWidth <= 0 and boundHeight <= 0 and
        downloadImageStreamingInto(url, maxBytes, target, headers, fit):
      return (target, "")
    var response = boundedRequestBuffer(url, maxBytes = maxBytes, headers = headers)
    # The budget must reflect the heap the decode is about to run on, not the
    # one some earlier render saw. This path never went through the
    # display-bounds helpers that refresh it, so a decoder's "over the memory
    # budget" plan check ran against a stale number — and a progressive JPEG
    # that passed it then OOM-aborted the render on a fragmented heap where
    # the largest free block was 1,668 bytes smaller than its allocation.
    # With a target the decode streams into the existing canvas, so the
    # output half of the budget split does not apply.
    if not target.isNil and target.width > 0 and target.height > 0:
      refreshDecodeBudgetInto()
    else:
      refreshDecodeBudget()
    try:
      if response.code >= 400:
        raise newException(HttpRequestError, "HTTP " & response.status & httpErrorDetail(response))
      let intoTarget = not target.isNil and target.width > 0 and target.height > 0
      let image =
        if response.spillPath.len > 0:
          decodeSpilledImageInto(response.spillPath, response.bodyLen, target, fit)
        elif response.chunks.len > 1:
          if intoTarget:
            # Budget refusals degrade to a reduced-resolution decode rather
            # than reaching the scene as an error frame.
            decodeIntoTargetWithDegrade(target, fit, proc(dst: Image) =
              discard decodeImageChunks(response.chunks, response.bodyLen, dst, fit))
          else:
            decodeImageChunks(response.chunks, response.bodyLen, target, fit)
        elif intoTarget:
          decodeIntoTargetWithDegrade(target, fit, proc(dst: Image) =
            discard decodeImageWithFallback(response.body, response.bodyLen, dst, fit))
        elif not target.isNil:
          decodeImageWithFallback(response.body, response.bodyLen, target, fit)
        elif boundWidth > 0 and boundHeight > 0:
          decodeBodyBounded(response.body, response.bodyLen, boundWidth, boundHeight)
        else:
          decodeImageWithFallback(response.body, response.bodyLen)
      result = (image, "")
    finally:
      response.freeHttpBufferResponse()

  proc downloadImageFromBufferBounded(url: string, boundWidth, boundHeight,
      maxBytes: int, headers: seq[SimpleHttpHeader]):
      tuple[image: Image, data: string] =
    downloadImageFromResolvedBuffer(url, maxBytes, nil, headers, fitCover,
      boundWidth, boundHeight)

  proc downloadImageFromBuffer(url: string, maxBytes: int, target: Image = nil,
      headers: seq[SimpleHttpHeader] = @[], fit = fitCover):
      tuple[image: Image, data: string] =
    let directUrl = embeddedSizedRemoteImageUrl(url, target)
    downloadImageFromResolvedBuffer(directUrl, maxBytes, target, headers, fit)

proc downloadImage*(url: string, maxBytes = MaxImageDownloadBytes, headers: seq[SimpleHttpHeader] = @[]): Image =
  if url.startsWith("data:"):
    return decodeDataUrl(url)
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, headers = headers).image
  else:
    let response = boundedRequestWithHeaders(url, headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    var content = response.body
    if looksLikeSvg(content):
      return decodeImageWithFallback(content)
    # Full decode when memory allows; the budget scales oversized decodes
    result = decodeImageWithDisplayBounds(content, maxEdge = 0, maxPixels = 0)

proc downloadImageWithDataBounded*(url: string, boundWidth, boundHeight: int,
    maxBytes = MaxImageDownloadBytes,
    headers: seq[SimpleHttpHeader] = @[]): tuple[image: Image, data: string] =
  ## The requestedBounds download: fetch, then decode bounded.
  if url.startsWith("data:"):
    # Data URLs are small by construction; decode them as-is.
    return (decodeDataUrl(url), "")
  when defined(frameosEmbedded):
    return downloadImageFromBufferBounded(url, boundWidth, boundHeight,
      maxBytes, headers)
  else:
    let response = boundedRequestWithHeaders(url, headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    let content = response.body
    (decodeImageBounded(content, boundWidth, boundHeight), content)

proc downloadImageWithData*(url: string, maxBytes = MaxImageDownloadBytes,
    headers: seq[SimpleHttpHeader] = @[]): tuple[image: Image, data: string] =
  if url.startsWith("data:"):
    let image = decodeDataUrl(url)
    return (image, "")
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, headers = headers)
  else:
    let response = boundedRequestWithHeaders(url, headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    let content = response.body
    if looksLikeSvg(content):
      return (decodeImageWithFallback(content), content)
    var decodeContent = content
    result = (decodeImageWithDisplayBounds(decodeContent, maxEdge = 0, maxPixels = 0), content)

proc downloadImageInto*(url: string, target: Image, maxBytes = MaxImageDownloadBytes,
    headers: seq[SimpleHttpHeader] = @[], fit = fitCover): Image =
  when defined(frameosEmbedded):
    if url.startsWith("data:"):
      return decodeDataUrlInto(url, target, fit)
    return downloadImageFromBuffer(url, maxBytes, target, headers, fit).image
  else:
    # Decode-into-target stays an embedded strategy; on hosts consumers
    # need the native resolution and scale it themselves
    if url.startsWith("data:"):
      return decodeDataUrl(url)
    var response = boundedRequestWithHeaders(url, headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    var content = response.body
    if looksLikeSvg(content):
      return decodeImageWithFallback(content)
    return decodeImageWithDisplayBounds(content, maxEdge = 0, maxPixels = 0)

proc downloadImageWithDataInto*(url: string, target: Image, maxBytes = MaxImageDownloadBytes,
    headers: seq[SimpleHttpHeader] = @[], fit = fitCover): tuple[image: Image, data: string] =
  when defined(frameosEmbedded):
    if url.startsWith("data:"):
      return (decodeDataUrlInto(url, target, fit), "")
    return downloadImageFromBuffer(url, maxBytes, target, headers, fit)
  else:
    if url.startsWith("data:"):
      return (decodeDataUrl(url), "")
    let response = boundedRequestWithHeaders(url, headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    let content = response.body
    if looksLikeSvg(content):
      return (decodeImageWithFallback(content), content)
    var decodeContent = content
    return (decodeImageWithDisplayBounds(decodeContent, maxEdge = 0, maxPixels = 0), content)

proc parseExifJson(output: string): Option[JsonNode] =
  try:
    let parsed = parseJson(output)
    if parsed.kind == JArray and parsed.len > 0:
      return some(parsed[0])
  except CatchableError:
    discard
  return none(JsonNode)

proc getExifMetadataFromPath*(path: string): Option[JsonNode] =
  when defined(frameosEmbedded) or defined(frameosWasm):
    none(JsonNode)
  else:
    let exiftool = findExe("exiftool")
    if exiftool == "":
      return none(JsonNode)
    try:
      let processResult = runProcessPiped(
        exiftool,
        @["-j", "-n", path],
        timeoutMs = ExifToolTimeoutMs,
        maxOutputBytes = MaxExifOutputBytes
      )
      if processResult.exitCode == 0 and not processResult.timedOut and not processResult.outputExceeded:
        return parseExifJson(processResult.output)
    except CatchableError:
      discard
    return none(JsonNode)

proc getExifMetadataFromData*(data: string): Option[JsonNode] =
  when defined(frameosEmbedded) or defined(frameosWasm):
    none(JsonNode)
  else:
    let exiftool = findExe("exiftool")
    if exiftool == "":
      return none(JsonNode)
    try:
      let processResult = runProcessPiped(
        exiftool,
        @["-j", "-n", "-"],
        input = data,
        timeoutMs = ExifToolTimeoutMs,
        maxOutputBytes = MaxExifOutputBytes
      )
      if processResult.exitCode == 0 and not processResult.timedOut and not processResult.outputExceeded:
        return parseExifJson(processResult.output)
    except CatchableError:
      discard
    return none(JsonNode)

proc rotateDegrees*(image: Image, degrees: int): Image {.raises: [PixieError].} =
  case (degrees + 1080) mod 360: # TODO: yuck
  of 90:
    result = image.newImageLike(image.height, image.width)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.setPixel(result.dataIndex(x, y),
          image.getPixel(image.dataIndex(y, image.height - x - 1)))
  of 180:
    result = image.newImageLike(image.width, image.height)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.setPixel(result.dataIndex(x, y),
          image.getPixel(image.dataIndex(image.width - x - 1, image.height - y - 1)))
  of 270:
    result = image.newImageLike(image.height, image.width)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.setPixel(result.dataIndex(x, y),
          image.getPixel(image.dataIndex(image.width - y - 1, x)))
  else:
    result = image

proc applyFlip*(image: Image, flip: string) =
  case flip:
  of "horizontal":
    image.flipHorizontal()
  of "vertical":
    image.flipVertical()
  of "both":
    image.flipHorizontal()
    image.flipVertical()
  else:
    discard

proc previewTransform*(image: var Image, rotate: int, flip: string): Image {.raises: [PixieError].} =
  # Driver preview paths pass disposable images, so avoid copying for the rotate=0 case.
  result = if rotate != 0: image.rotateDegrees(rotate) else: image
  result.applyFlip(flip)

proc previewDimensions*(width, height, rotate: int): tuple[width: int, height: int] =
  case (rotate + 1080) mod 360
  of 90, 270:
    (height, width)
  else:
    (width, height)

proc previewSourceIndex*(x, y, width, height, rotate: int, flip: string): int =
  let
    rotation = (rotate + 1080) mod 360
    dimensions = previewDimensions(width, height, rotation)
  var
    rotatedX = x
    rotatedY = y

  case flip:
  of "horizontal":
    rotatedX = dimensions.width - x - 1
  of "vertical":
    rotatedY = dimensions.height - y - 1
  of "both":
    rotatedX = dimensions.width - x - 1
    rotatedY = dimensions.height - y - 1
  else:
    discard

  var sourceX, sourceY: int
  case rotation
  of 90:
    sourceX = rotatedY
    sourceY = height - rotatedX - 1
  of 180:
    sourceX = width - rotatedX - 1
    sourceY = height - rotatedY - 1
  of 270:
    sourceX = width - rotatedY - 1
    sourceY = rotatedX
  else:
    sourceX = rotatedX
    sourceY = rotatedY

  sourceY * width + sourceX

when defined(frameosEmbedded):
  proc fillPixelRect(image: Image, x, y, w, h: int, color: ColorRGBX) =
    let x0 = max(0, x)
    let y0 = max(0, y)
    let x1 = min(image.width, x + w)
    let y1 = min(image.height, y + h)
    if x0 >= x1 or y0 >= y1:
      return
    for py in y0 ..< y1:
      for px in x0 ..< x1:
        image.setPixel(image.dataIndex(px, py), color)

  proc writeEmbeddedErrorMarker(image: Image, width, height: int) =
    let black = rgbx(0, 0, 0, 255)
    let border = max(4, min(width, height) div 80)
    let bar = max(6, min(width, height) div 35)
    fillPixelRect(image, 0, 0, width, border, black)
    fillPixelRect(image, 0, height - border, width, border, black)
    fillPixelRect(image, 0, 0, border, height, black)
    fillPixelRect(image, width - border, 0, border, height, black)
    fillPixelRect(image, width div 8, height div 2 - bar div 2, width * 3 div 4, bar, black)
    fillPixelRect(image, width div 2 - bar div 2, height div 8, bar, height * 3 div 4, black)

when defined(frameosEmbedded):
  proc writeEmbeddedErrorText(image: Image, width, height: int, message: string) =
    ## Renders the error message with the compiled-in typeface: a thin black
    ## border and the wrapped text centered on the (already white) canvas.
    let black = rgbx(0, 0, 0, 255)
    let border = max(2, min(width, height) div 160)
    fillPixelRect(image, 0, 0, width, border, black)
    fillPixelRect(image, 0, height - border, width, border, black)
    fillPixelRect(image, 0, 0, border, height, black)
    fillPixelRect(image, width - border, 0, border, height, black)

    let typeface = getDefaultTypeface()
    let fontSize = clamp(min(width, height).float / 24.0, 16.0, 44.0)
    let font = newFont(typeface, fontSize, color(0, 0, 0, 1))
    let padding = max(16.0, min(width, height).float / 20.0)
    let types = typeset(
      spans = [newSpan(message, font)],
      bounds = vec2(width.toFloat() - 2 * padding, height.toFloat() - 2 * padding),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    )
    image.fillText(types, translate(vec2(padding, padding)))

proc writeError*(image: Image, width, height: int, message: string) =
  when defined(frameosEmbedded):
    # Error frames often follow allocation failures; if typesetting the real
    # message runs out of memory too, fall back to the allocation-free marker.
    try:
      writeEmbeddedErrorText(image, width, height, message)
    except Exception:
      writeEmbeddedErrorMarker(image, width, height)
  else:
    let typeface = getDefaultTypeface()
    let font = newFont(typeface, 32, parseHtmlColor("#000000"))
    let padding = 10.0
    let types = typeset(
        spans = [newSpan(message, font)],
        bounds = vec2(width.toFloat() - 2 * padding,
        height.toFloat() - 2 * padding),
        hAlign = CenterAlign,
        vAlign = MiddleAlign,
      )
    let borderFont = newFont(typeface, 32, parseHtmlColor("#ffffff"))
    let borderTypes = typeset(
        spans = [newSpan(message, borderFont)],
        bounds = vec2(width.toFloat() - 2 * padding,
        height.toFloat() - 2 * padding),
        hAlign = CenterAlign,
        vAlign = MiddleAlign,
      )
    image.strokeText(borderTypes, translate(vec2(padding, padding)), strokeWidth = 2)
    image.fillText(types, translate(vec2(padding, padding)))

proc spillImageToSpool*(image: Image, name: string, preferredDir = ""): ImageSpool =
  ## The disk tier of the image side: write the image's pixels to a spill file
  ## as raw premultiplied RGBX rows, so a cache can hold them without holding
  ## memory. Returns nil when there is nowhere to write or the write fails —
  ## the caller keeps yesterday's behavior instead of raising (principle 3,
  ## docs/value-pipeline.md).
  ##
  ## Stride-aware: a view spills exactly its own rectangle, one row per span,
  ## so what lands in the file is always width*height*4 bytes of this image
  ## and nothing of the buffer around it.
  if image.isNil or image.width <= 0 or image.height <= 0:
    return nil
  let path = newSpillFilePath(name, preferredDir)
  if path.len == 0:
    return nil
  var file: File
  if not file.open(path, fmWrite):
    return nil
  var ok = true
  try:
    if image.format == pfRgbx:
      image.forEachSpan:
        if ok:
          let bytes = spanLen * 4
          if file.writeBuffer(addr image.data[spanStart], bytes) != bytes:
            ok = false
    else:
      # The file format is RGBX rows whatever the image is; a 565 image is
      # expanded a row at a time on the way out.
      var row = newSeq[ColorRGBX](image.width)
      let bytes = image.width * 4
      for y in 0 ..< image.height:
        if not ok:
          break
        for x in 0 ..< image.width:
          row[x] = image.unsafe[x, y]
        if file.writeBuffer(addr row[0], bytes) != bytes:
          ok = false
  except CatchableError:
    ok = false
  file.close()
  if not ok:
    # A partial file is a wrong answer waiting to be read back; degrade to
    # "no disk tier" rather than storing it.
    try:
      removeFile(path)
    except CatchableError:
      discard
    return nil
  newImageSpool(path, image.width, image.height)

proc materializeImageSpool*(spool: ImageSpool): Image =
  ## The floor read of the disk tier: the whole image back in memory, byte for
  ## byte what was spilled. Returns nil when the file is gone or truncated —
  ## the storage got pulled or swept — or when the allocation itself would not
  ## fit in live memory; the caller treats any nil as a cache miss and
  ## recomputes, which is exactly what a cache with no entry would have done.
  if spool.isNil or spool.width <= 0 or spool.height <= 0:
    return nil
  let bytes = spool.byteSize()
  let available = availableRenderBytes()
  if available > 0 and bytes > available:
    return nil
  var file: File
  if not file.open(spool.path):
    return nil
  defer: file.close()
  var image: Image
  try:
    image = newImage(spool.width, spool.height)
  except CatchableError:
    return nil
  if file.readBuffer(addr image.data[0], bytes) != bytes:
    return nil
  image

proc renderErrorInto*(image: Image, width, height: int, message: string) =
  image.fill(parseHtmlColor("#ffffff"))
  writeError(image, width, height, message)

proc renderError*(width, height: int, message: string): Image =
  when defined(frameosEmbedded):
    GC_fullCollect()
  result = newImage(width, height)
  result.renderErrorInto(width, height, message)

when defined(frameosEmbedded):
  proc drawScaledNearest(targetImage: Image, srcImage: Image, scalingMode: string,
      offsetX: int, offsetY: int, blendMode: BlendMode): bool =
    if targetImage.isNil or srcImage.isNil or srcImage.width <= 0 or srcImage.height <= 0 or
        targetImage.width <= 0 or targetImage.height <= 0:
      return false

    var scaleX = targetImage.width.float32 / srcImage.width.float32
    var scaleY = targetImage.height.float32 / srcImage.height.float32
    var drawX = offsetX.float32
    var drawY = offsetY.float32

    case scalingMode:
    of "cover":
      let ratio = max(scaleX, scaleY)
      scaleX = ratio
      scaleY = ratio
      drawX = -((srcImage.width.float32 * ratio - targetImage.width.float32) / 2) + offsetX.float32
      drawY = -((srcImage.height.float32 * ratio - targetImage.height.float32) / 2) + offsetY.float32
    of "contain":
      let ratio = min(scaleX, scaleY)
      scaleX = ratio
      scaleY = ratio
      drawX = ((targetImage.width.float32 - srcImage.width.float32 * ratio) / 2) + offsetX.float32
      drawY = ((targetImage.height.float32 - srcImage.height.float32 * ratio) / 2) + offsetY.float32
    of "stretch":
      discard
    else:
      return false

    if scaleX <= 0 or scaleY <= 0:
      return false

    let invScaleX = 1'f32 / scaleX
    let invScaleY = 1'f32 / scaleY
    let blend = blendMode.blender()
    for y in 0 ..< targetImage.height:
      let srcYFloat = (y.float32 - drawY) * invScaleY
      if srcYFloat < 0 or srcYFloat >= srcImage.height.float32:
        continue
      let srcY = min(srcImage.height - 1, srcYFloat.int)
      for x in 0 ..< targetImage.width:
        let srcXFloat = (x.float32 - drawX) * invScaleX
        if srcXFloat < 0 or srcXFloat >= srcImage.width.float32:
          continue
        let srcX = min(srcImage.width - 1, srcXFloat.int)
        let targetIndex = targetImage.dataIndex(x, y)
        targetImage.setPixel(targetIndex, blend(targetImage.getPixel(targetIndex),
          srcImage.getPixel(srcImage.dataIndex(srcX, srcY))))
    true

proc scaleAndDrawImage*(targetImage: Image, srcImage: Image, scalingMode: string, offsetX: int = 0,
    offsetY: int = 0, blendMode: BlendMode = OverwriteBlend) {.raises: [PixieError].} =
  if srcImage.width == targetImage.width and srcImage.height ==
      targetImage.height:
    if offsetX != 0 or offsetY != 0:
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, offsetY.float32)), blendMode)
    else:
      targetImage.draw(srcImage, blendMode = blendMode)
  else:
    when defined(frameosEmbedded):
      if drawScaledNearest(targetImage, srcImage, scalingMode, offsetX, offsetY, blendMode):
        return
    case scalingMode:
    of "cover":
      let scaleRatio = max(
        targetImage.width.float32 / srcImage.width.float32,
        targetImage.height.float32 / srcImage.height.float32
      )
      let scaledWidth = srcImage.width.float32 * scaleRatio
      let scaledHeight = srcImage.height.float32 * scaleRatio
      let xOffset = (scaledWidth - targetImage.width.float32) / 2
      let yOffset = (scaledHeight - targetImage.height.float32) / 2
      targetImage.draw(
        srcImage,
        translate(vec2(-xOffset + offsetX.float32, -yOffset + offsetY.float32)) * scale(vec2(scaleRatio,
            scaleRatio)),
        blendMode
      )

    of "contain":
      let scaleRatio = min(
        targetImage.width.float32 / srcImage.width.float32,
        targetImage.height.float32 / srcImage.height.float32
      )
      let scaledWidth = srcImage.width.float32 * scaleRatio
      let scaledHeight = srcImage.height.float32 * scaleRatio
      let xOffset = (targetImage.width.float32 - scaledWidth) / 2
      let yOffset = (targetImage.height.float32 - scaledHeight) / 2
      targetImage.draw(
        srcImage,
        translate(vec2(xOffset, yOffset)) * scale(vec2(scaleRatio, scaleRatio)),
        blendMode
      )

    of "stretch":
      targetImage.draw(
        srcImage,
        scale(vec2(
          targetImage.width.float32 / srcImage.width.float32,
          targetImage.height.float32 / srcImage.height.float32
        )) * translate(vec2(offsetX.float32, offsetY.float32)),
        blendMode
      )

    of "tiled":
      targetImage.drawTiled(srcImage, translate(vec2(offsetX.float32, offsetY.float32)))

    of "top-left":
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, offsetY.float32)))

    of "top-center":
      let xOffset = (targetImage.width - srcImage.width) div 2
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, offsetY.float32)))

    of "top-right":
      let xOffset = targetImage.width - srcImage.width
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, offsetY.float32)))

    of "center-left":
      let yOffset = (targetImage.height - srcImage.height) div 2
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "center-right":
      let yOffset = (targetImage.height - srcImage.height) div 2
      let xOffset = targetImage.width - srcImage.width
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "bottom-left":
      let yOffset = targetImage.height - srcImage.height
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "bottom-center":
      let xOffset = (targetImage.width - srcImage.width) div 2
      let yOffset = targetImage.height - srcImage.height
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))

    of "bottom-right":
      let xOffset = targetImage.width - srcImage.width
      let yOffset = targetImage.height - srcImage.height
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))

    else: # "center"
      let xOffset = (targetImage.width - srcImage.width) div 2
      let yOffset = (targetImage.height - srcImage.height) div 2
      targetImage.draw(srcImage, translate(vec2(xOffset.float32 + offsetX.float32, yOffset.float32 + offsetY.float32)))
