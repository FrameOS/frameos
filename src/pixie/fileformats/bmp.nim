import bitops, chroma, flatty/binny, ../common, ../decodebudget, ../images

# See: https://en.wikipedia.org/wiki/BMP_file_format
# See: https://bmptestsuite.sourceforge.io/
# https://docs.microsoft.com/en-us/windows/win32/gdi/bitmap-header-types
# https://stackoverflow.com/questions/61788908/windows-clipboard-getclipboarddata-for-cf-dibv5-causes-the-image-on-the-clip
# https://stackoverflow.com/questions/44177115/copying-from-and-to-clipboard-loses-image-transparency/46424800#46424800

const
  bmpSignature* = "BM"
  LCS_sRGB = 0x73524742
  bmpStreamReadBytes = 16384

template failInvalid() =
  raise newException(PixieError, "Invalid BMP buffer, unable to load")

proc colorMaskShift(color, mask: uint32): uint8 {.inline.} =
  ((color and mask) shr (mask.firstSetBit() - 1)).uint8

type BmpHeader = object
  ## Parsed DIB header, palette and pixel-data layout.
  width, height: int # Height is always positive, see topDown
  bits, compression: int
  redMask, greenMask, blueMask, alphaMask: uint32
  useAlpha: bool
  topDown: bool # Pixel rows are stored top to bottom instead of bottom up
  palette: seq[ColorRGBA]
  startOffset: int # First pixel byte, relative to the DIB start
  rawRowBytes: int # Pixel bytes per row, before padding
  rowStride: int   # Bytes per row including padding to 4-byte alignment

proc parseBmpHeader(
  data: ptr UncheckedArray[uint8], len: int, lpBitmapInfo = false
): BmpHeader {.raises: [PixieError].} =
  ## Validates the DIB header and reads everything up to the pixel data.
  if len < 40:
    failInvalid()

  # BITMAPINFOHEADER
  var
    headerSize = data.readInt32(0).int
    width = data.readInt32(4).int
    height = data.readInt32(8).int
    planes = data.readUint16(12).int
    bits = data.readUint16(14).int
    compression = data.readInt32(16).int
    colorPaletteSize = data.readInt32(32).int

  if headerSize notin [40, 108, 124]:
    failInvalid()

  if planes != 1:
    failInvalid()

  if bits notin [1, 4, 8, 24, 32]:
    raise newException(PixieError, "Unsupported BMP bit count")

  if compression notin [0, 3]:
    raise newException(PixieError, "Unsupported BMP compression format")

  result.redMask = 0x00FF0000.uint32
  result.greenMask = 0x0000FF00.uint32
  result.blueMask = 0x000000FF.uint32
  result.alphaMask = 0xFF000000.uint32

  if compression == 3:
    if len < 52:
      failInvalid()

    result.redMask = data.readUInt32(40)
    result.greenMask = data.readUInt32(44)
    result.blueMask = data.readUInt32(48)

    if result.redMask == 0 or result.blueMask == 0 or result.greenMask == 0:
      failInvalid()

  if headerSize > 40:
    if len < 56:
      failInvalid()

    result.alphaMask = data.readUInt32(52)

    result.useAlpha = result.alphaMask != 0

  if colorPaletteSize < 0 or colorPaletteSize > 256:
    failInvalid()

  if bits in [1, 4, 8] and colorPaletteSize == 0:
    colorPaletteSize = 1 shl bits

  result.palette = newSeq[ColorRGBA](colorPaletteSize)
  if colorPaletteSize > 0:
    if len < headerSize + colorPaletteSize * 4:
      failInvalid()

    var offset = headerSize
    for i in 0 ..< colorPaletteSize:
      var rgba: ColorRGBA
      if offset + 3 > len - 2:
        failInvalid()
      rgba.r = data[offset + 2]
      rgba.g = data[offset + 1]
      rgba.b = data[offset + 0]
      rgba.a = 255
      offset += 4
      result.palette[i] = rgba

  if height < 0:
    height = -height
    result.topDown = true

  result.width = width
  result.height = height
  result.bits = bits
  result.compression = compression

  result.startOffset = headerSize + colorPaletteSize * 4
  if compression == 3 and (headerSize == 40 or lpBitmapInfo):
    result.startOffset += 12

  result.rawRowBytes = (width * bits + 7) div 8
  result.rowStride = ((width * bits + 31) div 32) * 4

proc checkDecodeBudget(header: BmpHeader, planBytes: int64) =
  if overDecodeBudget(planBytes):
    raise newException(PixieError,
      "BMP decode of " & $header.width & "x" & $header.height &
      " needs " & $(planBytes div 1024) &
      "K of decode buffers, over the " &
      $(decodeBudgetBytes() div 1024) & "K memory budget"
    )

proc checkFullDecodeBudget(header: BmpHeader) =
  ## A full decode holds the whole pixel seq plus one row of RGBX pixels.
  checkDecodeBudget(header,
    header.width.int64 * header.height.int64 * 4 + header.width.int64 * 4)

proc bmpRowToPixels(
  header: BmpHeader, row: openArray[uint8], dst: var seq[ColorRGBX]
) {.raises: [PixieError].} =
  ## Converts one row of raw BMP pixel bytes into RGBX pixels.
  case header.bits:
  of 1:
    if header.palette.len < 2:
      failInvalid()
    var
      haveBits = 0
      colorBits: uint8 = 0
      offset = 0
    for x in 0 ..< header.width:
      var rgba: ColorRGBA
      if haveBits == 0:
        colorBits = row[offset]
        haveBits = 8
        inc offset
      if (colorBits and 0b1000_0000) == 0:
        rgba = header.palette[0]
      else:
        rgba = header.palette[1]
      colorBits = colorBits shl 1
      dec haveBits
      dst[x] = rgba.rgbx()

  of 4:
    var
      haveBits = 0
      colorBits: uint8 = 0
      offset = 0
    for x in 0 ..< header.width:
      if haveBits == 0:
        colorBits = row[offset]
        haveBits = 8
        inc offset
      let index = (colorBits and 0b1111_0000) shr 4
      if index.int >= header.palette.len:
        failInvalid()
      colorBits = colorBits shl 4
      haveBits -= 4
      dst[x] = header.palette[index].rgbx()

  of 8:
    for x in 0 ..< header.width:
      let index = row[x]
      if index.int >= header.palette.len:
        failInvalid()
      dst[x] = header.palette[index].rgbx()

  of 24:
    for x in 0 ..< header.width:
      var rgba: ColorRGBA
      rgba.r = row[x * 3 + 2]
      rgba.g = row[x * 3 + 1]
      rgba.b = row[x * 3 + 0]
      rgba.a = 255
      dst[x] = rgba.rgbx()

  of 32:
    for x in 0 ..< header.width:
      let color = row[x * 4 + 0].uint32 or
        (row[x * 4 + 1].uint32 shl 8) or
        (row[x * 4 + 2].uint32 shl 16) or
        (row[x * 4 + 3].uint32 shl 24)
      if header.useAlpha:
        var rgbx: ColorRGBX
        rgbx.r = color.colorMaskShift(header.redMask)
        rgbx.g = color.colorMaskShift(header.greenMask)
        rgbx.b = color.colorMaskShift(header.blueMask)
        rgbx.a = color.colorMaskShift(header.alphaMask)
        dst[x] = rgbx
      else:
        var rgba: ColorRGBA
        rgba.r = color.colorMaskShift(header.redMask)
        rgba.g = color.colorMaskShift(header.greenMask)
        rgba.b = color.colorMaskShift(header.blueMask)
        rgba.a = 255
        dst[x] = rgba.rgbx()

  else:
    failInvalid()

proc decodeDib*(
  data: pointer, len: int, lpBitmapInfo = false
): Image {.raises: [PixieError].} =
  ## Decodes DIB data into an image.
  let data = cast[ptr UncheckedArray[uint8]](data)
  let header = parseBmpHeader(data, len, lpBitmapInfo)

  checkFullDecodeBudget(header)

  result = newImage(header.width, header.height)

  var rowPixels = newSeq[ColorRGBX](header.width)
  for fileY in 0 ..< header.height:
    let rowStart = header.startOffset + fileY * header.rowStride
    if rowStart + header.rawRowBytes > len:
      failInvalid()
    bmpRowToPixels(
      header,
      data.toOpenArray(rowStart, rowStart + header.rawRowBytes - 1),
      rowPixels
    )
    let imageY =
      if header.topDown:
        fileY
      else:
        header.height - fileY - 1
    copyMem(
      result.data[imageY * header.width].addr,
      rowPixels[0].addr,
      header.width * sizeof(ColorRGBX)
    )

proc decodeBmp*(data: string): Image {.raises: [PixieError].} =
  ## Decodes bitmap data into an image.
  if data.len < 15: # decodeDib needs at least one byte to take the address of
    failInvalid()

  # BMP Header
  if data[0 .. 1] != "BM":
    failInvalid()

  decodeDib(data[14].unsafeAddr, data.len - 14)

proc decodeBmpDimensions*(
  data: pointer, len: int
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes the BMP dimensions.
  if len < 26:
    failInvalid()

  let data = cast[ptr UncheckedArray[uint8]](data)

  # BMP Header
  if data[0].char != 'B' or data[1].char != 'M': # Must start with BM
    failInvalid()

  result.width = data.readInt32(18).int
  result.height = abs(data.readInt32(22)).int

proc decodeBmpDimensions*(
  data: string
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes the BMP dimensions.
  decodeBmpDimensions(data.cstring, data.len)

proc validateScaledBmpTarget(width, height: int) {.raises: [PixieError].} =
  if width <= 0 or width > int32.high.int:
    raise newException(PixieError, "Invalid BMP target width")
  if height <= 0 or height > int32.high.int:
    raise newException(PixieError, "Invalid BMP target height")

proc validateScaledBmpTarget(target: Image) {.raises: [PixieError].} =
  if target.isNil:
    raise newException(PixieError, "Invalid BMP target Image")
  validateScaledBmpTarget(target.width, target.height)

type BmpRowRead = proc(
  dst: ptr UncheckedArray[uint8], skip: bool
) {.gcsafe, raises: [PixieError].}
  ## Provides the next pixel row in file order: fill `dst` with rawRowBytes
  ## bytes, or just advance past the row when `skip` is true. Never called
  ## for rows after the last one the target samples.

proc decodeBmpScaledIntoStreaming(
  header: BmpHeader,
  target: Image,
  fit: ScaledDecodeFit,
  readRow: BmpRowRead
) {.raises: [PixieError].} =
  ## Folds pixel rows into the target as they arrive in file order, through
  ## the shared row box sampler: downscales are area filtered instead of
  ## nearest-decimated, 1:1 and upscale axes stay byte-identical to the
  ## nearest pick this replaced. Bottom-up files feed the sampler in
  ## descending image order, which it accepts — footprint rows stay
  ## contiguous either way. Peak memory: one raw row, one row of RGBX
  ## pixels, two target-width accumulator rows.
  if header.width <= 0 or header.height <= 0:
    failInvalid()

  checkDecodeBudget(header,
    header.rowStride.int64 + header.width.int64 * 4 + bmpStreamReadBytes +
    target.width.int64 * 4 * 8 * 2)

  var
    rowBytes = newSeq[uint8](header.rawRowBytes)
    rowPixels = newSeq[ColorRGBX](header.width)
    sampler = initRowBoxSampler(
      header.width, header.height, target.width, target.height, fit)
  let rowBytesPtr = cast[ptr UncheckedArray[uint8]](rowBytes[0].addr)

  for fileY in 0 ..< header.height:
    let imageY = if header.topDown: fileY else: header.height - fileY - 1
    let needed = sampler.wantsRow(imageY)
    readRow(rowBytesPtr, not needed)
    if not needed:
      continue # Outside the fitted crop; skip the pixel conversion too
    bmpRowToPixels(header, rowBytes, rowPixels)
    sampler.feedRow(target, imageY, rowPixels)
  sampler.finish(target)

proc decodeDibScaledInto(
  data: ptr UncheckedArray[uint8], len: int, target: Image,
  fit: ScaledDecodeFit
) {.raises: [PixieError].} =
  ## The streaming scaled decode over DIB data resident in memory.
  let header = parseBmpHeader(data, len)
  var fileY = 0
  decodeBmpScaledIntoStreaming(header, target, fit,
    proc (dst: ptr UncheckedArray[uint8], skip: bool) {.
      gcsafe, raises: [PixieError]
    .} =
      if not skip:
        let rowStart = header.startOffset + fileY * header.rowStride
        if rowStart + header.rawRowBytes > len:
          failInvalid()
        copyMem(dst, data[rowStart].addr, header.rawRowBytes)
      inc fileY
  )

proc decodeBmpScaledInto*(
  data: pointer, len: int, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes the BMP data into an existing Image. With fitContain, pixels
  ## outside the fitted rectangle keep their current contents.
  validateScaledBmpTarget(target)
  if len < 14:
    failInvalid()
  let data = cast[ptr UncheckedArray[uint8]](data)

  # BMP Header
  if data[0].char != 'B' or data[1].char != 'M':
    failInvalid()

  decodeDibScaledInto(
    cast[ptr UncheckedArray[uint8]](data[14].addr), len - 14, target, fit
  )

proc decodeBmpScaled*(
  data: pointer, len, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Decodes the BMP data into an Image scaled to the requested dimensions.
  validateScaledBmpTarget(width, height)
  result = newImage(width, height)
  decodeBmpScaledInto(data, len, result, fit)

proc decodeBmpScaled*(
  data: string, width, height: int, fit = fitStretch
): Image {.inline, raises: [PixieError].} =
  ## Decodes the BMP data into an Image scaled to the requested dimensions.
  decodeBmpScaled(data.cstring, data.len, width, height, fit)

proc decodeBmpScaledInto*(
  data: string, target: Image, fit = fitStretch
) {.inline, raises: [PixieError].} =
  ## Decodes the BMP data into an existing Image.
  decodeBmpScaledInto(data.cstring, data.len, target, fit)

proc decodeBmpScaled*(
  data: var string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Decodes the BMP data into a scaled Image and releases the source string
  ## afterwards. The streamed decode never holds a full-size pixel buffer,
  ## so releasing the source early no longer matters; it is freed on return
  ## for callers that rely on it.
  result = decodeBmpScaled(data.cstring, data.len, width, height, fit)
  data = ""
  try:
    GC_fullCollect()
  except Exception:
    discard

proc decodeBmpScaledInto*(
  data: var string, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes the BMP data into an existing Image and releases the source
  ## string afterwards.
  decodeBmpScaledInto(data.cstring, data.len, target, fit)
  data = ""
  try:
    GC_fullCollect()
  except Exception:
    discard

# ------------------------------------------------------------------------
# Pull sources: decode a BMP read sequentially from a callback (e.g. a
# download spilled to disk on a device without the memory to buffer it).
# Peak memory is one small read buffer plus the row buffers; the file is
# never held in memory.

type BmpStreamReader = object
  source: ImageSourceProc
  totalLen: int # <= 0 when unknown
  pos: int

proc readExact(
  r: var BmpStreamReader, dst: ptr UncheckedArray[uint8], len: int
) {.raises: [PixieError].} =
  var done = 0
  while done < len:
    let got = r.source(dst[done].addr, len - done)
    if got <= 0:
      failInvalid()
    done += got
    r.pos += got

proc skipBytes(
  r: var BmpStreamReader, len: int, buffer: var seq[uint8]
) {.raises: [PixieError].} =
  var remaining = len
  while remaining > 0:
    let take = min(remaining, buffer.len)
    r.readExact(cast[ptr UncheckedArray[uint8]](buffer[0].addr), take)
    remaining -= take

proc decodeBmpStreamScaledInto*(
  source: ImageSourceProc, totalLen: int, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes a BMP pulled sequentially from `source` (e.g. a file on disk)
  ## into an existing Image, sampling pixel rows as they are read. Peak
  ## memory: one small read buffer plus one raw row and one row of RGBX
  ## pixels — the file is never resident. On downscales, rows no target row
  ## samples are skipped without conversion, and reading stops after the
  ## last sampled row. Pass the input size as totalLen for bounds checks,
  ## or <= 0 when unknown.
  validateScaledBmpTarget(target)
  if source == nil:
    failInvalid()

  var
    r = BmpStreamReader(source: source, totalLen: totalLen)
    buffer = newSeq[uint8](bmpStreamReadBytes)

  # BMP Header: "BM", file size, reserved fields and the pixel data offset,
  # which the buffered path ignores in favor of the DIB layout.
  var fileHeader: array[14, uint8]
  r.readExact(cast[ptr UncheckedArray[uint8]](fileHeader[0].addr), 14)
  if fileHeader[0].char != 'B' or fileHeader[1].char != 'M':
    failInvalid()

  # Read the DIB header size first so the rest of the header can follow.
  var sizeBytes: array[4, uint8]
  r.readExact(cast[ptr UncheckedArray[uint8]](sizeBytes[0].addr), 4)
  let headerSize =
    cast[ptr UncheckedArray[uint8]](sizeBytes[0].addr).readInt32(0).int
  if headerSize notin [40, 108, 124]:
    failInvalid()

  var dib = newSeq[uint8](headerSize)
  copyMem(dib[0].addr, sizeBytes[0].addr, 4)
  r.readExact(cast[ptr UncheckedArray[uint8]](dib[4].addr), headerSize - 4)

  # Everything between the DIB header and the pixel data (the palette and,
  # for 40-byte bitfields headers, the mask block) gets buffered too, so
  # parseBmpHeader sees the same bytes as the buffered path. Its palette
  # size defaulting must be replicated to know how many bytes that is.
  let
    dibPtr = cast[ptr UncheckedArray[uint8]](dib[0].addr)
    bits = dibPtr.readUint16(14).int
    compression = dibPtr.readInt32(16).int
  var colorPaletteSize = dibPtr.readInt32(32).int
  if colorPaletteSize < 0 or colorPaletteSize > 256:
    failInvalid()
  if bits in [1, 4, 8] and colorPaletteSize == 0:
    colorPaletteSize = 1 shl bits

  var trailing = colorPaletteSize * 4
  if compression == 3 and headerSize == 40:
    trailing += 12

  # Two spare zero bytes: parseBmpHeader's palette bounds check requires
  # them and they are never read as data.
  dib.setLen(headerSize + trailing + 2)
  if trailing > 0:
    r.readExact(
      cast[ptr UncheckedArray[uint8]](dib[headerSize].addr), trailing
    )

  let header = parseBmpHeader(
    cast[ptr UncheckedArray[uint8]](dib[0].addr), dib.len
  )
  if header.width <= 0 or header.height <= 0:
    failInvalid()

  # The reader is now positioned exactly at the first pixel byte.
  if r.totalLen > 0:
    let needed = 14.int64 + header.startOffset.int64 +
      (header.height - 1).int64 * header.rowStride.int64 +
      header.rawRowBytes.int64
    if needed > r.totalLen.int64:
      failInvalid()

  var fileY = 0
  let lastFileY = header.height - 1
  decodeBmpScaledIntoStreaming(header, target, fit,
    proc (dst: ptr UncheckedArray[uint8], skip: bool) {.
      gcsafe, raises: [PixieError]
    .} =
      if skip:
        r.skipBytes(header.rowStride, buffer)
      else:
        r.readExact(dst, header.rawRowBytes)
        if fileY < lastFileY:
          # The last row's padding may be absent, but it is also never
          # followed by another read, so skip padding on earlier rows only.
          r.skipBytes(header.rowStride - header.rawRowBytes, buffer)
      inc fileY
  )

proc encodeDib*(image: Image): string {.raises: [].} =
  ## Encodes an image into a DIB.

  # BITMAPINFO containing BITMAPV5HEADER
  result.addUint32(124) # Size of this header
  result.addInt32(image.width.int32) # Signed integer
  result.addInt32(image.height.int32) # Signed integer
  result.addUint16(1) # Must be 1 (color planes)
  result.addUint16(32) # Bits per pixels, only support RGBA
  result.addUint32(3) # BI_BITFIELDS, no pixel array compression used
  result.addUint32(32) # Size of the raw bitmap data (including padding)
  result.addUint32(2835) # Print resolution of the image
  result.addUint32(2835) # Print resolution of the image
  result.addUint32(0) # Number of colors in the palette
  result.addUint32(0) # 0 means all colors are important
  result.addUint32(uint32(0x000000FF)) # Red channel
  result.addUint32(uint32(0x0000FF00)) # Green channel
  result.addUint32(uint32(0x00FF0000)) # Blue channel
  result.addUint32(uint32(0xFF000000)) # Alpha channel
  result.addUint32(LCS_sRGB) # Color space
  result.setLen(result.len + 64) # Unused
  result.addUint32(0) # BITMAPINFO bmiColors 0
  result.addUint32(0) # BITMAPINFO bmiColors 1
  result.addUint32(0) # BITMAPINFO bmiColors 2

  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      let rgba = image[x, image.height - y - 1].rgba()
      result.addUint32(cast[uint32](rgba))

proc encodeBmp*(image: Image): string {.raises: [].} =
  ## Encodes an image into the BMP file format.

  # BMP Header
  result.add("BM") # The header field used to identify the BMP
  result.addUint32(0) # The size of the BMP file in bytes
  result.addUint16(0) # Reserved
  result.addUint16(0) # Reserved
  result.addUint32(14 + 12 + 124) # The offset to the pixel array

  # DIB
  result.add(encodeDib(image))

  result.writeUint32(2, result.len.uint32)
