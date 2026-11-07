import chroma, flatty/binny, ../common, ../decodebudget, ../images,
  std/strutils

# See: http://netpbm.sourceforge.net/doc/ppm.html

const ppmSignatures* = @["P3", "P6"]

type
  PpmHeader = object
    version: string
    width, height, maxVal, dataOffset: int

template failInvalid() =
  raise newException(PixieError, "Invalid PPM data")

proc decodeHeader(
  data: ptr UncheckedArray[uint8], len: int
): PpmHeader {.raises: [PixieError].} =
  var
    commentMode, readWhitespace: bool
    i, readFields: int
    field: string
  while readFields < 4:
    if i >= len:
      raise newException(PixieError, "Invalid PPM file header")
    let c = data[i].char
    if c == '#':
      commentMode = true
    elif c == '\n':
      commentMode = false
    if not commentMode:
      if c in Whitespace and not readWhitespace:
        inc readFields
        readWhitespace = true
        try:
          case readFields:
            of 1:
              result.version = field
            of 2:
              result.width = parseInt(field)
            of 3:
              result.height = parseInt(field)
            of 4:
              result.maxVal = parseInt(field)
            else:
              discard
        except ValueError:
          failInvalid()
        field = ""
      elif not (c in Whitespace):
        field.add(c)
        readWhitespace = false
    inc i

    result.dataOffset = i

proc decodeP6Data(
  data: string, maxVal: int
): seq[ColorRGBX] {.raises: [PixieError].} =
  let needsUint16 = maxVal > 0xFF
  let bytesPerPixel =
    if needsUint16:
      6
    else:
      3

  if data.len mod bytesPerPixel != 0:
    failInvalid()

  result = newSeq[ColorRGBX](data.len div bytesPerPixel)

  # Let's calculate the real maximum value multiplier.
  # rgbx() accepts a maximum value of 255. Most of the time,
  # maxVal is set to 255 as well, so in most cases it is 1
  let valueMultiplier = (255 / maxVal).float32

  # if comparison in for loops is expensive, so let's unroll it
  if not needsUint16:
    for i in 0 ..< result.len:
      let
        red = data.readUint8(i + (i * 2)).float32
        green = data.readUint8(i + 1 + (i * 2)).float32
        blue = data.readUint8(i + 2 + (i * 2)).float32
      result[i] = rgbx(
        (red * valueMultiplier + 0.5).uint8,
        (green * valueMultiplier + 0.5).uint8,
        (blue * valueMultiplier + 0.5).uint8,
        255
      )
  else:
    for i in 0 ..< result.len:
      let
        red = data.readUint16(i + (i * 5)).swap.float32
        green = data.readUint16(i + 2 + (i * 5)).swap.float32
        blue = data.readUint16(i + 4 + (i * 5)).swap.float32
      result[i] = rgbx(
        (red * valueMultiplier + 0.5).uint8,
        (green * valueMultiplier + 0.5).uint8,
        (blue * valueMultiplier + 0.5).uint8,
        255
      )

proc decodeP3Data(data: string, maxVal: int): seq[ColorRGBX] {.raises: [PixieError].} =
  let
    needsUint16 = maxVal > 0xFF
    maxLen =
      if needsUint16:
        data.splitWhitespace.len * 2
      else:
        data.splitWhitespace.len

  var p6data = newStringOfCap(maxLen)
  try:
    if not needsUint16:
      for line in data.splitLines():
        for sample in line.split('#', 1)[0].splitWhitespace():
          p6data.add(parseInt(sample).char)
    else:
      for line in data.splitLines():
        for sample in line.split('#', 1)[0].splitWhitespace():
          p6data.addUint16(parseInt(sample).uint16.swap)
  except ValueError:
    failInvalid()

  result = decodeP6Data(p6data, maxVal)

proc decodePpm*(data: string): Image {.raises: [PixieError].} =
  ## Decodes Portable Pixel Map data into an Image.

  let header = decodeHeader(
    cast[ptr UncheckedArray[uint8]](data.cstring),
    data.len
  )

  if not (header.version in ppmSignatures):
    failInvalid()

  if header.maxVal <= 0 or header.maxVal > 0xFFFF:
    failInvalid()

  var pixels =
    if header.version == "P3":
      decodeP3Data(data[header.dataOffset .. ^1], header.maxVal)
    else:
      decodeP6Data(data[header.dataOffset .. ^1], header.maxVal)
  if pixels.len != header.width * header.height:
    failInvalid()
  result = newImageFrom(header.width, header.height, move pixels)

proc decodePpmDimensions*(
  data: pointer, len: int
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes the PPM dimensions.
  let
    data = cast[ptr UncheckedArray[uint8]](data)
    header = decodeHeader(data, len)
  result.width = header.width
  result.height = header.height

proc decodePpmDimensions*(
  data: string
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes the PPM dimensions.
  decodePpmDimensions(data.cstring, data.len)

proc validateScaledPpmTarget(width, height: int) {.raises: [PixieError].} =
  if width <= 0 or width > int32.high.int:
    raise newException(PixieError, "Invalid PPM target width")
  if height <= 0 or height > int32.high.int:
    raise newException(PixieError, "Invalid PPM target height")

proc checkDecodeBudget(header: PpmHeader, planBytes: int64) =
  if overDecodeBudget(planBytes):
    raise newException(PixieError,
      "PPM decode of " & $header.width & "x" & $header.height &
      " needs " & $(planBytes div 1024) &
      "K of decode buffers, over the " &
      $(decodeBudgetBytes() div 1024) & "K memory budget"
    )

proc decodePpmStreamScaledInto*(
  source: ImageSourceProc, totalLen: int, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes a P6 PPM pulled sequentially from `source` (e.g. a file on
  ## disk) into an existing Image, sampling pixel rows as they are read.
  ## Peak memory: one raw row plus one row of RGBX pixels — the file is
  ## never resident. Rows no target row samples are skipped without
  ## conversion. P3 (ASCII) PPMs raise a PixieError since they need the
  ## whole-file buffering this decoder exists to avoid. Pass the input size
  ## as totalLen for payload size checks, or <= 0 when unknown.
  if target.isNil:
    raise newException(PixieError, "Invalid PPM target Image")
  validateScaledPpmTarget(target.width, target.height)
  if source == nil:
    failInvalid()

  # The header parse mirrors decodeHeader, pulling one byte at a time so
  # the reader stops exactly at the first payload byte.
  var
    header: PpmHeader
    commentMode, readWhitespace: bool
    readFields: int
    field: string
  while readFields < 4:
    var c: char
    if source(c.addr, 1) != 1:
      raise newException(PixieError, "Invalid PPM file header")
    inc header.dataOffset
    if c == '#':
      commentMode = true
    elif c == '\n':
      commentMode = false
    if not commentMode:
      if c in Whitespace and not readWhitespace:
        inc readFields
        readWhitespace = true
        try:
          case readFields:
            of 1:
              header.version = field
            of 2:
              header.width = parseInt(field)
            of 3:
              header.height = parseInt(field)
            of 4:
              header.maxVal = parseInt(field)
            else:
              discard
        except ValueError:
          failInvalid()
        field = ""
      elif not (c in Whitespace):
        field.add(c)
        readWhitespace = false

  if not (header.version in ppmSignatures):
    failInvalid()

  if header.version == "P3":
    raise newException(PixieError,
      "Streamed PPM decode supports the binary P6 format only"
    )

  if header.maxVal <= 0 or header.maxVal > 0xFFFF:
    failInvalid()

  if header.width <= 0 or header.height <= 0:
    failInvalid()

  let
    bytesPerPixel = if header.maxVal > 0xFF: 6 else: 3
    rowBytesLen = header.width * bytesPerPixel

  # The buffered decoder requires the payload to be exactly one image large
  if totalLen > 0 and totalLen.int64 - header.dataOffset.int64 !=
      header.width.int64 * header.height.int64 * bytesPerPixel.int64:
    failInvalid()

  checkDecodeBudget(header, rowBytesLen.int64 + header.width.int64 * 4 +
    target.width.int64 * 4 * 8 * 2)

  # See decodeP6Data for the maxVal multiplier reasoning
  let valueMultiplier = (255 / header.maxVal).float32

  var
    rowBytes = newSeq[uint8](rowBytesLen)
    rowPixels = newSeq[ColorRGBX](header.width)
    sampler = initRowBoxSampler(
      header.width, header.height, target.width, target.height, fit)

  for fileY in 0 ..< header.height:
    # Skipped rows still consume their bytes to keep the reads sequential
    var done = 0
    while done < rowBytesLen:
      let got = source(rowBytes[done].addr, rowBytesLen - done)
      if got <= 0:
        failInvalid()
      done += got

    if not sampler.wantsRow(fileY):
      continue # Outside the fitted crop; skip the pixel conversion too

    if header.maxVal > 0xFF:
      for x in 0 ..< header.width:
        let
          red = ((rowBytes[x * 6 + 0].uint16 shl 8) or
            rowBytes[x * 6 + 1].uint16).float32
          green = ((rowBytes[x * 6 + 2].uint16 shl 8) or
            rowBytes[x * 6 + 3].uint16).float32
          blue = ((rowBytes[x * 6 + 4].uint16 shl 8) or
            rowBytes[x * 6 + 5].uint16).float32
        rowPixels[x] = rgbx(
          (red * valueMultiplier + 0.5).uint8,
          (green * valueMultiplier + 0.5).uint8,
          (blue * valueMultiplier + 0.5).uint8,
          255
        )
    else:
      for x in 0 ..< header.width:
        let
          red = rowBytes[x * 3 + 0].float32
          green = rowBytes[x * 3 + 1].float32
          blue = rowBytes[x * 3 + 2].float32
        rowPixels[x] = rgbx(
          (red * valueMultiplier + 0.5).uint8,
          (green * valueMultiplier + 0.5).uint8,
          (blue * valueMultiplier + 0.5).uint8,
          255
        )

    sampler.feedRow(target, fileY, rowPixels)
  sampler.finish(target)

proc encodePpm*(image: Image): string {.raises: [].} =
  ## Encodes an image into the PPM file format (version P6).

  # PPM header
  result.add("P6") # The header field used to identify the PPM
  result.add("\n") # Newline
  result.add($image.width)
  result.add(" ") # Space
  result.add($image.height)
  result.add("\n") # Newline
  result.add("255") # Max color value
  result.add("\n") # Newline

  # PPM image data
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      let rgb = image[x, y]
      # Alpha channel is ignored
      result.addUint8(rgb.r)
      result.addUint8(rgb.g)
      result.addUint8(rgb.b)
