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

import frameos/utils/http_client
import frameos/utils/memory
when not defined(frameosEmbedded):
  import frameos/utils/font
when defined(frameosEmbedded):
  import pixie/blends
  import pixie/fileformats/bmp
  import pixie/fileformats/jpeg
  import pixie/fileformats/png
when not defined(frameosEmbedded):
  # No child processes on FreeRTOS: ImageMagick/exiftool fallbacks are
  # compiled out and pixie does all decoding.
  import frameos/utils/process

const MaxImageDownloadBytes = 15 * 1024 * 1024
const MaxImageMagickOutputBytes = 50 * 1024 * 1024
const MaxExifOutputBytes = 1024 * 1024
const ImageMagickTimeoutMs = 30_000
const ExifToolTimeoutMs = 10_000
const DisplayDecodeMaxEdge* = 2048
const DisplayDecodeMaxPixels* = DisplayDecodeMaxEdge * DisplayDecodeMaxEdge
const ImageEngineImageMagick* = "imagemagick"
when defined(frameosEmbedded):
  const EmbeddedSmallDecodeCopyBytes = 512 * 1024
  const EmbeddedMaxDirectDecodeCopyBytes = 2 * 1024 * 1024
  const EmbeddedMaxDirectPngBytes = 6 * 1024 * 1024
  const EmbeddedMaxDirectRgbaBytes = 5 * 1024 * 1024
  const EmbeddedMaxRemoteSourceWidth = 800

var runtimeImageEngine = ""

proc scaleAndDrawImage*(targetImage: Image, srcImage: Image, scalingMode: string, offsetX: int = 0,
    offsetY: int = 0, blendMode: BlendMode = OverwriteBlend) {.raises: [PixieError].}

proc setRuntimeImageEngine*(imageEngine: string) =
  let normalized = imageEngine.normalize.toLowerAscii()
  runtimeImageEngine =
    if normalized in ["", "pixie", ImageEngineImageMagick]:
      normalized
    else:
      ""

proc getRuntimeImageEngine*(): string =
  runtimeImageEngine

proc getEffectiveRuntimeImageEngine*(): string =
  if runtimeImageEngine == ImageEngineImageMagick:
    return ImageEngineImageMagick
  return "pixie"

proc useImageMagick(): bool =
  runtimeImageEngine == ImageEngineImageMagick

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

proc imageMagickCommand(): string =
  let magick = findExe("magick")
  if magick != "":
    return magick
  let convert = findExe("convert")
  if convert != "":
    return convert
  return ""

proc decodeImageMagickOutput(output: string): Option[Image] =
  if output.len == 0 or output.len > MaxImageMagickOutputBytes:
    return none(Image)
  try:
    return some(decodeImage(output))
  except CatchableError:
    return none(Image)

proc runImageMagick(args: seq[string]; input = ""): Option[string] =
  when defined(frameosEmbedded):
    none(string)
  else:
    let cmd = imageMagickCommand()
    if cmd == "":
      return none(string)
    try:
      let processResult = runProcessPiped(
        cmd,
        args,
        input = input,
        timeoutMs = ImageMagickTimeoutMs,
        maxOutputBytes = MaxImageMagickOutputBytes
      )
      if processResult.exitCode == 0 and not processResult.timedOut and not processResult.outputExceeded:
        return some(processResult.output)
    except CatchableError:
      discard
    none(string)

proc decodeImageWithImageMagick(data: string): Option[Image] =
  let output = runImageMagick(@["-quiet", "-", "-auto-orient", "bmp:-"], input = data)
  if output.isSome:
    return decodeImageMagickOutput(output.get())
  return none(Image)

proc decodeImageWithImageMagick(data: string, width, height: int): Option[Image] =
  let sizeArg = &"{width}x{height}>"
  let output = runImageMagick(@["-quiet", "-", "-auto-orient", "-resize", sizeArg, "bmp:-"], input = data)
  if output.isSome:
    return decodeImageMagickOutput(output.get())
  return none(Image)

proc readImageWithImageMagick(path: string): Option[Image] =
  let output = runImageMagick(@["-quiet", path, "-auto-orient", "bmp:-"])
  if output.isSome:
    return decodeImageMagickOutput(output.get())
  return none(Image)

proc decodeSvgWithImageMagick*(svg: string, width: int, height: int): Option[Image] =
  let sizeArg = &"{width}x{height}"
  let output = runImageMagick(
    @["-quiet", "-background", "none", "-size", sizeArg, "svg:-", "-resize", sizeArg, "bmp:-"],
    input = svg
  )
  if output.isSome:
    return decodeImageMagickOutput(output.get())
  return none(Image)

proc decodeSvgWithFallback*(svg: string, width: int, height: int): Option[Image] =
  if useImageMagick():
    return decodeSvgWithImageMagick(svg, width, height)
  try:
    return some(newImage(parseSvg(svg, width, height)))
  except CatchableError:
    return none(Image)

proc decodeImageWithFallback*(data: string): Image =
  if useImageMagick():
    let converted = decodeImageWithImageMagick(data)
    if converted.isSome:
      return converted.get()
  return decodeImage(data)

proc decodeImageWithDisplayBounds*(data: var string,
    maxEdge = DisplayDecodeMaxEdge,
    maxPixels = DisplayDecodeMaxPixels): Image =
  refreshDecodeBudget()
  let dimensions = decodeImageDimensions(data)
  let target = displayDecodeDimensions(dimensions, maxEdge, maxPixels)
  if target.width != dimensions.width or target.height != dimensions.height:
    if useImageMagick():
      let converted = decodeImageWithImageMagick(data, target.width, target.height)
      if converted.isSome:
        data = ""
        GC_fullCollect()
        return converted.get()
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

  proc decodeImageWithFallback*(data: pointer, len: int, target: Image): Image =
    if data == nil or len <= 0:
      raise newException(PixieError, "Unsupported image file format: empty response")
    let format = embeddedImageFormat(data, len)
    if format == "JPEG" and not target.isNil and target.width > 0 and target.height > 0:
      GC_fullCollect()
      when compiles(decodeJpegScaledInto(data, len, target)):
        decodeJpegScaledInto(data, len, target)
        return target
      else:
        if len <= EmbeddedMaxDirectDecodeCopyBytes:
          target.scaleAndDrawImage(decodeImageWithFallback(copyImageBuffer(data, len)), "cover")
          return target
        raise newException(PixieError,
          &"Direct on-device JPEG scaling is not available in this Pixie build; fetched {len div 1024}K")
    if format == "PNG" and not target.isNil and target.width > 0 and target.height > 0:
      if len > EmbeddedMaxDirectPngBytes:
        raise newException(PixieError,
          &"Direct on-device PNG decode over {EmbeddedMaxDirectPngBytes div 1024}K needs the low-memory media proxy; fetched {len div 1024}K")
      guardEmbeddedDirectDecode(data, len, format)
      GC_fullCollect()
      when compiles(decodePngScaledInto(data, len, target)):
        decodePngScaledInto(data, len, target)
        return target
      else:
        target.scaleAndDrawImage(decodeImageWithFallback(data, len), "cover")
        return target
    decodeImageWithFallback(data, len)

  proc decodeImageWithFallback*(data: var string, target: Image): Image =
    if data.len <= 0:
      raise newException(PixieError, "Unsupported image file format: empty response")
    let format = embeddedImageFormat(data.cstring, data.len)
    if format == "JPEG" and not target.isNil and target.width > 0 and target.height > 0:
      GC_fullCollect()
      when compiles(decodeJpegScaledInto(data, target)):
        decodeJpegScaledInto(data, target)
        return target
      else:
        if data.len <= EmbeddedMaxDirectDecodeCopyBytes:
          target.scaleAndDrawImage(decodeImageWithFallback(data), "cover")
          return target
        raise newException(PixieError,
          &"Direct on-device JPEG scaling is not available in this Pixie build; fetched {data.len div 1024}K")
    if format == "PNG" and not target.isNil and target.width > 0 and target.height > 0:
      if data.len > EmbeddedMaxDirectPngBytes:
        raise newException(PixieError,
          &"Direct on-device PNG decode over {EmbeddedMaxDirectPngBytes div 1024}K needs the low-memory media proxy; fetched {data.len div 1024}K")
      guardEmbeddedDirectDecode(data.cstring, data.len, format)
      GC_fullCollect()
      when compiles(decodePngScaledInto(data, target)):
        decodePngScaledInto(data, target)
        return target
      else:
        target.scaleAndDrawImage(decodeImageWithFallback(data), "cover")
        return target
    decodeImageWithFallback(data)

  proc httpErrorDetail(response: BoundedHttpBufferResponse): string =
    if response.body == nil or response.bodyLen <= 0:
      return ""
    let copyLen = min(response.bodyLen, 512)
    var snippet = newString(copyLen)
    if copyLen > 0:
      copyMem(addr snippet[0], response.body, copyLen)
    if response.bodyLen > copyLen:
      snippet.add("...")
    ": " & snippet

when not defined(frameosEmbedded):
  proc decodeImageWithFallback*(data: var string, target: Image): Image =
    if not target.isNil and target.width > 0 and target.height > 0:
      if useImageMagick():
        let converted = decodeImageWithImageMagick(data, target.width, target.height)
        if converted.isSome:
          target.scaleAndDrawImage(converted.get(), "stretch")
          data = ""
          GC_fullCollect()
          return target
      return decodeImageScaledInto(data, target)
    decodeImageWithFallback(data)

proc readImageWithFallback*(path: string): Image =
  if useImageMagick():
    let converted = readImageWithImageMagick(path)
    if converted.isSome:
      return converted.get()
  return readImage(path)

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
  if isJpegHeader(header) and not useImageMagick():
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

proc looksLikeSvg(data: string): bool =
  ## SVG has no dimensions probe; callers keep it on the generic decoder.
  data.len > 5 and (data.startsWith("<?xml") or data.startsWith("<svg"))

proc scalingModeToFit(scalingMode: string): Option[ScaledDecodeFit] =
  case scalingMode
  of "cover": some(fitCover)
  of "contain": some(fitContain)
  of "stretch": some(fitStretch)
  else: none(ScaledDecodeFit)

proc readImageIntoTarget*(path: string, target: Image, scalingMode: string): bool =
  ## Decodes an image file directly into an existing target image (usually
  ## the render canvas) with aspect-correct fit, keeping peak memory at the
  ## decode intermediates only. Returns false when this fast path does not
  ## apply (unsupported scaling mode or format); raises catchable errors for
  ## unreadable or over-budget files.
  if target.isNil or target.width <= 0 or target.height <= 0:
    return false
  if useImageMagick():
    # Keep the configured engine in charge; the generic path knows how to
    # route through ImageMagick.
    return false
  let fitOption = scalingModeToFit(scalingMode)
  if fitOption.isNone:
    return false
  let fit = fitOption.get()

  refreshDecodeBudget()
  let fileSize = getFileSize(path)
  var header = probeImageFileHeader(path)

  # JPEG only: it has no alpha, so writing decoded pixels straight over the
  # canvas is equivalent to compositing. PNGs may carry transparency that
  # must alpha-blend over the scene background via the generic path.
  if not isJpegHeader(header):
    return false
  header = ""

  var file: File
  if not file.open(path):
    raise newException(PixieError, "Cannot open image file: " & path)
  try:
    decodeJpegStreamScaledInto(fileJpegSource(file), fileSize.int, target, fit)
    return true
  except PixieError:
    # Progressive JPEGs cannot stream; retry buffered below.
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

proc decodeDataUrlInto*(dataUrl: string, target: Image): Image =
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
    return decodeImageWithFallback(decodedData, target)
  return decodeImageWithFallback(decodedData)

when defined(frameosEmbedded):
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

  proc embeddedSizedRemoteImageUrl(url: string, target: Image): string =
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
      if parsed.query.find("auto=") < 0:
        parsed.query = upsertQueryParam(parsed.query, "auto", "format")
      return $parsed
    else:
      return url

  proc downloadImageFromResolvedBuffer(url: string, maxBytes: int, target: Image = nil,
      headers: seq[SimpleHttpHeader] = @[]):
      tuple[image: Image, data: string] =
    var response = boundedRequestBuffer(url, maxBytes = maxBytes, headers = headers)
    try:
      if response.code >= 400:
        raise newException(HttpRequestError, "HTTP " & response.status & httpErrorDetail(response))
      let image =
        if not target.isNil:
          decodeImageWithFallback(response.body, response.bodyLen, target)
        else:
          decodeImageWithFallback(response.body, response.bodyLen)
      result = (image, "")
    finally:
      response.freeHttpBufferResponse()

  proc downloadImageFromBuffer(url: string, maxBytes: int, target: Image = nil,
      headers: seq[SimpleHttpHeader] = @[]):
      tuple[image: Image, data: string] =
    let directUrl = embeddedSizedRemoteImageUrl(url, target)
    downloadImageFromResolvedBuffer(directUrl, maxBytes, target, headers)

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
    result = decodeImageWithDisplayBounds(content)

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
    result = (decodeImageWithDisplayBounds(decodeContent), content)

proc downloadImageInto*(url: string, target: Image, maxBytes = MaxImageDownloadBytes,
    headers: seq[SimpleHttpHeader] = @[]): Image =
  if url.startsWith("data:"):
    return decodeDataUrlInto(url, target)
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, target, headers).image
  else:
    var response = boundedRequestWithHeaders(url, headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    var content = response.body
    return decodeImageWithFallback(content, target)

proc downloadImageWithDataInto*(url: string, target: Image, maxBytes = MaxImageDownloadBytes,
    headers: seq[SimpleHttpHeader] = @[]): tuple[image: Image, data: string] =
  if url.startsWith("data:"):
    return (decodeDataUrlInto(url, target), "")
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, target, headers)
  else:
    let response = boundedRequestWithHeaders(url, headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    let content = response.body
    var decodeContent = content
    return (decodeImageWithFallback(decodeContent, target), content)

proc parseExifJson(output: string): Option[JsonNode] =
  try:
    let parsed = parseJson(output)
    if parsed.kind == JArray and parsed.len > 0:
      return some(parsed[0])
  except CatchableError:
    discard
  return none(JsonNode)

proc getExifMetadataFromPath*(path: string): Option[JsonNode] =
  when defined(frameosEmbedded):
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
  when defined(frameosEmbedded):
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
    result = newImage(image.height, image.width)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.data[result.dataIndex(x, y)] =
          image.data[image.dataIndex(y, image.height - x - 1)]
  of 180:
    result = newImage(image.width, image.height)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.data[result.dataIndex(x, y)] =
          image.data[image.dataIndex(image.width - x - 1, image.height - y - 1)]
  of 270:
    result = newImage(image.height, image.width)
    for y in 0 ..< result.height:
      for x in 0 ..< result.width:
        result.data[result.dataIndex(x, y)] =
          image.data[image.dataIndex(image.width - y - 1, x)]
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
        image.data[image.dataIndex(px, py)] = color

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

proc writeError*(image: Image, width, height: int, message: string) =
  when defined(frameosEmbedded):
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
        targetImage.data[targetIndex] = blend(targetImage.data[targetIndex],
          srcImage.data[srcImage.dataIndex(srcX, srcY)])
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
