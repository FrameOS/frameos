import pixie
import pixie/fileformats/svg
import base64
import json
import os
import options
import sequtils
import strutils
import strformat
import uri

import frameos/utils/font
import frameos/utils/http_client
when defined(frameosEmbedded):
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
const ImageEngineImageMagick* = "imagemagick"
when defined(frameosEmbedded):
  const EmbeddedSmallDecodeCopyBytes = 512 * 1024
  const EmbeddedMaxDirectDecodeCopyBytes = 2 * 1024 * 1024
  const EmbeddedMaxDirectPngBytes = 768 * 1024
  const EmbeddedMaxDirectRgbaBytes = 5 * 1024 * 1024
  const EmbeddedMaxRemoteSourceWidth = 800

var runtimeImageEngine = ""

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
      decodeJpegScaledInto(data, len, target)
      return target
    decodeImageWithFallback(data, len)

  proc decodeImageWithFallback*(data: var string, target: Image): Image =
    if data.len <= 0:
      raise newException(PixieError, "Unsupported image file format: empty response")
    let format = embeddedImageFormat(data.cstring, data.len)
    if format == "JPEG" and not target.isNil and target.width > 0 and target.height > 0:
      GC_fullCollect()
      decodeJpegScaledInto(data, target)
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

proc readImageWithFallback*(path: string): Image =
  if useImageMagick():
    let converted = readImageWithImageMagick(path)
    if converted.isSome:
      return converted.get()
  return readImage(path)

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
  let decodedData =
    if isBase64:
      dataBody.decode
    else:
      decodeUrl(dataBody)
  return decodeImageWithFallback(decodedData)

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
  when defined(frameosEmbedded):
    if not target.isNil and decodedData.len > 0:
      return decodeImageWithFallback(decodedData, target)
  return decodeImageWithFallback(decodedData)

proc proxiedImageUrl*(url: string, proxyBaseUrl = ""): string =
  let proxy = proxyBaseUrl.strip()
  if proxy.len > 0 and (url.startsWith("http://") or url.startsWith("https://")):
    return proxy & "?url=" & encodeUrl(url)
  url

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

  proc downloadImageFromBuffer(url: string, maxBytes: int, proxyBaseUrl = "", target: Image = nil,
      headers: seq[SimpleHttpHeader] = @[]):
      tuple[image: Image, data: string] =
    let directUrl = embeddedSizedRemoteImageUrl(url, target)
    let fallbackUrl = proxiedImageUrl(directUrl, proxyBaseUrl)
    try:
      return downloadImageFromResolvedBuffer(directUrl, maxBytes, target, headers)
    except CatchableError:
      if fallbackUrl != directUrl:
        try:
          return downloadImageFromResolvedBuffer(fallbackUrl, maxBytes, target, headers)
        except CatchableError as proxyError:
          raise proxyError
      raise

proc downloadImage*(url: string, maxBytes = MaxImageDownloadBytes, proxyBaseUrl = "",
    headers: seq[SimpleHttpHeader] = @[]): Image =
  if url.startsWith("data:"):
    return decodeDataUrl(url)
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, proxyBaseUrl, headers = headers).image
  else:
    let response = boundedRequestWithHeaders(proxiedImageUrl(url, proxyBaseUrl),
      headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    let content = response.body
    result = decodeImageWithFallback(content)

proc downloadImageWithData*(url: string, maxBytes = MaxImageDownloadBytes,
    proxyBaseUrl = "", headers: seq[SimpleHttpHeader] = @[]): tuple[image: Image, data: string] =
  if url.startsWith("data:"):
    let image = decodeDataUrl(url)
    return (image, "")
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, proxyBaseUrl, headers = headers)
  else:
    let response = boundedRequestWithHeaders(proxiedImageUrl(url, proxyBaseUrl),
      headers = headers, maxBytes = maxBytes)
    if response.code >= 400:
      raise newException(IOError, response.status)
    let content = response.body
    result = (decodeImageWithFallback(content), content)

proc downloadImageInto*(url: string, target: Image, maxBytes = MaxImageDownloadBytes,
    proxyBaseUrl = "", headers: seq[SimpleHttpHeader] = @[]): Image =
  if url.startsWith("data:"):
    return decodeDataUrlInto(url, target)
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, proxyBaseUrl, target, headers).image
  else:
    return downloadImage(url, maxBytes = maxBytes, proxyBaseUrl = proxyBaseUrl, headers = headers)

proc downloadImageWithDataInto*(url: string, target: Image, maxBytes = MaxImageDownloadBytes,
    proxyBaseUrl = "", headers: seq[SimpleHttpHeader] = @[]): tuple[image: Image, data: string] =
  if url.startsWith("data:"):
    return (decodeDataUrlInto(url, target), "")
  when defined(frameosEmbedded):
    return downloadImageFromBuffer(url, maxBytes, proxyBaseUrl, target, headers)
  else:
    return downloadImageWithData(url, maxBytes = maxBytes, proxyBaseUrl = proxyBaseUrl, headers = headers)

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

proc writeError*(image: Image, width, height: int, message: string) =
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
  when not defined(frameosEmbedded):
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

proc renderError*(width, height: int, message: string): Image =
  when defined(frameosEmbedded):
    GC_fullCollect()
  result = newImage(width, height)
  result.fill(parseHtmlColor("#ffffff"))
  writeError(result, width, height, message)

proc scaleAndDrawImage*(targetImage: Image, srcImage: Image, scalingMode: string, offsetX: int = 0,
    offsetY: int = 0, blendMode: BlendMode = OverwriteBlend) {.raises: [PixieError].} =
  if srcImage.width == targetImage.width and srcImage.height ==
      targetImage.height:
    if offsetX != 0 or offsetY != 0:
      targetImage.draw(srcImage, translate(vec2(offsetX.float32, offsetY.float32)), blendMode)
    else:
      targetImage.draw(srcImage, blendMode = blendMode)
  else:
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
