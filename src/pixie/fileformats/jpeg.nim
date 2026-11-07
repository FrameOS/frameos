import chroma, flatty/binny, ../common, ../decodebudget, ../images, ../simd,
  std/decls, std/math, std/sequtils, std/strutils

# This JPEG decoder is loosely based on stb_image which is public domain.

# JPEG is a complex format, this decoder only supports the most common features:
# * yCbCr format
# * gray scale format
# * 4:4:4, 4:2:2, 4:1:1, 4:2:0 resampling modes
# * progressive
# * restart markers
# * Exif orientation

# * https://github.com/daviddrysdale/libjpeg
# * https://www.youtube.com/watch?v=Kv1Hiv3ox8I
# * https://www.youtube.com/watch?v=0me3guauqOU
# * https://dev.exiv2.org/projects/exiv2/wiki/The_Metadata_in_JPEG_files
# * https://www.media.mit.edu/pia/Research/deepview/exif.html
# * https://www.ccoderun.ca/programming/2017-01-31_jpeg/
# * http://imrannazar.com/Let%27s-Build-a-JPEG-Decoder%3A-Concepts
# * https://github.com/nothings/stb/blob/master/stb_image.h
# * https://yasoob.me/posts/understanding-and-writing-jpeg-decoder-in-python/
# * https://www.w3.org/Graphics/JPEG/itu-t81.pdf

const
  fastBits = 9
  deZigZag = [
    uint8 00, 01, 08, 16, 09, 02, 03, 10,
    uint8 17, 24, 32, 25, 18, 11, 04, 05,
    uint8 12, 19, 26, 33, 40, 48, 41, 34,
    uint8 27, 20, 13, 06, 07, 14, 21, 28,
    uint8 35, 42, 49, 56, 57, 50, 43, 36,
    uint8 29, 22, 15, 23, 30, 37, 44, 51,
    uint8 58, 59, 52, 45, 38, 31, 39, 46,
    uint8 53, 60, 61, 54, 47, 55, 62, 63
  ]
  bitMasks = [ # (1 shr n) - 1
    0.uint32, 1, 3, 7, 15, 31, 63, 127, 255, 511,
    1023, 2047, 4095, 8191, 16383, 32767, 65535
  ]
  maxMarkerResync = 64
  maxRestartResync = 8192
  jpegStreamWindowSize = 32 * 1024
  jpegStreamKeepBehind = 64

let
  jpegStartOfImage* = [0xFF.uint8, 0xD8]

type
  Huffman = object
    codes: array[256, uint16]
    symbols: array[256, uint8]
    sizes: array[257, uint8]
    deltas: array[17, int]
    maxCodes: array[18, int]
    fast: array[1 shl fastBits, uint8]

  Component = object
    id, quantizationTableId: uint8
    yScale, xScale: int
    width, height: int
    widthStride, heightStride: int
    sampleWidth, sampleHeight: int
    huffmanDC, huffmanAC: int
    dcPred: int
    widthCoeff, heightCoeff: int
    channelWidth, channelHeight: int
    coeff, lineBuf: seq[uint8]
    blocks: seq[seq[array[64, int16]]]
    channel: Mask
    # Scaled-decode box sampler (see idctBlockScaled). Blocks land in a
    # full-width band of source rows; the band drains row by row through
    # accumulators that average each target pixel's exact source footprint.
    # Downscales get a proper area filter instead of nearest decimation;
    # upscale axes keep nearest (boxes would leave target holes); 1:1 axes
    # reduce to the identity, byte for byte.
    bandPixels: seq[uint8]  ## component.width x bandRows source pixels
    bandRows: int           ## 8 * xScale: one MCU row of blocks
    bandIndex: int          ## which band bandPixels holds; -1 = none
    nextSourceY: int        ## first source row the drain has not folded yet
    colCount: seq[uint16]   ## source columns per target column (X box)
    winX0, winX1: int       ## sampled source-column window at this
                            ## component's resolution ([winX0, winX1))
    winY0, winY1: int       ## sampled source-row window
    horizSums: seq[uint32]  ## one source row folded to target width
    rowSums: seq[uint32]    ## vertical accumulator for the target row in flight
    rowSumsTy: int          ## which target row rowSums is accumulating
    rowSumsRows: int        ## source rows folded into rowSums so far
    # A decode straight into a target keeps a ring of channel rows instead
    # of a target-sized plane (see sinkReady): rows are written into the
    # target as soon as every component has them, and a slot is reused
    # once the rows it held are drawn.
    ringRows: int           ## rows the ring holds; 0 = the whole channel
    rowsDone: int           ## channel rows finished, counted from the top
    ringNeedFrom: int       ## the lowest channel row the sink still needs

  JpegSourceProc* = ImageSourceProc
    ## Pull callback for streaming decodes: fill `dst` with up to `maxBytes`
    ## sequential input bytes, returning how many were written (<= 0 on EOF
    ## or read error — the decode then fails with a catchable PixieError).

  DecoderState = object
    buffer: ptr UncheckedArray[uint8]
    len, pos: int
    readProc: JpegSourceProc ## nil = whole input is in `buffer`
    window: seq[uint8]       ## sliding window backing `buffer` when streaming
    windowStart: int         ## absolute input offset of window[0]
    windowLen: int           ## valid bytes in the window
    bitsBuffered: int
    bitBuffer: uint32
    foundSOF: bool
    foundSOS: bool
    imageHeight, imageWidth: int
    progressive: bool
    quantizationTables: array[4, array[64, uint8]]
    ## 0 = DC, 1 = AC. On the heap: eight tables are ~14.5 KB, and a value
    ## DecoderState lives on the caller's stack — on an ESP32 render task
    ## with 40 KB that left ~1.4 KB free after every streamed JPEG.
    huffmanTables: ref array[2, array[4, Huffman]]
    components: seq[Component]
    maxYScale, maxXScale: int
    mcuWidth, mcuHeight, numMcuWide, numMcuHigh: int
    orientation: int
    scanComponents: int
    spectralStart, spectralEnd: int
    successiveApproxLow, successiveApproxHigh: int
    componentOrder: seq[int]
    restartInterval: int
    todoBeforeRestart: int
    eobRun: int
    hitEnd: bool
    streamBaselineBlocks: bool
    scaledTargetWidth, scaledTargetHeight: int
    scaledFit: ScaledDecodeFit
    effectiveWidth, effectiveHeight: int
      ## The oriented sample grid a scaled decode's channels were decoded on
      ## (the fitted resolution, after any budget clamp). fillImage maps
      ## target pixels straight into this grid — one floor mapping, no round
      ## trip through image coordinates.
    winOX, winOY, winOW, winOH: int
      ## The oriented source rectangle that grid samples — the whole source
      ## except for fitCover, where it is the crop: sampling what the fill
      ## will discard would only buy larger channel masks (a 3:2 photo
      ## covered onto a 3:4 panel paid double before this window existed).
    plannedDecodeBytes: int64 ## what the SOF plan check accounted for, so the
                              ## build step can budget its output image on top
    rewindProc: JpegRewindProc ## nil: the stream cannot be read a second time
    stripMcuRows: int ## MCU rows of coefficients resident at once (see
                      ## decodeSOF0); numMcuHigh holds the whole image
    strip: int        ## the strip this pass over the file decodes
    scanIndex: int    ## the scan this pass is in, counted from 0
    scanBookmarks: seq[ScanBookmark] ## per scan: where the next strip starts
    sink: Image       ## the target a scaled decode writes as it goes; nil
                      ## fills an image from whole channel planes at the end
    sinkActive: bool  ## the channels are rings and the sink draws the lines
    sinkGeometry: FillGeometry
    sinkLine: int     ## the next target line (row, or column when the
                      ## orientation transposes) the sink will draw
    sinkLineStep: int ## +1 or -1: lines in the order their grid rows finish
    sinkLinesLeft: int

  FillGeometry = object
    ## Where the target's pixels sample the decoded grid: the fit's crop and
    ## placement in oriented image space, and the grid's extent. fillImage
    ## and the sink share it, so a line drawn early lands on the pixels the
    ## whole fill would have drawn.
    rects: tuple[srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH: int]
    effWidth, effHeight: int
    gridWidth, gridHeight: int
    sampleSrcX, sampleSrcY, sampleSrcW, sampleSrcH: int64
    transposed: bool

  JpegRewindProc* = proc(): bool {.gcsafe, raises: [].}
    ## Puts a streamed source back at its first byte, for a decode that
    ## reads the input more than once (a progressive JPEG in strips).
    ## Answers false when it cannot, and the decode fails catchably.

  ScanBookmark = object
    ## The entropy decoder at a strip boundary inside one scan: enough to
    ## pick the scan up there on the next pass. The bit reader is a byte
    ## offset plus whatever it had already pulled into its buffer; the
    ## rest is the run state a restart marker would reset.
    pos, bitsBuffered: int
    bitBuffer: uint32
    hitEnd: bool
    eobRun, todoBeforeRestart: int
    dcPred: array[4, int]

  Mask = ref object
    ## Mask object that holds mask opacity data.
    width*, height*: int
    data*: seq[uint8]

  UnsafeMask = distinct Mask

var jpegStripMcuRows {.threadvar.}: int

proc setJpegStripMcuRows*(rows: int) {.raises: [].} =
  ## Decodes progressive JPEGs in strips of at most `rows` MCU rows,
  ## whatever the memory budget would allow. 0, the default, lets the budget
  ## decide (decodeSOF0). For tests, and for bounding a pass's work.
  jpegStripMcuRows = max(0, rows)

when defined(release):
  {.push checks: off.}

template failInvalid(reason = "unable to load") =
  ## Throw exception with a reason.
  raise newException(PixieError, "Invalid JPEG, " & reason)

proc orientedDimensions(state: DecoderState): tuple[width, height: int] =
  case state.orientation:
  of 0, 1, 2, 3, 4:
    (state.imageWidth, state.imageHeight)
  of 5, 6, 7, 8:
    (state.imageHeight, state.imageWidth)
  else:
    failInvalid("invalid orientation")

proc sourceCoords(
  state: DecoderState, orientedX, orientedY, width, height: int
): tuple[x, y: int] =
  ## Maps oriented coordinates back to storage order, in whatever grid the
  ## caller is addressing — the image itself, or a scaled decode's sample
  ## grid (`width`/`height` are that grid's storage-order dimensions).
  case state.orientation:
  of 0, 1:
    (orientedX, orientedY)
  of 2:
    (width - orientedX - 1, orientedY)
  of 3:
    (width - orientedX - 1, height - orientedY - 1)
  of 4:
    (orientedX, height - orientedY - 1)
  of 5:
    (orientedY, orientedX)
  of 6:
    (orientedY, height - orientedX - 1)
  of 7:
    (width - orientedY - 1, height - orientedX - 1)
  of 8:
    (width - orientedY - 1, orientedX)
  else:
    failInvalid("invalid orientation")

proc newMask(width, height: int): Mask {.raises: [PixieError].} =
  ## Creates a new mask with the parameter dimensions.
  if width <= 0 or height <= 0:
    raise newException(PixieError, "Mask width and height must be > 0")

  result = Mask()
  result.width = width
  result.height = height
  result.data = newSeq[uint8](width * height)

template dataIndex(mask: Mask, x, y: int): int =
  mask.width * y + x

template unsafe(src: Mask): UnsafeMask =
  cast[UnsafeMask](src)

template `[]`(view: UnsafeMask, x, y: int): uint8 =
  ## Gets a value from (x, y) coordinates.
  ## * No bounds checking *
  ## Make sure that x, y are in bounds.
  ## Failure in the assumptions will case unsafe memory reads.
  cast[Mask](view).data[cast[Mask](view).dataIndex(x, y)]

template `[]=`(view: UnsafeMask, x, y: int, color: uint8) =
  ## Sets a value from (x, y) coordinates.
  ## * No bounds checking *
  ## Make sure that x, y are in bounds.
  ## Failure in the assumptions will case unsafe memory writes.
  cast[Mask](view).data[cast[Mask](view).dataIndex(x, y)] = color

proc scaledCeil(value, scale, divisor: int): int {.inline.} =
  ((value.int64 * scale.int64 + divisor.int64 - 1) div divisor.int64).int

proc ringRowsFor(sampleHeight, windowRows, bandRows: int): int =
  ## Channel rows a sink ring must hold: what one band of source rows can
  ## finish (a box downscale finishes about bandRows * sampleHeight /
  ## windowRows of them, an upscale replicates each source row into
  ## several), twice over, since a band is drained only when the next one
  ## begins, plus the few rows the sink waits on while the subsampled
  ## chroma it interpolates between catches up. Never more than the whole
  ## channel.
  let perBand =
    if sampleHeight <= windowRows:
      (bandRows * sampleHeight + windowRows - 1) div windowRows + 1
    else:
      bandRows * ((sampleHeight + windowRows - 1) div windowRows) + 1
  min(sampleHeight, 2 * perBand + 8)

template channelRow(component: Component, row: int): int =
  ## Where channel row `row` lives: in a ring, its slot.
  (if component.ringRows > 0: row mod component.ringRows else: row)

template channelIndex(component: Component, x, row: int): int =
  component.channel.width * component.channelRow(row) + x

proc claimRingRow(component: var Component, row: int) =
  ## Before writing channel row `row`: its ring slot held row - ringRows,
  ## which the sink must be done with. Sizing keeps it so; this is the
  ## check that a bug there is an error, not a wrong pixel.
  if component.ringRows > 0 and row >= component.ringRows and
      row - component.ringRows >= component.ringNeedFrom:
    failInvalid("channel ring overrun")

# The sink (defined with fillImage, below) is set up by the frame header
# and fed by the scan and IDCT loops.
proc fillGeometry(state: DecoderState, width, height: int): FillGeometry {.raises: [PixieError].}
proc sinkStart(state: var DecoderState) {.raises: [PixieError].}
proc sinkAfterMcuRow(state: var DecoderState) {.raises: [PixieError].}
proc sinkRelease(state: var DecoderState) {.raises: [PixieError].}

proc useScaledChannels(state: DecoderState): bool {.inline.} =
  ## Scaled (target-sized) channel masks are used whenever a scaled decode
  ## was requested — including progressive JPEGs, whose coefficient blocks
  ## must stay source-sized but whose IDCT output can go straight into
  ## target-sized masks.
  state.streamBaselineBlocks and
    state.scaledTargetWidth > 0 and
    state.scaledTargetHeight > 0

proc clampByte(x: int32): uint8 {.inline.} =
  ## Clamp integer into byte range.
  # clamp(x, 0, 0xFF).uint8
  let
    signBit = (cast[uint32](x) shr 31)
    value = cast[uint32](x) and (signBit - 1)
  min(value, 255).uint8

proc ensureBytesSlow(state: var DecoderState, absPos, count: int): bool =
  ## Streaming path of `ensureBytes`: slide the window forward and refill it
  ## from `readProc` so [absPos, absPos+count) becomes resident.
  if absPos < state.windowStart:
    failInvalid("input stream rewound too far")
  let absEnd = absPos + count
  var winEnd = state.windowStart + state.windowLen

  # Drop bytes that can no longer be re-read. Never advance past the
  # stream position (winEnd): readProc is strictly sequential.
  let keepFrom = max(state.windowStart, min(absPos - jpegStreamKeepBehind, winEnd))
  if keepFrom > state.windowStart:
    let keepLen = winEnd - keepFrom
    if keepLen > 0:
      moveMem(state.window[0].addr, state.window[keepFrom - state.windowStart].addr, keepLen)
    state.windowStart = keepFrom
    state.windowLen = keepLen

  # Grow capacity when a single request spans more than the window.
  if absEnd - max(state.windowStart, absPos - jpegStreamKeepBehind) > state.window.len:
    state.window.setLen(absEnd - (absPos - jpegStreamKeepBehind))

  while winEnd < absEnd:
    if state.windowLen == state.window.len:
      # Long forward skip: cycle bytes out of the front of the window.
      let drop = min(state.windowLen, absPos - jpegStreamKeepBehind - state.windowStart)
      if drop <= 0:
        failInvalid("stream window exhausted")
      moveMem(state.window[0].addr, state.window[drop].addr, state.windowLen - drop)
      state.windowStart += drop
      state.windowLen -= drop
    let got = state.readProc(
      state.window[state.windowLen].addr,
      min(state.window.len - state.windowLen, state.len - winEnd)
    )
    if got <= 0:
      return false
    state.windowLen += got
    winEnd += got
  state.buffer = cast[ptr UncheckedArray[uint8]](state.window[0].addr)
  true

proc ensureBytes(state: var DecoderState, absPos, count: int): bool {.inline.} =
  ## Makes input bytes [absPos, absPos+count) addressable through `at`,
  ## returning false when the input ends before that.
  if absPos + count > state.len:
    return false
  if state.readProc == nil or
      (absPos >= state.windowStart and
       absPos + count <= state.windowStart + state.windowLen):
    return true
  ensureBytesSlow(state, absPos, count)

template at(state: DecoderState, absPos: int): uint8 =
  ## Reads the input byte at an absolute offset; call `ensureBytes` first.
  state.buffer[absPos - state.windowStart]

proc seekTo(state: var DecoderState, absPos: int) =
  ## Moves the read position, forward or back. A buffer is addressed; a
  ## stream is read on through to a forward position, and rewound through
  ## `rewindProc` for a backward one, which only a strip decode asks for.
  if state.readProc == nil:
    state.pos = absPos
    return
  if absPos < state.windowStart:
    if state.rewindProc == nil or not state.rewindProc():
      failInvalid("input stream could not be rewound")
    state.windowStart = 0
    state.windowLen = 0
  state.pos = absPos
  if absPos < state.len and not state.ensureBytes(absPos, 1):
    failInvalid("input stream ended early")

proc readUint8(state: var DecoderState): uint8 =
  ## Reads a byte from the input stream.
  if not state.ensureBytes(state.pos, 1):
    failInvalid()
  result = state.at(state.pos)
  inc state.pos

proc readUint16be(state: var DecoderState): uint16 =
  ## Reads uint16 big-endian from the input stream.
  if not state.ensureBytes(state.pos, 2):
    failInvalid()
  result =
    (state.at(state.pos).uint16 shl 8) or
    state.at(state.pos + 1)
  state.pos += 2

proc readUint32be(state: var DecoderState): uint32 =
  ## Reads uint32 big-endian from the input stream.
  if not state.ensureBytes(state.pos, 4):
    failInvalid()
  result =
    (state.at(state.pos + 0).uint32 shl 24) or
    (state.at(state.pos + 1).uint32 shl 16) or
    (state.at(state.pos + 2).uint32 shl 8) or
    state.at(state.pos + 3)
  state.pos += 4

proc readStr(state: var DecoderState, n: int): string =
  ## Reads n number of bytes as a string.
  if not state.ensureBytes(state.pos, n):
    failInvalid()
  result.setLen(n)
  if n > 0:
    copyMem(result[0].addr, state.buffer[state.pos - state.windowStart].addr, n)
  state.pos += n

proc skipBytes(state: var DecoderState, n: int) =
  ## Skips a number of bytes.
  if state.pos + n > state.len:
    if state.foundSOS:
      state.pos = state.len
      return
    failInvalid()
  state.pos += n

proc readMarker(state: var DecoderState): uint8 =
  ## Reads a JPEG marker, resyncing past junk between marker segments.
  var skipped: int
  while true:
    if state.pos >= state.len:
      failInvalid("missing marker")

    let marker = state.readUint8()
    if marker != 0xFF:
      if state.progressive and not state.foundSOS and marker == 0xDA:
        return 0xDA
      inc skipped
      if skipped > maxMarkerResync:
        if state.foundSOS:
          return 0xD9
        failInvalid("invalid chunk marker")
      continue

    while state.ensureBytes(state.pos, 1) and state.at(state.pos) == 0xFF:
      inc state.pos

    if state.pos >= state.len:
      failInvalid("missing marker id")

    result = state.readUint8()
    if result == 0:
      inc skipped
      if skipped > maxMarkerResync:
        if state.foundSOS:
          return 0xD9
        failInvalid("invalid chunk marker")
      continue

    return

proc skipChunk(state: var DecoderState) =
  ## Skips current chunk.
  let len = state.readUint16be() - 2
  state.skipBytes(len.int)

proc decodeDRI(state: var DecoderState) =
  ## Decode Define Restart Interval
  let len = state.readUint16be().int - 2
  if len < 2:
    state.skipBytes(len.int)
    state.restartInterval = 0
    return
  state.restartInterval = state.readUint16be().int
  if len > 2:
    state.skipBytes(len.int - 2)

proc decodeDQT(state: var DecoderState) =
  ## Decode Define Quantization Table(s)
  var len = state.readUint16be().int - 2
  let chunkEnd = state.pos + len
  if chunkEnd > state.len and state.foundSOS:
    state.pos = state.len
    return
  while len > 0:
    let
      info = state.readUint8()
      tableId = info and 15
      precision = info shr 4
    if tableId > 3:
      if state.foundSOS:
        state.pos = min(chunkEnd, state.len)
        return
      failInvalid()
    case precision:
    of 0:
      for i in 0 ..< 64:
        state.quantizationTables[tableId][deZigZag[i]] = state.readUint8()
      len -= 65
    of 1:
      for i in 0 ..< 64:
        let value = state.readUint16be().int
        state.quantizationTables[tableId][deZigZag[i]] = min(value, 255).uint8
      len -= 129
    else:
      if state.foundSOS:
        state.pos = min(chunkEnd, state.len)
        return
      failInvalid("unsupported quantization table precision")
  if len != 0:
    if state.foundSOS:
      state.pos = min(chunkEnd, state.len)
      return
    failInvalid("DQT table length did not match")

proc buildHuffman(huffman: var Huffman, counts: array[16, uint8]) =
  ## Builds the huffman data structure.
  block:
    # JPEG spec page 51
    var k: int
    for i in 0.uint8 ..< 16:
      for j in 0.uint8 ..< counts[i]:
        if k notin 0 ..< 256:
          failInvalid()
        huffman.sizes[k] = i + 1
        inc k
    huffman.sizes[k] = 0

  # JPEG spec page 52
  var code, k: int
  for i in 1.uint8 .. 16:
    huffman.deltas[i] = k - code
    if huffman.sizes[k] == i:
      while huffman.sizes[k] == i:
        huffman.codes[k] = code.uint16
        inc code
        inc k
      if code - 1 >= 1 shl i:
        failInvalid()
    huffman.maxCodes[i] = code shl (16 - i)
    code = code shl 1
  huffman.maxCodes[17] = int.high

  for i in 0 ..< huffman.fast.len:
    huffman.fast[i] = 255

  for i in 0 ..< k:
    let size = huffman.sizes[i]
    if size <= fastBits:
      let fast = huffman.codes[i].int shl (fastBits - size)
      for j in 0 ..< 1 shl (fastBits - size):
        huffman.fast[fast + j] = i.uint8

proc decodeDHT(state: var DecoderState) =
  ## Decode Define Huffman Table
  var len = state.readUint16be().int - 2
  let chunkEnd = state.pos + len
  if chunkEnd > state.len and state.foundSOS:
    state.pos = state.len
    return
  while len > 0:
    let
      info = state.readUint8()
      tableId = info and 15
      tableCurrent = info shr 4 # DC or AC

    if tableCurrent > 1 or tableId > 3:
      if state.foundSOS:
        state.pos = min(chunkEnd, state.len)
        return
      failInvalid()

    var
      counts: array[16, uint8]
      numSymbols: int
    for i in 0 ..< 16:
      counts[i] = state.readUint8()
      numSymbols += counts[i].int
    if numSymbols > 256:
      failInvalid()

    len -= 17

    if state.huffmanTables.isNil:
      new(state.huffmanTables)
    state.huffmanTables[][tableCurrent][tableId] = Huffman()
    state.huffmanTables[][tableCurrent][tableId].buildHuffman(counts)

    for i in 0 ..< numSymbols:
      state.huffmanTables[][tableCurrent][tableId].symbols[i] = state.readUint8()

    len -= numSymbols

  if len != 0:
    if state.foundSOS:
      state.pos = min(chunkEnd, state.len)
      return
    failInvalid()

proc coefficientBytesPerMcuRow(state: DecoderState): int64 =
  ## What one MCU row of resident coefficient blocks costs, every component
  ## counted; 0 when the decode streams its blocks through the IDCT.
  if state.streamBaselineBlocks and not state.progressive:
    return 0
  for component in state.components:
    result += (state.numMcuWide * component.yScale).int64 *
      component.xScale.int64 * 64 * sizeof(int16)

proc outputReserveBytes(state: DecoderState): int64 =
  ## The image buildImage allocates once the decode is done, which the
  ## budget has to hold next to the plan (ensureOutputBudget): the caller's
  ## target size for a scaled decode, the whole image otherwise. A decode
  ## into the caller's target (a sink) allocates none.
  if not state.sink.isNil:
    return 0
  if state.scaledTargetWidth > 0 and state.scaledTargetHeight > 0:
    return state.scaledTargetWidth.int64 * state.scaledTargetHeight.int64 * 4
  state.imageWidth.int64 * state.imageHeight.int64 * 4

proc leastStripMcuRows(state: DecoderState): int =
  ## The fewest MCU rows a strip decode could hold: what the mask plan has
  ## to leave room for before the strip count is known.
  if not state.progressive:
    return state.numMcuHigh
  if jpegStripMcuRows > 0:
    return min(state.numMcuHigh, jpegStripMcuRows)
  1

proc decodeSOF0(state: var DecoderState) =
  ## Decode start of Frame
  if state.foundSOF:
    failInvalid()
  state.foundSOF = true

  var len = state.readUint16be().int - 2

  let precision = state.readUint8()
  if precision != 8:
    failInvalid("unsupported bit depth, must be 8")

  state.imageHeight = state.readUint16be().int
  state.imageWidth = state.readUint16be().int

  if state.imageHeight == 0:
    failInvalid("image invalid 0 height")
  if state.imageWidth == 0:
    failInvalid("image invalid 0 width")

  let numComponentsU8 = state.readUint8()
  let numComponents = numComponentsU8.int
  if numComponentsU8 notin {1'u8, 3}:
    failInvalid("unsupported component count, must be 1 or 3")

  len -= 6

  for i in 0 ..< numComponents:
    var component = Component()
    component.id = state.readUint8()
    let
      info = state.readUint8()
      vertical = info and 15
      horizontal = info shr 4
      quantizationTableId = state.readUint8()

    if quantizationTableId > 3:
      failInvalid("invalid quantization table id")

    if vertical notin {1'u8, 2, 4} or horizontal notin {1'u8, 2, 4}:
      failInvalid("invalid component scaling factor")

    component.xScale = vertical.int
    component.yScale = horizontal.int
    component.quantizationTableId = quantizationTableId
    state.components.add(component)

  len -= 3 * numComponents

  var
    totalBlockBytes: int64
    totalMaskBytes: int64
    largestSingleBytes: int64

  for component in state.components.mitems:
    state.maxXScale = max(state.maxXScale, component.xScale)
    state.maxYScale = max(state.maxYScale, component.yScale)

  state.mcuWidth = state.maxYScale * 8
  state.mcuHeight = state.maxXScale * 8
  state.numMcuWide =
    (state.imageWidth + state.mcuWidth - 1) div state.mcuWidth
  state.numMcuHigh =
    (state.imageHeight + state.mcuHeight - 1) div state.mcuHeight

  var
    effectiveTargetWidth = state.scaledTargetWidth
    effectiveTargetHeight = state.scaledTargetHeight
  # The sampled window: which oriented source rectangle the channels will
  # hold. Everything except a cover crop samples the whole source.
  block:
    let oriented = state.orientedDimensions()
    state.winOX = 0
    state.winOY = 0
    state.winOW = oriented.width
    state.winOH = oriented.height
  if state.useScaledChannels():
    if state.scaledFit == fitCover:
      # Cover discards everything outside the crop, so sample only the crop
      # (same integer math as scaledFitRects, which must land on the same
      # rectangle at fill time). Sampling the whole source at crop density
      # doubled the luma mask for a 3:2 photo covered onto a 3:4 panel — a
      # 6000x4000 into 1200x1600 planned a 2400x1600 (3.7 MB) luma channel
      # where the crop needs 1200x1600 (1.9 MB).
      let oriented = state.orientedDimensions()
      if oriented.width.int64 * effectiveTargetHeight.int64 >
          effectiveTargetWidth.int64 * oriented.height.int64:
        let cropW = max(1, (
          oriented.height.int64 * effectiveTargetWidth.int64 div
          max(1'i64, effectiveTargetHeight.int64)).int)
        state.winOX = (oriented.width - cropW) div 2
        state.winOW = cropW
      else:
        let cropH = max(1, (
          oriented.width.int64 * effectiveTargetHeight.int64 div
          max(1'i64, effectiveTargetWidth.int64)).int)
        state.winOY = (oriented.height - cropH) div 2
        state.winOH = cropH
      # A grid denser than the window's own pixels buys nothing (the fill
      # upscales nearest either way) and costs mask memory; the old
      # full-source grid had the same cap through its oriented-dims min.
      effectiveTargetWidth = min(effectiveTargetWidth, state.winOW)
      effectiveTargetHeight = min(effectiveTargetHeight, state.winOH)
    elif state.scaledFit in OneToOneFits:
      # Center and the anchored fits draw the source 1:1, so sample only what
      # lands on the target (the part of a larger photo that shows, a smaller
      # one whole) at its own resolution: a 4032x3024 photo centered on a
      # 1600x1200 panel decodes into a 1600x1200 grid, not a full-size image.
      let
        oriented = state.orientedDimensions()
        rects = oneToOneRects(oriented.width, oriented.height,
          effectiveTargetWidth, effectiveTargetHeight, state.scaledFit)
      state.winOX = rects.srcX
      state.winOY = rects.srcY
      state.winOW = rects.srcW
      state.winOH = rects.srcH
      effectiveTargetWidth = rects.srcW
      effectiveTargetHeight = rects.srcH

    # Clamp the sampling resolution to what the memory budget allows,
    # trading sharpness for a decode that succeeds. Count exactly what the
    # plan check below counts — each channel plane plus its band and the two
    # accumulator rows — so the clamped grid passes its own check. Counting
    # the planes alone left the bands and accumulators (~180 KB for a
    # 6336-wide 4:4:4 photo into 1200x1600) outside the estimate, so a grid
    # shaved to fit the planes was refused by ~3%, and the caller's degrade
    # ladder then fell to a half-resolution rung when a 94% grid would have
    # done (every 4:4:4 photo on the 13.3" panel, 2026-09-05).
    let budget = decodeBudgetBytes()
    if budget > 0:
      # The coefficient store the masks must leave room for. A progressive
      # decode keeps one strip of it (stripMcuRows, below), so this counts
      # the smallest strip and lets the masks keep their resolution; the
      # strip count then comes from what the masks leave.
      let blockTotal =
        state.coefficientBytesPerMcuRow() * state.leastStripMcuRows().int64
      let
        swapped = state.orientation in {5, 6, 7, 8}
        maxYScale = state.maxYScale
        maxXScale = state.maxXScale
        imageWidth = state.imageWidth
      var scales: seq[(int, int)]
      for component in state.components:
        scales.add((component.yScale, component.xScale))
      let
        ringSink = not state.sink.isNil
        windowStorageRows = if swapped: state.winOW else: state.winOH
      proc scaledMaskBytes(tw, th: int): int64 =
        let
          gridW = if swapped: th else: tw
          gridH = if swapped: tw else: th
        for (yScale, xScale) in scales:
          let
            sampleW = max(1, scaledCeil(gridW, yScale, maxYScale))
            sampleH = max(1, scaledCeil(gridH, xScale, maxXScale))
            compWidth = scaledCeil(imageWidth, yScale, maxYScale)
            # A sink keeps a ring of rows, not the plane.
            rows =
              if ringSink:
                ringRowsFor(sampleH,
                  max(1, scaledCeil(windowStorageRows, xScale, maxXScale)),
                  8 * xScale)
              else:
                sampleH
          result += sampleW.int64 * rows.int64 +
            compWidth.int64 * (8 * xScale).int64 +
            2'i64 * sampleW.int64 * sizeof(uint32).int64
      # The output is the plan's neighbour, not part of the room the
      # channels may fill: sized without it, a progressive photo's planes
      # and strips took the whole budget and the output check after them
      # refused every one (788K planned of a 791K budget, then a 526K
      # output on top: the SenseCAP Indicator, 2026-10-25).
      # A budget the output (or the strip) fills already clamps to the floor
      # grid, so its refusal names the smallest plan, as a tiny budget's does.
      let maskBudget = max(1'i64,
        budget.int64 - blockTotal - state.outputReserveBytes())
      if scaledMaskBytes(effectiveTargetWidth, effectiveTargetHeight) > maskBudget:
        # First guess from the area ratio (the planes dominate), then shave
        # in 1/64 steps until the exact count fits — the bands and
        # accumulators shrink slower than the planes, so the guess alone
        # lands a hair over.
        let factor = sqrt(maskBudget.float64 /
          scaledMaskBytes(effectiveTargetWidth, effectiveTargetHeight).float64)
        effectiveTargetWidth = max(64,
          (effectiveTargetWidth.float64 * factor).int)
        effectiveTargetHeight = max(64,
          (effectiveTargetHeight.float64 * factor).int)
        while (effectiveTargetWidth > 64 or effectiveTargetHeight > 64) and
            scaledMaskBytes(effectiveTargetWidth, effectiveTargetHeight) > maskBudget:
          effectiveTargetWidth = max(64, effectiveTargetWidth - max(1, effectiveTargetWidth div 64))
          effectiveTargetHeight = max(64, effectiveTargetHeight - max(1, effectiveTargetHeight div 64))
    # The same clamp against the largest single buffer: the full-resolution
    # channel (luma, or every channel of an unsubsampled image) is one
    # allocation of effectiveWidth x effectiveHeight bytes, and a plan that
    # fits the heap in total still dies when no free block is that big.
    let contiguous = decodeContiguousBudgetBytes()
    if contiguous > 0:
      let largestMask = effectiveTargetWidth.int64 * effectiveTargetHeight.int64
      if largestMask > contiguous.int64:
        let factor = sqrt(contiguous.float64 / largestMask.float64)
        effectiveTargetWidth = max(64,
          (effectiveTargetWidth.float64 * factor).int)
        effectiveTargetHeight = max(64,
          (effectiveTargetHeight.float64 * factor).int)

  if state.useScaledChannels():
    state.effectiveWidth = effectiveTargetWidth
    state.effectiveHeight = effectiveTargetHeight

  for component in state.components.mitems:
    component.width = (
      state.imageWidth *
      component.yScale +
      state.maxYScale - 1
    ) div state.maxYScale
    component.height = (
      state.imageHeight *
      component.xScale +
      state.maxXScale - 1
    ) div state.maxXScale

    component.widthStride = state.numMcuWide * component.yScale * 8
    component.heightStride = state.numMcuHigh * component.xScale * 8
    component.sampleWidth = component.width
    component.sampleHeight = component.height

    var
      channelWidth = component.widthStride
      channelHeight = component.heightStride
    if state.useScaledChannels():
      let
        targetWidth =
          if state.orientation in {5, 6, 7, 8}: effectiveTargetHeight
          else: effectiveTargetWidth
        targetHeight =
          if state.orientation in {5, 6, 7, 8}: effectiveTargetWidth
          else: effectiveTargetHeight
      component.sampleWidth = max(1,
        (targetWidth * component.yScale + state.maxYScale - 1) div state.maxYScale
      )
      component.sampleHeight = max(1,
        (targetHeight * component.xScale + state.maxXScale - 1) div state.maxXScale
      )
      channelWidth = component.sampleWidth
      channelHeight = component.sampleHeight
      # The box sampler's working set: one MCU row of source pixels plus two
      # target-width accumulator rows. Bands hold decoded pixels before the
      # drain folds them; the accumulators carry a target row's partial sums
      # across band boundaries, which is what makes footprints that straddle
      # an MCU row exact instead of approximated.
      component.bandRows = 8 * component.xScale
      component.bandIndex = -1
      component.nextSourceY = 0
      component.rowSumsTy = -1
      component.rowSumsRows = 0
      # The sampled window at this component's resolution: the oriented
      # window mapped back to storage order (its two corners through
      # sourceCoords — exact for every flip and transpose), then scaled by
      # the component's subsampling. Ceil on the far edge so a chroma
      # window never loses the last half-pixel of the crop.
      block:
        let
          (ax, ay) = state.sourceCoords(
            state.winOX, state.winOY, state.imageWidth, state.imageHeight)
          (bx, by) = state.sourceCoords(
            state.winOX + state.winOW - 1, state.winOY + state.winOH - 1,
            state.imageWidth, state.imageHeight)
          x0 = min(ax, bx)
          x1 = max(ax, bx) + 1
          y0 = min(ay, by)
          y1 = max(ay, by) + 1
        component.winX0 = clamp(
          (x0 * component.yScale) div state.maxYScale, 0, component.width - 1)
        component.winX1 = clamp(
          (x1 * component.yScale + state.maxYScale - 1) div state.maxYScale,
          component.winX0 + 1, component.width)
        component.winY0 = clamp(
          (y0 * component.xScale) div state.maxXScale, 0, component.height - 1)
        component.winY1 = clamp(
          (y1 * component.xScale + state.maxXScale - 1) div state.maxXScale,
          component.winY0 + 1, component.height)
      let winW = component.winX1 - component.winX0
      if component.sampleWidth <= winW:
        component.colCount = newSeq[uint16](component.sampleWidth)
        for sx in 0 ..< winW:
          inc component.colCount[
            (sx.int64 * component.sampleWidth.int64).int div winW]
      if not state.sink.isNil:
        # Into a target: a ring of channel rows, drawn as they finish.
        component.ringRows = ringRowsFor(component.sampleHeight,
          component.winY1 - component.winY0, component.bandRows)
        if component.ringRows < component.sampleHeight:
          channelHeight = component.ringRows

    block:
      let
        blockColumns = state.numMcuWide * component.yScale
        streamsBlocks = state.streamBaselineBlocks and not state.progressive
        maskBytes =
          if state.useScaledChannels():
            # Channel (or its ring) plus the box sampler's band and
            # accumulators.
            channelWidth.int64 * channelHeight.int64 +
              component.width.int64 * (8 * component.xScale).int64 +
              2'i64 * channelWidth.int64 * sizeof(uint32).int64
          else:
            # The reconstruction path magnifies every subsampled channel up to
            # full stride resolution (magnifyXBy2/magnifyYBy2), and during the
            # last doubling the half-size source is still alive next to its
            # result. Count that peak, not the subsampled plane the decode
            # starts with — under-counting here is a plan that "fits the
            # budget" and then dies on the upsample allocations.
            let fullBytes =
              (state.numMcuWide * state.maxYScale * 8).int64 *
              (state.numMcuHigh * state.maxXScale * 8).int64
            if component.yScale == state.maxYScale and
                component.xScale == state.maxXScale:
              fullBytes
            else:
              fullBytes + fullBytes div 2
      totalMaskBytes += maskBytes
      # The channel mask is one allocation; on the reconstruction path the
      # magnified full-stride plane is the biggest one instead.
      let largestBuffer =
        if state.useScaledChannels():
          channelWidth.int64 * channelHeight.int64
        else:
          (state.numMcuWide * state.maxYScale * 8).int64 *
            (state.numMcuHigh * state.maxXScale * 8).int64
      largestSingleBytes = max(largestSingleBytes, largestBuffer)
      if not streamsBlocks:
        # Coefficients are held a block row per allocation.
        largestSingleBytes = max(largestSingleBytes,
          blockColumns.int64 * 64 * sizeof(int16))

    component.channelWidth = channelWidth
    component.channelHeight = channelHeight

    if state.progressive:
      component.widthCoeff = component.widthStride div 8
      component.heightCoeff = component.heightStride div 8

  if len != 0:
    failInvalid()

  # A progressive JPEG's coefficients stay resident until its last scan has
  # refined them, so a whole image's worth costs 3 bytes per source pixel
  # at 4:2:0: 5.8 MB for a 13.3" panel, on a board with under 1 MB to
  # spend. So the decode runs in strips of MCU rows. Every pass over the
  # file reads, from each scan, only its strip's blocks, bookmarks where the
  # next strip begins, and skips to the marker that ends the scan; one strip
  # of coefficients is all that ever exists (decodeScan, runJpegDecode). As
  # many rows as the budget holds beside the masks, or every row when it
  # holds them all, which is what every decode did before. A baseline
  # decode that keeps its blocks keeps them whole: it is one scan.
  state.stripMcuRows = state.numMcuHigh
  let perRow = state.coefficientBytesPerMcuRow()
  if state.progressive and perRow > 0:
    if jpegStripMcuRows > 0:
      state.stripMcuRows = min(state.numMcuHigh, jpegStripMcuRows)
    elif decodeBudgetBytes() > 0:
      let room = decodeBudgetBytes().int64 - totalMaskBytes - state.outputReserveBytes()
      state.stripMcuRows =
        clamp(room div perRow, 1'i64, state.numMcuHigh.int64).int
  totalBlockBytes = perRow * state.stripMcuRows.int64
  if state.stripMcuRows < state.numMcuHigh and state.readProc != nil and
      state.rewindProc == nil:
    # Every strip after the first reads the file again from its start.
    failInvalid("progressive JPEG cannot be decoded from a stream")

  # Check the whole decode plan against the memory budget before any
  # image-sized allocation happens, so oversized inputs fail with a
  # catchable error instead of exhausting memory.
  state.plannedDecodeBytes = totalBlockBytes + totalMaskBytes
  if overContiguousBudget(largestSingleBytes):
    failInvalid(
      "JPEG decode of " & $state.imageWidth & "x" & $state.imageHeight &
      (if state.progressive: " (progressive)" else: "") &
      " needs one " & $(largestSingleBytes div 1024) &
      "K buffer, over the " & $(decodeContiguousBudgetBytes() div 1024) &
      "K contiguous memory budget"
    )
  if overDecodeBudget(state.plannedDecodeBytes):
    failInvalid(
      "JPEG decode of " & $state.imageWidth & "x" & $state.imageHeight &
      (if state.progressive: " (progressive)" else: "") &
      " needs " & $(state.plannedDecodeBytes div 1024) &
      "K of decode buffers, over the " &
      $(decodeBudgetBytes() div 1024) & "K memory budget"
    )
  # And the output beside it, before the entropy decode rather than after:
  # the same refusal ensureOutputBudget would make, seconds of decoding
  # sooner.
  let outputBytes = state.outputReserveBytes()
  if outputBytes > 0 and overDecodeBudget(state.plannedDecodeBytes + outputBytes):
    failInvalid(
      "JPEG output of " & $(outputBytes div 4) & " pixels needs " &
      $(outputBytes div 1024) & "K next to " &
      $(state.plannedDecodeBytes div 1024) & "K of decode buffers, over the " &
      $(decodeBudgetBytes() div 1024) & "K memory budget"
    )

  for component in state.components.mitems:
    if not (state.streamBaselineBlocks and not state.progressive):
      # One strip of coefficient blocks, a seq per block row: a 13.3" luma
      # row is 19 KB, where a whole-image luma plane was one 3.8 MB
      # allocation a fragmented heap could not make.
      component.blocks = newSeqWith(
        state.stripMcuRows * component.xScale,
        newSeq[array[64, int16]](state.numMcuWide * component.yScale)
      )
    component.channel = newMask(component.channelWidth, component.channelHeight)
    if component.ringRows >= component.sampleHeight:
      component.ringRows = 0 # the whole channel: no ring arithmetic
    if state.useScaledChannels():
      # The box sampler's working set, counted in the plan above and
      # allocated only now that the plan passed the budget.
      component.bandPixels = newSeq[uint8](
        component.width * component.bandRows)
      component.horizSums = newSeq[uint32](component.sampleWidth)
      component.rowSums = newSeq[uint32](component.sampleWidth)

  if not state.sink.isNil and state.useScaledChannels():
    state.sinkActive = true
    state.sinkGeometry = state.fillGeometry(state.sink.width, state.sink.height)
    state.sinkStart()

proc decodeSOF1(state: var DecoderState) =
  failInvalid("unsupported extended sequential DCT format")

proc decodeSOF2(state: var DecoderState) =
  ## Decode Start of Image (Progressive DCT format)
  # Same as SOF0, whose strip plan says whether a stream can carry it.
  state.progressive = true
  state.decodeSOF0()

proc decodeExif(state: var DecoderState) =
  ## Decode Exif header
  var len = state.readUint16be().int - 2
  let chunkEnd = state.pos + len
  if chunkEnd > state.len:
    failInvalid()

  template skipInvalidExif() =
    state.pos = chunkEnd
    return

  let exifHeader = state.readStr(6)

  len -= 6

  if exifHeader != "Exif\0\0":
    # Happens with progressive images, just ignore instead of error.
    # Skip to the end.
    state.skipBytes(len)
    return

  # Read the endianess of the exif header
  let
    tiffHeader = state.readUint16be().int
    littleEndian =
      if tiffHeader == 0x4D4D:
        false
      elif tiffHeader == 0x4949:
        true
      else:
        skipInvalidExif()

  len -= 2

  # Verify we got the endianess right.
  if state.readUint16be().maybeSwap(littleEndian) != 0x002A.uint16:
    skipInvalidExif()

  len -= 2

  # Skip any other tiff header data.
  let offsetToFirstIFD = state.readUint32be().maybeSwap(littleEndian).int

  len -= 4

  if offsetToFirstIFD < 8:
    skipInvalidExif()
  if state.pos + offsetToFirstIFD - 8 > chunkEnd:
    skipInvalidExif()

  state.skipBytes(offsetToFirstIFD - 8)

  len -= (offsetToFirstIFD - 8)

  # Read the IFD0 (main image) tags.
  if state.pos + 2 > chunkEnd:
    skipInvalidExif()
  let numTags = state.readUint16be().maybeSwap(littleEndian).int

  len -= 2

  for i in 0 ..< numTags:
    if state.pos + 12 > chunkEnd:
      skipInvalidExif()
    let tagNumber = state.readUint16be().maybeSwap(littleEndian)
    discard state.readUint16be().maybeSwap(littleEndian) # Data format
    discard state.readUint32be().maybeSwap(littleEndian) # Number of components
    let dataOffset = state.readUint32be().maybeSwap(littleEndian).int

    len -= 12

    # For now we only care about orientation tag.
    case tagNumber:
      of 0x0112: # Orientation
        # The SHORT value occupies the first two bytes of the 4-byte data
        # field. After the full-word maybeSwap above it sits in the low word
        # for little-endian (II) files and the high word for big-endian (MM)
        # ones; `shr 16` alone silently dropped orientation for II files
        # (Sony/Canon), leaving photos sideways.
        state.orientation =
          if littleEndian: dataOffset and 0xffff
          else: dataOffset shr 16
      else:
        discard

  # Skip all of the data we do not want to read, IFD1, thumbnail, etc.
  state.pos = chunkEnd # Skip any remaining len

proc reset(state: var DecoderState) =
  ## Rests the decoder state need for restart markers.
  state.bitBuffer = 0
  state.bitsBuffered = 0
  state.hitEnd = false
  for component in 0 ..< state.components.len:
    state.components[component].dcPred = 0
  if state.restartInterval != 0:
    state.todoBeforeRestart = state.restartInterval
  else:
    state.todoBeforeRestart = int.high
  state.eobRun = 0

proc captureBookmark(state: DecoderState): ScanBookmark =
  result = ScanBookmark(pos: state.pos, bitsBuffered: state.bitsBuffered,
    bitBuffer: state.bitBuffer, hitEnd: state.hitEnd, eobRun: state.eobRun,
    todoBeforeRestart: state.todoBeforeRestart)
  # Indexed, not `for i, component in`: a seq's pairs iterator hands out
  # copies, and a component's copy brings its strip of blocks with it, 1.7
  # MB for a 13.3" luma strip, at every strip boundary of every scan.
  for i in 0 ..< state.components.len:
    result.dcPred[i] = state.components[i].dcPred

proc restoreBookmark(state: var DecoderState, mark: ScanBookmark) =
  state.seekTo(mark.pos)
  state.bitsBuffered = mark.bitsBuffered
  state.bitBuffer = mark.bitBuffer
  state.hitEnd = mark.hitEnd
  state.eobRun = mark.eobRun
  state.todoBeforeRestart = mark.todoBeforeRestart
  for i in 0 ..< state.components.len:
    state.components[i].dcPred = mark.dcPred[i]

proc decodeSOS(state: var DecoderState) =
  ## Decode Start of Scan - header before the block data.
  var len = state.readUint16be().int - 2
  state.foundSOS = true

  state.scanComponents = state.readUint8().int

  if state.scanComponents <= 0 or state.scanComponents > state.components.len:
    failInvalid("extra components")

  state.componentOrder.setLen(0)

  for i in 0 ..< state.scanComponents:
    let
      id = state.readUint8()
      info = state.readUint8()
      huffmanAC = info and 15
      huffmanDC = info shr 4

    var component: int
    while component < state.components.len:
      if state.components[component].id == id:
        break
      inc component
    if component == state.components.len:
      failInvalid() # Not found

    state.components[component].huffmanAC = huffmanAC.int
    state.components[component].huffmanDC = huffmanDC.int
    state.componentOrder.add(component)

  state.spectralStart = state.readUint8().int
  state.spectralEnd = state.readUint8().int

  let aa = state.readUint8().int
  state.successiveApproxLow = aa and 15
  state.successiveApproxHigh = aa shr 4

  if state.progressive:
    if state.spectralStart > 63 or state.spectralEnd > 63:
      failInvalid()
    if state.spectralStart > state.spectralEnd:
      failInvalid()
    if state.successiveApproxHigh > 13 or state.successiveApproxLow > 13:
      failInvalid()
    if state.successiveApproxHigh != 0 and
        state.successiveApproxLow != state.successiveApproxHigh - 1:
      failInvalid("invalid progressive parameters")
    if state.spectralStart != 0 and state.scanComponents != 1:
      failInvalid("invalid progressive AC scan component count")
  else:
    if state.spectralStart != 0:
      failInvalid()
    if state.successiveApproxHigh != 0 or state.successiveApproxLow != 0:
      failInvalid()
    state.spectralEnd = 63

  for component in state.componentOrder:
    if state.spectralStart == 0 and state.components[component].huffmanDC > 3:
      failInvalid()
    if (not state.progressive or state.spectralStart != 0) and
        state.components[component].huffmanAC > 3:
      failInvalid()

  if state.scanComponents == state.components.len:
    for i, component in state.componentOrder:
      if component != i:
        failInvalid()

  len -= 4 + 2 * state.scanComponents

  if len != 0:
    failInvalid()

  if state.scanComponents == 1 and state.components.len > 1 and
      not state.progressive:
    state.sinkRelease()

  state.reset()

proc isEntropyMarker(marker: uint8): bool {.inline.} =
  marker in {0xC0'u8..0xC2'u8, 0xC4, 0xD0..0xD7, 0xD9, 0xDA, 0xDB,
    0xDC, 0xDD, 0xE0..0xEF, 0xFE}

proc seekEntropyMarker(state: var DecoderState): bool =
  ## Finds the next marker after damaged entropy-coded data.
  var pos = state.pos
  while pos < state.len - 1 and state.ensureBytes(pos, 2):
    if state.at(pos) != 0xFF:
      inc pos
      continue

    var markerPos = pos
    while state.ensureBytes(markerPos, 1) and state.at(markerPos) == 0xFF:
      inc markerPos
    if markerPos >= state.len:
      break

    let marker = state.at(markerPos)
    if marker == 0:
      pos = markerPos + 1
      continue
    if marker.isEntropyMarker():
      # A long 0xFF run can slide the streaming window past the run start;
      # resuming at the window start keeps recovery working for these
      # already-damaged inputs instead of failing the whole decode.
      state.pos = max(pos, state.windowStart)
      state.hitEnd = true
      state.bitsBuffered = 0
      state.bitBuffer = 0
      return true

    pos = markerPos + 1

proc skipToScanEnd(state: var DecoderState) =
  ## Moves to the marker that ends the current scan without decoding the
  ## entropy-coded data in between: the first 0xFF that is neither a stuffed
  ## data byte (0xFF00), a restart marker, nor fill (0xFFFF). The read
  ## position is past every byte the bit reader took, so a marker it had
  ## reached is still ahead.
  state.bitBuffer = 0
  state.bitsBuffered = 0
  state.hitEnd = false
  var pos = state.pos
  if state.readProc == nil:
    let buffer = state.buffer
    while pos + 1 < state.len:
      if buffer[pos] == 0xFF:
        let marker = buffer[pos + 1]
        if marker != 0 and marker != 0xFF and marker notin 0xD0'u8 .. 0xD7'u8:
          state.pos = pos
          return
      inc pos
  else:
    while pos + 1 < state.len and state.ensureBytes(pos, 2):
      if state.at(pos) == 0xFF:
        let marker = state.at(pos + 1)
        if marker != 0 and marker != 0xFF and marker notin 0xD0'u8 .. 0xD7'u8:
          state.pos = pos
          return
      inc pos
  state.pos = state.len

proc fillBitBuffer(state: var DecoderState) =
  ## When we are low on bits, we need to call this to populate some more.
  while state.bitsBuffered <= 24:
    let b =
      if state.hitEnd:
        0.uint32
      else:
        if state.pos >= state.len:
          state.hitEnd = true
          0.uint32
        else:
          state.readUint8().uint32
    if state.hitEnd:
      state.bitBuffer = state.bitBuffer or (b shl (24 - state.bitsBuffered))
      state.bitsBuffered += 8
      continue
    if b == 0xFF:
      if state.pos >= state.len:
        state.hitEnd = true
        return
      var c = state.readUint8()
      while c == 0xFF:
        if state.pos >= state.len:
          state.hitEnd = true
          return
        c = state.readUint8()
      if c != 0:
        if c.isEntropyMarker():
          state.pos -= 2
          state.hitEnd = true
          return
        dec state.pos
    state.bitBuffer = state.bitBuffer or (b shl (24 - state.bitsBuffered))
    state.bitsBuffered += 8

proc huffmanDecode(state: var DecoderState, tableCurrent, table: int): uint8 =
  ## Decode a uint8 from the huffman table.
  if state.huffmanTables.isNil:
    failInvalid("scan before any huffman table")
  var huffman {.byaddr.} = state.huffmanTables[][tableCurrent][table]

  state.fillBitBuffer()

  let
    fastId = (state.bitBuffer shr (32 - fastBits)) and ((1 shl fastBits) - 1)
    fast = huffman.fast[fastId]

  if fast < 255:
    let size = huffman.sizes[fast].int
    if size > state.bitsBuffered:
      if state.hitEnd:
        return 0
      if state.seekEntropyMarker():
        return 0
      failInvalid()
    state.bitBuffer = state.bitBuffer shl size
    state.bitsBuffered -= size
    return huffman.symbols[fast]

  var
    tmp = (state.bitBuffer shr 16).int
    i = fastBits + 1
  while i < huffman.maxCodes.len:
    if tmp < huffman.maxCodes[i]:
      break
    inc i

  if i == 17 or i > state.bitsBuffered:
    if state.hitEnd:
      return 0
    if state.seekEntropyMarker():
      return 0
    failInvalid()

  let symbolId = (state.bitBuffer shr (32 - i)).int + huffman.deltas[i]
  state.bitBuffer = state.bitBuffer shl i
  state.bitsBuffered -= i
  return huffman.symbols[symbolId]

template lrot(value: uint32, shift: int): uint32 =
  ## Left rotate
  (value shl shift) or (value shr (32 - shift))

proc readBit(state: var DecoderState): int =
  ## Get a single bit.
  if state.bitsBuffered < 1:
    state.fillBitBuffer()
  result = ((state.bitBuffer and cast[uint32](0x80000000)) shr 31).int
  state.bitBuffer = state.bitBuffer shl 1
  dec state.bitsBuffered

proc readBits(state: var DecoderState, n: int): int =
  ## Get n number of bits as a unsigned integer.
  if n notin 0 .. 16:
    failInvalid()
  if state.bitsBuffered < n:
    state.fillBitBuffer()
  if state.bitsBuffered < n and state.hitEnd:
    state.bitsBuffered = n
  let k = lrot(state.bitBuffer, n)
  result = (k and bitMasks[n]).int
  state.bitBuffer = k and (not bitMasks[n])
  state.bitsBuffered -= n

proc receiveExtend(state: var DecoderState, n: int): int =
  ## Get n number of bits as a signed integer. See Jpeg spec pages 109 and 114
  ## for EXTEND and RECEIVE.
  var
    v = state.readBits(n)
    vt = (1 shl (n - 1))
  if v < vt:
    vt = (-1 shl n) + 1
    v = v + vt
  return v

proc decodeRegularBlock(
  state: var DecoderState, component: int, data: var array[64, int16]
) =
  ## Decodes a whole block.
  var t = state.huffmanDecode(0, state.components[component].huffmanDC).int
  if t > 15:
    t = 0
  let
    diff =
      if t == 0:
        0
      else:
        state.receiveExtend(t)
    dc = state.components[component].dcPred + diff
  state.components[component].dcPred = dc
  data[0] = cast[int16](dc)

  var i = 1
  while i < 64:
    let
      rs = state.huffmanDecode(1, state.components[component].huffmanAC)
      s = rs and 15
      r = rs shr 4
    if s == 0:
      if rs != 0xF0:
        break
      i += 16
    else:
      i += r.int
      if i >= 64:
        break
      let zig = deZigZag[i]
      data[zig] = cast[int16](state.receiveExtend(s.int))
      inc i

proc decodeProgressiveBlock(
  state: var DecoderState, component: int, data: var array[64, int16]
) =
  ## Decode a Progressive Start Block
  if state.spectralEnd != 0:
    failInvalid("can't merge dc and ac")

  if state.successiveApproxHigh == 0:
    var t = state.huffmanDecode(0, state.components[component].huffmanDC).int
    if t > 15:
      t = 0
    let
      diff =
        if t > 0:
          state.receiveExtend(t)
        else:
          0
      dc = state.components[component].dcPred + diff
    state.components[component].dcPred = dc
    data[0] = cast[int16](dc * (1 shl state.successiveApproxLow))
  else:
    if state.readBit() != 0:
      data[0] = cast[int16](data[0] + (1 shl state.successiveApproxLow))

proc decodeProgressiveContinuationBlock(
  state: var DecoderState, component: int, data: var array[64, int16]
) =
  ## Decode a Progressive Continuation Block
  if state.spectralStart == 0:
    failInvalid("can't merge progressive blocks")

  if state.successiveApproxHigh == 0:
    var shift = state.successiveApproxLow

    if state.eobRun != 0:
      dec state.eobRun
      return

    var k = state.spectralStart
    while k <= state.spectralEnd:
      let
        rs = state.huffmanDecode(1, state.components[component].huffmanAC)
        s = rs and 15
        r = rs.int shr 4
      if s == 0:
        if r < 15:
          state.eobRun = 1 shl r
          if r != 0:
            state.eobRun += state.readBits(r)
          dec state.eobRun
          break
        k += 16
      else:
        k += r.int
        if k >= 64:
          break
        let zig = deZigZag[k]
        inc k
        if s >= 15:
          break
        data[zig] = cast[int16](state.receiveExtend(s.int) * (1 shl shift))

  else:
    let bit = 1 shl state.successiveApproxLow

    if state.eobRun != 0:
      dec state.eobRun
      for k in state.spectralStart .. state.spectralEnd:
        let zig = deZigZag[k]
        if data[zig] != 0:
          if state.readBit() != 0:
            if (data[zig] and bit) == 0:
              if data[zig] > 0:
                data[zig] = cast[int16](data[zig] + bit)
              else:
                data[zig] = cast[int16](data[zig] - bit)
    else:
      var k = state.spectralStart
      while k <= state.spectralEnd:
        let rs = state.huffmanDecode(1, state.components[component].huffmanAC)
        var
          s = rs.int and 15
          r = rs.int shr 4
        if s == 0:
          if r < 15:
            state.eobRun = (1 shl r) - 1
            if r != 0:
              state.eobRun += state.readBits(r)
            r = 64 # force end of block
          else:
            discard
        else:
          if s != 1:
            r = 64
            s = 0
          else:
            if state.readBit() != 0:
              s = bit
            else:
              s = -bit

        while k <= state.spectralEnd:
          let zig = deZigZag[k]
          inc k
          if data[zig] != 0:
            if state.readBit() != 0:
              if (data[zig] and bit) == 0:
                if data[zig] > 0:
                  data[zig] = cast[int16](data[zig] + bit)
                else:
                  data[zig] = cast[int16](data[zig] - bit)
          else:
            if r == 0:
              data[zig] = cast[int16](s)
              break
            dec r

template idct1D(s0, s1, s2, s3, s4, s5, s6, s7: int32) =
  ## Inverse discrete cosine transform 1D
  template f2f(x: float32): int32 = (x * 4096 + 0.5).int32
  template fsh(x: int32): int32 = x * 4096
  p2 = s2
  p3 = s6
  p1 = (p2 + p3) * f2f(0.5411961f)
  t2 = p1 + p3*f2f(-1.847759065f)
  t3 = p1 + p2*f2f(0.765366865f)
  p2 = s0
  p3 = s4
  t0 = fsh(p2 + p3)
  t1 = fsh(p2 - p3)
  x0 = t0 + t3
  x3 = t0 - t3
  x1 = t1 + t2
  x2 = t1 - t2
  t0 = s7
  t1 = s5
  t2 = s3
  t3 = s1
  p3 = t0 + t2
  p4 = t1 + t3
  p1 = t0 + t3
  p2 = t1 + t2
  p5 = (p3 + p4) * f2f(1.175875602f)
  t0 = t0 * f2f(0.298631336f)
  t1 = t1 * f2f(2.053119869f)
  t2 = t2 * f2f(3.072711026f)
  t3 = t3 * f2f(1.501321110f)
  p1 = p5 + p1*f2f(-0.899976223f)
  p2 = p5 + p2*f2f(-2.562915447f)
  p3 = p3 * f2f(-1.961570560f)
  p4 = p4 * f2f(-0.390180644f)
  t3 += p1 + p4
  t2 += p2 + p3
  t1 += p2 + p4
  t0 += p1 + p3

{.push overflowChecks: off, rangeChecks: off.}

proc idctBlockPixels(data: array[64, int16]): array[64, uint8] =
  ## Inverse discrete cosine transform for one 8x8 block.
  var values: array[64, int32]
  for i in 0 ..< 8:
    if data[i + 8] == 0 and
      data[i + 16] == 0 and
      data[i + 24] == 0 and
      data[i + 32] == 0 and
      data[i + 40] == 0 and
      data[i + 48] == 0 and
      data[i + 56] == 0:
      let dcterm = data[i] * 4
      values[i + 0] = dcterm
      values[i + 8] = dcterm
      values[i + 16] = dcterm
      values[i + 24] = dcterm
      values[i + 32] = dcterm
      values[i + 40] = dcterm
      values[i + 48] = dcterm
      values[i + 56] = dcterm
    else:
      var t0, t1, t2, t3, p1, p2, p3, p4, p5, x0, x1, x2, x3: int32
      idct1D(
        data[i + 0],
        data[i + 8],
        data[i + 16],
        data[i + 24],
        data[i + 32],
        data[i + 40],
        data[i + 48],
        data[i + 56]
      )
      x0 += 512
      x1 += 512
      x2 += 512
      x3 += 512
      values[i + 0] = (x0 + t3) shr 10
      values[i + 56] = (x0 - t3) shr 10
      values[i + 8] = (x1 + t2) shr 10
      values[i + 48] = (x1 - t2) shr 10
      values[i + 16] = (x2 + t1) shr 10
      values[i + 40] = (x2 - t1) shr 10
      values[i + 24] = (x3 + t0) shr 10
      values[i + 32] = (x3 - t0) shr 10

  for i in 0 ..< 8:
    let
      valuesPos = i * 8
      outPos = i * 8

    var t0, t1, t2, t3, p1, p2, p3, p4, p5, x0, x1, x2, x3: int32
    idct1D(
      values[valuesPos + 0],
      values[valuesPos + 1],
      values[valuesPos + 2],
      values[valuesPos + 3],
      values[valuesPos + 4],
      values[valuesPos + 5],
      values[valuesPos + 6],
      values[valuesPos + 7]
    )

    x0 += 65536 + (128 shl 17)
    x1 += 65536 + (128 shl 17)
    x2 += 65536 + (128 shl 17)
    x3 += 65536 + (128 shl 17)

    result[outPos + 0] = clampByte((x0 + t3) shr 17)
    result[outPos + 7] = clampByte((x0 - t3) shr 17)
    result[outPos + 1] = clampByte((x1 + t2) shr 17)
    result[outPos + 6] = clampByte((x1 - t2) shr 17)
    result[outPos + 2] = clampByte((x2 + t1) shr 17)
    result[outPos + 5] = clampByte((x2 - t1) shr 17)
    result[outPos + 3] = clampByte((x3 + t0) shr 17)
    result[outPos + 4] = clampByte((x3 - t0) shr 17)

proc idctBlock(component: var Component, offset: int, data: array[64, int16]) =
  ## Inverse discrete cosine transform whole block into the source channel.
  let pixels = idctBlockPixels(data)
  for y in 0 ..< 8:
    let
      sourcePos = y * 8
      outPos = y * component.widthStride + offset
    for x in 0 ..< 8:
      component.channel.data[outPos + x] = pixels[sourcePos + x]

proc writeScaledTargetRow(component: var Component, ty: int) =
  ## Divides the vertical accumulator by each pixel's exact footprint area
  ## and writes the finished channel row.
  if ty < 0 or ty >= component.sampleHeight:
    return
  component.claimRingRow(ty)
  let
    rows = max(1, component.rowSumsRows).uint32
    outPos = component.channelIndex(0, ty)
  if component.colCount.len > 0:
    for tx in 0 ..< component.sampleWidth:
      let area = rows * component.colCount[tx].uint32
      component.channel.data[outPos + tx] =
        ((component.rowSums[tx] + area div 2) div area).uint8
  else:
    for tx in 0 ..< component.sampleWidth:
      component.channel.data[outPos + tx] =
        ((component.rowSums[tx] + rows div 2) div rows).uint8
  for tx in 0 ..< component.sampleWidth:
    component.rowSums[tx] = 0
  component.rowSumsRows = 0
  component.rowSumsTy = -1
  component.rowsDone = max(component.rowsDone, ty + 1)

proc foldScaledSourceRow(component: var Component, sy, rowStart: int) =
  ## Folds the sampled-window span of one source row from the band into the
  ## target grid: X first (box average on downscale, nearest gather on
  ## upscale), then Y (box accumulate on downscale, replicate on upscale).
  ## `sy` is inside [winY0, winY1) — the drain skips rows the window
  ## excludes — and all mappings are window-relative, which reduces to the
  ## old full-source arithmetic when the window is the whole component.
  let
    winX0 = component.winX0
    winW = component.winX1 - winX0
    winH = component.winY1 - component.winY0
    wy = sy - component.winY0
    sampleWidth = component.sampleWidth
    sampleHeight = component.sampleHeight

  if component.colCount.len > 0:
    for tx in 0 ..< sampleWidth:
      component.horizSums[tx] = 0
    for wx in 0 ..< winW:
      component.horizSums[(wx.int64 * sampleWidth.int64).int div winW] +=
        component.bandPixels[rowStart + winX0 + wx]
  else:
    for tx in 0 ..< sampleWidth:
      component.horizSums[tx] =
        component.bandPixels[rowStart + winX0 + (tx * winW) div sampleWidth]

  if sampleHeight <= winH:
    # Box: this source row belongs to exactly one target row; footprints
    # tile the window, so partial sums never overlap.
    let ty = (wy.int64 * sampleHeight.int64).int div winH
    component.rowSumsTy = ty
    for tx in 0 ..< sampleWidth:
      component.rowSums[tx] += component.horizSums[tx]
    inc component.rowSumsRows
    if wy == winH - 1 or
        (int64(wy + 1) * sampleHeight.int64).int div winH != ty:
      component.writeScaledTargetRow(ty)
  else:
    # Upscale: every target row sampling this source row gets it now, which
    # is the same nearest replication the sampler always did.
    let
      tyLo = scaledCeil(wy, sampleHeight, winH)
      tyHi = min(sampleHeight, scaledCeil(wy + 1, sampleHeight, winH))
    for ty in tyLo ..< tyHi:
      component.claimRingRow(ty)
      let outPos = component.channelIndex(0, ty)
      if component.colCount.len > 0:
        for tx in 0 ..< sampleWidth:
          let area = component.colCount[tx].uint32
          component.channel.data[outPos + tx] =
            ((component.horizSums[tx] + area div 2) div area).uint8
      else:
        for tx in 0 ..< sampleWidth:
          component.channel.data[outPos + tx] = component.horizSums[tx].uint8
    component.rowsDone = max(component.rowsDone, tyHi)

proc drainScaledBand(component: var Component) =
  ## Folds every not-yet-folded source row of the current band that the
  ## sampled window includes.
  if component.bandIndex < 0:
    return
  let
    bandY0 = component.bandIndex * component.bandRows
    bandY1 = min(component.height, bandY0 + component.bandRows)
  for sy in max(bandY0, component.nextSourceY) ..< bandY1:
    if sy >= component.winY0 and sy < component.winY1:
      component.foldScaledSourceRow(sy, (sy - bandY0) * component.width)
    component.nextSourceY = sy + 1
  component.bandIndex = -1

proc finalizeScaledChannel(component: var Component) =
  ## Drains the last band and flushes a partial vertical box, if the image
  ## height leaves one (it does not when footprints tile exactly, but a
  ## truncated decode must still leave the channel fully written).
  component.drainScaledBand()
  if component.rowSumsRows > 0:
    component.writeScaledTargetRow(component.rowSumsTy)

proc idctBlockScaled(component: var Component, row, column: int, data: array[64, int16]) =
  ## Inverse discrete cosine transform of a whole block, routed through the
  ## band buffer so the box sampler sees complete full-resolution rows.
  ## Blocks arrive band-monotonically on every decode path: the interleaved
  ## MCU loop finishes one MCU row (8 * xScale source rows) before the next,
  ## and the per-component passes walk block rows in raster order.
  let
    sourceX0 = row * 8
    sourceY0 = column * 8
  if sourceX0 >= component.width or sourceY0 >= component.height:
    return

  let band = sourceY0 div component.bandRows
  if band != component.bandIndex:
    component.drainScaledBand()
    component.bandIndex = band

  let
    pixels = idctBlockPixels(data)
    bandY0 = band * component.bandRows
    copyWidth = min(8, component.width - sourceX0)
    copyHeight = min(8, component.height - sourceY0)
  for y in 0 ..< copyHeight:
    let rowStart = (sourceY0 - bandY0 + y) * component.width + sourceX0
    for x in 0 ..< copyWidth:
      component.bandPixels[rowStart + x] = pixels[y * 8 + x]

{.pop.}

proc dequantizeBlock(
  state: var DecoderState, comp: int, data: var array[64, int16]
) =
  let qTableId = state.components[comp].quantizationTableId
  if qTableId.int notin 0 ..< state.quantizationTables.len:
    failInvalid()

  when defined(amd64) and allowSimd:
    for i in 0 ..< 8: # 8 per pass
      var q = mm_loadu_si128(state.quantizationTables[qTableId][i * 8].addr)
      q = mm_unpacklo_epi8(q, mm_setzero_si128())
      var v = mm_loadu_si128(data[i * 8].addr)
      mm_storeu_si128(data[i * 8].addr, mm_mullo_epi16(v, q))
  else:
    for i in 0 ..< 64:
      data[i] = cast[int16](
        data[i] * state.quantizationTables[qTableId][i].int32
      )

proc dequantizeAndIDCTBlock(
  state: var DecoderState, comp, row, column: int, data: var array[64, int16]
) =
  state.dequantizeBlock(comp, data)
  if state.useScaledChannels():
    state.components[comp].idctBlockScaled(row, column, data)
  else:
    state.components[comp].idctBlock(
      state.components[comp].widthStride * column * 8 + row * 8,
      data
    )

proc decodeRegularBlockIntoChannel(
  state: var DecoderState, comp, row, column: int
) =
  var data: array[64, int16]
  state.decodeRegularBlock(comp, data)
  state.dequantizeAndIDCTBlock(comp, row, column, data)

proc stripBlockRows(state: DecoderState, comp: int): tuple[first, last: int] =
  ## The block rows of component `comp` the current strip holds, [first,
  ## last) in the component's MCU-padded block grid. A whole-image decode is
  ## one strip of every row.
  let xScale = state.components[comp].xScale
  result.first = state.strip * state.stripMcuRows * xScale
  result.last =
    min(state.numMcuHigh, (state.strip + 1) * state.stripMcuRows) * xScale

proc decodeBlock(state: var DecoderState, comp, row, column: int) =
  ## Decodes a block into the strip's coefficient store.
  var data {.byaddr.} =
    state.components[comp].blocks[column - state.stripBlockRows(comp).first][row]
  if state.progressive:
    if state.spectralStart == 0:
      state.decodeProgressiveBlock(comp, data)
    else:
      state.decodeProgressiveContinuationBlock(comp, data)
  else:
    state.decodeRegularBlock(comp, data)

proc resyncRestart(state: var DecoderState): bool =
  ## Leniently resync to the next restart marker after damaged entropy data.
  let maxPos = min(state.len - 1, state.pos + maxRestartResync)
  var pos = state.pos
  while pos < maxPos and state.ensureBytes(pos, 1):
    if state.at(pos) != 0xFF:
      inc pos
      continue

    var markerPos = pos
    while state.ensureBytes(markerPos, 1) and state.at(markerPos) == 0xFF:
      inc markerPos
    if markerPos >= state.len:
      break

    let marker = state.at(markerPos)
    if marker in 0xD0'u8 .. 0xD7'u8:
      state.pos = markerPos + 1
      state.reset()
      return true

    pos = markerPos + 1

proc checkRestart(state: var DecoderState) =
  ## Check if we might have run into a restart marker, then deal with it.
  dec state.todoBeforeRestart
  if state.todoBeforeRestart <= 0:
    if state.pos + 1 > state.len or not state.ensureBytes(state.pos, 2):
      if state.progressive and state.hitEnd:
        state.todoBeforeRestart = int.high
        return
      failInvalid()
    # Handle getting a restart marker right at the end.
    if state.at(state.pos) == 0xFF and state.at(state.pos + 1) == 0xD9:
      return
    if state.progressive and state.hitEnd and state.at(state.pos) == 0xFF and
        state.at(state.pos + 1) notin 0xD0'u8 .. 0xD7'u8:
      state.todoBeforeRestart = int.high
      return
    if state.at(state.pos) != 0xFF or
      state.at(state.pos + 1) notin 0xD0'u8 .. 0xD7'u8:
      if state.resyncRestart():
        return
      if state.progressive and state.pos + 16 >= state.len:
        state.pos = state.len
        state.hitEnd = true
        state.todoBeforeRestart = int.high
        return
      if state.progressive and state.seekEntropyMarker():
        state.todoBeforeRestart = int.high
        return
      failInvalid("did not get expected restart marker")
    state.pos += 2
    state.reset()

proc decodeBlocks(state: var DecoderState) =
  ## Decodes the scan data blocks that follow a SOS block: the whole scan,
  ## or the current strip's share of it.
  let streamBaselineBlocks = state.streamBaselineBlocks and not state.progressive
  if state.scanComponents == 1:
    # Single component pass.
    let
      comp = state.componentOrder[0]
      w = (state.components[comp].width + 7) div 8
      h = (state.components[comp].height + 7) div 8
      rows = state.stripBlockRows(comp)
    for column in rows.first ..< min(h, rows.last):
      for row in 0 ..< w:
        if streamBaselineBlocks:
          state.decodeRegularBlockIntoChannel(comp, row, column)
        else:
          state.decodeBlock(comp, row, column)
        state.checkRestart()
      if streamBaselineBlocks and state.components.len == 1 and
          ((column + 1) mod state.components[comp].xScale == 0 or column == h - 1):
        # A single-component image: each band is complete as its block
        # rows finish, and the sink can draw.
        state.sinkAfterMcuRow()
  else:
    # Interleaved regular component pass.
    let
      firstMcuY = state.strip * state.stripMcuRows
      lastMcuY = min(state.numMcuHigh, firstMcuY + state.stripMcuRows)
    for mcuY in firstMcuY ..< lastMcuY:
      for mcuX in 0 ..< state.numMcuWide:
        for comp in state.componentOrder:
          for compY in 0 ..< state.components[comp].xScale:
            for compX in 0 ..< state.components[comp].yScale:
              let
                row = (mcuX * state.components[comp].yScale + compX)
                col = (mcuY * state.components[comp].xScale + compY)
              if streamBaselineBlocks:
                state.decodeRegularBlockIntoChannel(comp, row, col)
              else:
                state.decodeBlock(comp, row, col)
        state.checkRestart()
      if streamBaselineBlocks:
        state.sinkAfterMcuRow()

proc decodeScan(state: var DecoderState) =
  ## The entropy-coded data after a SOS header. A whole-image decode reads
  ## all of it. A strip decode picks the scan up where the previous pass
  ## left it, reads its own MCU rows, notes where the next strip's begin,
  ## and moves to the marker that ends the scan without reading the rest.
  let striped = state.stripMcuRows < state.numMcuHigh
  if striped and state.strip > 0:
    if state.scanIndex >= state.scanBookmarks.len:
      failInvalid("a scan the first pass did not see")
    state.restoreBookmark(state.scanBookmarks[state.scanIndex])
  state.decodeBlocks()
  if striped:
    if (state.strip + 1) * state.stripMcuRows < state.numMcuHigh:
      let mark = state.captureBookmark()
      if state.scanIndex < state.scanBookmarks.len:
        state.scanBookmarks[state.scanIndex] = mark
      else:
        state.scanBookmarks.add(mark)
    state.skipToScanEnd()
  inc state.scanIndex

proc idctStrip(state: var DecoderState) =
  ## Dequantizes and inverse-transforms the blocks the strip holds (every
  ## block of the image when it holds them all), component by component in
  ## raster order, which the box sampler's bands rely on. Then clears them
  ## for the next strip, or frees them after the last.
  if state.streamBaselineBlocks and not state.progressive:
    return

  let lastStrip = (state.strip + 1) * state.stripMcuRows >= state.numMcuHigh
  for comp in 0 ..< state.components.len:
    if state.components[comp].quantizationTableId.int notin
        0 ..< state.quantizationTables.len:
      failInvalid()
  # MCU row by MCU row, every component's blocks of it: per component that
  # is still raster order, and after each row the sink has a complete band
  # from every component to draw from.
  let
    firstMcuY = state.strip * state.stripMcuRows
    lastMcuY = min(state.numMcuHigh, firstMcuY + state.stripMcuRows)
  for mcuY in firstMcuY ..< lastMcuY:
    for comp in 0 ..< state.components.len:
      let
        w = (state.components[comp].width + 7) div 8
        h = (state.components[comp].height + 7) div 8
        xScale = state.components[comp].xScale
        first = firstMcuY * xScale
      for compY in 0 ..< xScale:
        let column = mcuY * xScale + compY
        if column >= h:
          break
        for row in 0 ..< w:
          var data {.byaddr.} =
            state.components[comp].blocks[column - first][row]
          state.dequantizeAndIDCTBlock(comp, row, column, data)
    state.sinkAfterMcuRow()
  for comp in 0 ..< state.components.len:
    if lastStrip:
      state.components[comp].blocks = @[]
      state.components[comp].coeff = @[]
      state.components[comp].lineBuf = @[]
    else:
      for blockRow in state.components[comp].blocks.mitems:
        if blockRow.len > 0:
          zeroMem(blockRow[0].addr, blockRow.len * sizeof(array[64, int16]))

proc magnifyXBy2(mask: Mask): Mask =
  ## Smooth magnify by power of 2 only in the X direction.
  result = newMask(mask.width * 2, mask.height)
  for y in 0 ..< mask.height:
    for x in 0 ..< mask.width:
      let n = 3 * mask.unsafe[x, y].uint16
      if x == 0:
        result.unsafe[x * 2 + 0, y] = mask.unsafe[x, y]
        result.unsafe[x * 2 + 1, y] =
          ((n + mask.unsafe[x + 1, y].uint16 + 2) div 4).uint8
      elif x == mask.width - 1:
        result.unsafe[x * 2 + 0, y] =
          ((n + mask.unsafe[x - 1, y].uint16 + 2) div 4).uint8
        result.unsafe[x * 2 + 1, y] = mask.unsafe[x, y]
      else:
        result.unsafe[x * 2 + 0, y] =
          ((n + mask.unsafe[x - 1, y].uint16) div 4).uint8
        result.unsafe[x * 2 + 1, y] =
          ((n + mask.unsafe[x + 1, y].uint16) div 4).uint8

proc magnifyYBy2(mask: Mask): Mask =
  ## Smooth magnify by power of 2 only in the Y direction.
  result = newMask(mask.width, mask.height * 2)
  for y in 0 ..< mask.height:
    for x in 0 ..< mask.width:
      let n = 3 * mask.unsafe[x, y].uint16
      if y == 0:
        result.unsafe[x, y * 2 + 0] = mask.unsafe[x, y]
        result.unsafe[x, y * 2 + 1] =
          ((n + mask.unsafe[x, y + 1].uint16 + 2) div 4).uint8
      elif y == mask.height - 1:
        result.unsafe[x, y * 2 + 0] =
          ((n + mask.unsafe[x, y - 1].uint16 + 2) div 4).uint8
        result.unsafe[x, y * 2 + 1] = mask.unsafe[x, y]
      else:
        result.unsafe[x, y * 2 + 0] =
          ((n + mask.unsafe[x, y - 1].uint16) div 4).uint8
        result.unsafe[x, y * 2 + 1] =
          ((n + mask.unsafe[x, y + 1].uint16) div 4).uint8

proc yCbCrToRgbx(py, pcb, pcr: uint8): ColorRGBX =
  ## Takes a 3 component yCbCr outputs and populates image.
  template float2Fixed(x: float32): int32 =
    (x * 4096 + 0.5).int32 shl 8

  let
    yFixed = (py.int32 shl 20) + (1 shl 19)
    cb = pcb.int32 - 128
    cr = pcr.int32 - 128
  var
    r = yFixed + cr * float2Fixed(1.40200)
    g = yFixed +
      (cr * -float2Fixed(0.71414)) +
      ((cb * -float2Fixed(0.34414)) and -65536)
    b = yFixed + cb * float2Fixed(1.77200)
  result.r = clampByte(r shr 20)
  result.g = clampByte(g shr 20)
  result.b = clampByte(b shr 20)
  result.a = 255

proc grayScaleToRgbx(gray: uint8): ColorRGBX {.inline.} =
  ## Takes a single gray scale component output and populates image.
  rgbx(gray, gray, gray, 255)

proc channelAxis(
  gridCoord, gridSize, sampleSize, nativeSize: int
): tuple[lo, hi, frac, den: int] {.inline.} =
  ## Where one axis of a grid coordinate lands in a channel. A channel that
  ## was box-downsampled below its native resolution (subsampled chroma on a
  ## scaled decode) interpolates between its two nearest samples,
  ## center-aligned; every other channel keeps the exact nearest pick it
  ## always had — the identity when sample and grid sizes match, replication
  ## on upscales — so 1:1 and upscale decodes stay byte-identical.
  if sampleSize < nativeSize:
    let
      den = 2 * gridSize
      num = (2 * gridCoord + 1) * sampleSize - gridSize
    if num <= 0:
      return (0, 0, 0, den)
    let lo = num div den
    if lo >= sampleSize - 1:
      return (sampleSize - 1, sampleSize - 1, 0, den)
    (lo, lo + 1, num - lo * den, den)
  else:
    let nearest = min((gridCoord * sampleSize) div gridSize, sampleSize - 1)
    (nearest, nearest, 0, 1)

proc channelAt(
  component: Component,
  sourceX, sourceY, sourceWidth, sourceHeight: int
): uint8 {.inline.} =
  let
    sampleWidth =
      if component.sampleWidth > 0: component.sampleWidth
      else: component.width
    sampleHeight =
      if component.sampleHeight > 0: component.sampleHeight
      else: component.height
    ax = channelAxis(sourceX, sourceWidth, sampleWidth, component.width)
    ay = channelAxis(sourceY, sourceHeight, sampleHeight, component.height)
  if ax.frac == 0 and ay.frac == 0:
    return component.channel.data[component.channelIndex(ax.lo, ay.lo)]
  let
    c00 = component.channel.data[component.channelIndex(ax.lo, ay.lo)].int
    c10 = component.channel.data[component.channelIndex(ax.hi, ay.lo)].int
    c01 = component.channel.data[component.channelIndex(ax.lo, ay.hi)].int
    c11 = component.channel.data[component.channelIndex(ax.hi, ay.hi)].int
    top = c00 * (ax.den - ax.frac) + c10 * ax.frac
    bottom = c01 * (ax.den - ax.frac) + c11 * ax.frac
    total = top * (ay.den - ay.frac) + bottom * ay.frac
    area = ax.den * ay.den
  ((total + area div 2) div area).uint8

proc scaledFitRects(
  state: DecoderState, targetWidth, targetHeight: int
): tuple[srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH: int] =
  ## Computes the source crop and target placement rectangles (in oriented
  ## source space) for the requested fit mode.
  let oriented = state.orientedDimensions()
  result = (0, 0, oriented.width, oriented.height, 0, 0, targetWidth, targetHeight)
  case state.scaledFit
  of fitStretch:
    discard
  of fitCover:
    if oriented.width.int64 * targetHeight.int64 >
        targetWidth.int64 * oriented.height.int64:
      # Source is wider than the target: crop width, centered.
      let cropW = max(1, (
        oriented.height.int64 * targetWidth.int64 div
        max(1'i64, targetHeight.int64)).int)
      result.srcX = (oriented.width - cropW) div 2
      result.srcW = cropW
    else:
      let cropH = max(1, (
        oriented.width.int64 * targetHeight.int64 div
        max(1'i64, targetWidth.int64)).int)
      result.srcY = (oriented.height - cropH) div 2
      result.srcH = cropH
  of fitContain:
    if oriented.width.int64 * targetHeight.int64 >
        targetWidth.int64 * oriented.height.int64:
      # Source is wider than the target: fit width, letterbox height.
      let fitH = max(1, (
        targetWidth.int64 * oriented.height.int64 div
        max(1'i64, oriented.width.int64)).int)
      result.dstY = (targetHeight - fitH) div 2
      result.dstH = fitH
    else:
      let fitW = max(1, (
        targetHeight.int64 * oriented.width.int64 div
        max(1'i64, oriented.height.int64)).int)
      result.dstX = (targetWidth - fitW) div 2
      result.dstW = fitW
  of OneToOneFits:
    # 1:1 (the same oneToOneRects as the SOF window).
    result = oneToOneRects(oriented.width, oriented.height, targetWidth, targetHeight,
      state.scaledFit)

proc fillGeometry(state: DecoderState, width, height: int): FillGeometry {.raises: [PixieError].} =
  ## Geometry — the crop and where it lands — is decided in image space; the
  ## pixel walk then addresses the sample grid the channels were actually
  ## decoded on. It used to go target -> image -> sample instead, and the
  ## double floor division duplicated some sample columns and skipped others:
  ## extra aliasing, on top of nearest, for every non-integer downscale.
  let oriented = state.orientedDimensions()
  result.rects = state.scaledFitRects(width, height)
  result.effWidth =
    if state.effectiveWidth > 0: state.effectiveWidth else: oriented.width
  result.effHeight =
    if state.effectiveHeight > 0: state.effectiveHeight else: oriented.height
  result.transposed = state.orientation in {5, 6, 7, 8}
  result.gridWidth = if result.transposed: result.effHeight else: result.effWidth
  result.gridHeight = if result.transposed: result.effWidth else: result.effHeight
  # The image-space crop, mapped onto the (oriented) sample grid. The grid
  # covers the sampled window, not always the whole source — for cover it
  # IS the crop (same integer math in the SOF window and in
  # scaledFitRects), so this comes back as (0, 0, effWidth, effHeight) and
  # one grid pixel per target pixel when densities match. Rounded, and
  # window-relative; a full-source window reduces to the old math.
  let
    winOW = max(1, state.winOW)
    winOH = max(1, state.winOH)
  result.sampleSrcX = ((result.rects.srcX - state.winOX).int64 *
    result.effWidth.int64 + winOW div 2) div winOW
  result.sampleSrcY = ((result.rects.srcY - state.winOY).int64 *
    result.effHeight.int64 + winOH div 2) div winOH
  result.sampleSrcW = max(1'i64, (result.rects.srcW.int64 *
    result.effWidth.int64 + winOW div 2) div winOW)
  result.sampleSrcH = max(1'i64, (result.rects.srcH.int64 *
    result.effHeight.int64 + winOH div 2) div winOH)

template orientedYFor(g: FillGeometry, y: int): int =
  min(
    (g.sampleSrcY + ((y - g.rects.dstY).int64 * g.sampleSrcH) div g.rects.dstH).int,
    g.effHeight - 1
  )

template orientedXFor(g: FillGeometry, x: int): int =
  min(
    (g.sampleSrcX + ((x - g.rects.dstX).int64 * g.sampleSrcW) div g.rects.dstW).int,
    g.effWidth - 1
  )

proc samplePixel(
  state: DecoderState, g: FillGeometry, orientedX, orientedY: int
): ColorRGBX {.inline.} =
  let source = state.sourceCoords(orientedX, orientedY, g.gridWidth, g.gridHeight)
  if state.components.len == 3:
    yCbCrToRgbx(
      state.components[0].channelAt(source.x, source.y, g.gridWidth, g.gridHeight),
      state.components[1].channelAt(source.x, source.y, g.gridWidth, g.gridHeight),
      state.components[2].channelAt(source.x, source.y, g.gridWidth, g.gridHeight)
    )
  else:
    grayScaleToRgbx(
      state.components[0].channelAt(source.x, source.y, g.gridWidth, g.gridHeight)
    )

proc fillImage(state: var DecoderState, result: Image) =
  ## Takes a jpeg image object and fills a target-sized pixie Image from it.
  ## With fitContain, pixels outside the fitted rectangle keep their current
  ## contents (callers pre-fill the background).
  if state.components.len notin {1, 3}:
    failInvalid()
  let g = state.fillGeometry(result.width, result.height)
  for y in g.rects.dstY ..< g.rects.dstY + g.rects.dstH:
    let orientedY = g.orientedYFor(y)
    for x in g.rects.dstX ..< g.rects.dstX + g.rects.dstW:
      result.unsafe[x, y] = state.samplePixel(g, g.orientedXFor(x), orientedY)

# ----------------------------------------------------------------- the sink
#
# A decode into a target used to finish every channel plane, target-sized,
# and then fill the target from them: 1.5 bytes per target pixel at 4:2:0,
# 2.9 MB for a 13.3" panel, which the budget on an 8 MB board clamped to a
# soft 646x862 grid. With a sink the planes are rings of rows (ringRowsFor),
# and after every MCU row the lines whose samples every component has
# finished are drawn into the target, the way fillImage would have drawn
# them: same geometry, same samples, so the pixels are the same.
#
# A line is a target row, or a target column when the EXIF orientation
# transposes, and it reads one row of the sample grid. Lines are drawn in
# the order their grid rows finish, which a flip makes bottom-up.

proc gridRowOfLine(state: DecoderState, line: int): int =
  ## The grid row (storage order) a target line samples.
  let g = state.sinkGeometry
  if g.transposed:
    state.sourceCoords(g.orientedXFor(line), 0, g.gridWidth, g.gridHeight).y
  else:
    state.sourceCoords(0, g.orientedYFor(line), g.gridWidth, g.gridHeight).y

proc sinkNeeds(state: var DecoderState) =
  ## Tells every component the lowest channel row the sink still reads,
  ## which is what its ring may not overwrite.
  let g = state.sinkGeometry
  for component in state.components.mitems:
    if state.sinkLinesLeft <= 0:
      component.ringNeedFrom = component.sampleHeight
    else:
      component.ringNeedFrom = channelAxis(
        state.gridRowOfLine(state.sinkLine), g.gridHeight,
        component.sampleHeight, component.height).lo

proc sinkStart(state: var DecoderState) {.raises: [PixieError].} =
  let
    g = state.sinkGeometry
    first = if g.transposed: g.rects.dstX else: g.rects.dstY
    count = if g.transposed: g.rects.dstW else: g.rects.dstH
  state.sinkLinesLeft = count
  if count > 0 and
      state.gridRowOfLine(first + count - 1) < state.gridRowOfLine(first):
    state.sinkLine = first + count - 1
    state.sinkLineStep = -1
  else:
    state.sinkLine = first
    state.sinkLineStep = 1
  state.sinkNeeds()

proc sinkReady(state: DecoderState, gridRow: int): bool =
  ## Whether every component has finished the channel rows this grid row
  ## samples (two, where subsampled chroma interpolates).
  for component in state.components:
    let rows = channelAxis(gridRow, state.sinkGeometry.gridHeight,
      component.sampleHeight, component.height)
    if rows.hi >= component.rowsDone:
      return false
  true

proc drawLine(state: DecoderState, line: int) =
  let g = state.sinkGeometry
  if g.transposed:
    let orientedX = g.orientedXFor(line)
    for y in g.rects.dstY ..< g.rects.dstY + g.rects.dstH:
      state.sink.unsafe[line, y] = state.samplePixel(g, orientedX, g.orientedYFor(y))
  else:
    let orientedY = g.orientedYFor(line)
    for x in g.rects.dstX ..< g.rects.dstX + g.rects.dstW:
      state.sink.unsafe[x, line] = state.samplePixel(g, g.orientedXFor(x), orientedY)

proc sinkDrain(state: var DecoderState) =
  ## Draws every line whose samples are complete.
  var drew = false
  while state.sinkLinesLeft > 0 and
      state.sinkReady(state.gridRowOfLine(state.sinkLine)):
    state.drawLine(state.sinkLine)
    state.sinkLine += state.sinkLineStep
    dec state.sinkLinesLeft
    drew = true
  if drew:
    state.sinkNeeds()

proc sinkAfterMcuRow(state: var DecoderState) {.raises: [PixieError].} =
  ## Every component has a complete band: fold it into the channels, then
  ## draw what became complete.
  if not state.sinkActive:
    return
  for component in state.components.mitems:
    component.drainScaledBand()
  state.sinkDrain()

proc sinkRelease(state: var DecoderState) {.raises: [PixieError].} =
  ## A scan whose blocks arrive one component at a time (a baseline JPEG
  ## with separate scans per component) cannot feed the sink, which needs
  ## every component's rows at once: give the channels their whole planes,
  ## if the budget has them, and fill the target at the end as before.
  if not state.sinkActive:
    return
  var extra: int64
  for component in state.components:
    if component.ringRows > 0:
      extra += component.channel.width.int64 *
        (component.sampleHeight - component.ringRows).int64
  if overDecodeBudget(state.plannedDecodeBytes + extra):
    failInvalid(
      "JPEG decode of " & $state.imageWidth & "x" & $state.imageHeight &
      " with non-interleaved scans needs " &
      $((state.plannedDecodeBytes + extra) div 1024) &
      "K of decode buffers, over the " &
      $(decodeBudgetBytes() div 1024) & "K memory budget"
    )
  state.plannedDecodeBytes += extra
  for component in state.components.mitems:
    if component.ringRows > 0:
      component.channel = newMask(component.channel.width, component.sampleHeight)
      component.ringRows = 0
  state.sinkActive = false

proc ensureOutputBudget(state: DecoderState, width, height: int) =
  ## The SOF plan check covers the decode buffers; the output image the
  ## build step is about to allocate lives NEXT TO them, and an output the
  ## budget cannot carry deserves the same catchable refusal — not an
  ## allocation attempt that exhausts a fragmented heap. The *Into variants
  ## never come here: their target is the caller's to have afforded.
  let outputBytes = width.int64 * height.int64 * 4
  if overDecodeBudget(state.plannedDecodeBytes + outputBytes):
    failInvalid(
      "JPEG output of " & $width & "x" & $height & " needs " &
      $(outputBytes div 1024) & "K next to " &
      $(state.plannedDecodeBytes div 1024) & "K of decode buffers, over the " &
      $(decodeBudgetBytes() div 1024) & "K memory budget"
    )

proc buildImage(state: var DecoderState, targetWidth, targetHeight: int): Image =
  ## Takes a jpeg image object and builds a target-sized pixie Image from it.
  state.ensureOutputBudget(targetWidth, targetHeight)
  result = newImage(targetWidth, targetHeight)
  state.fillImage(result)

proc buildImage(state: var DecoderState): Image =
  ## Takes a jpeg image object and builds a pixie Image from it.

  state.ensureOutputBudget(state.imageWidth, state.imageHeight)
  result = newImage(state.imageWidth, state.imageHeight)

  case state.components.len:
  of 3:
    when defined(frameosEmbedded):
      let
        yComponent = state.components[0]
        cbComponent = state.components[1]
        crComponent = state.components[2]
        cy = yComponent.channel
        cb = cbComponent.channel
        cr = crComponent.channel
      for y in 0 ..< state.imageHeight:
        let
          yY = min((y * yComponent.height) div state.imageHeight, yComponent.height - 1)
          cbY = min((y * cbComponent.height) div state.imageHeight, cbComponent.height - 1)
          crY = min((y * crComponent.height) div state.imageHeight, crComponent.height - 1)
        for x in 0 ..< state.imageWidth:
          result.unsafe[x, y] = yCbCrToRgbx(
            cy.data[cy.dataIndex(
              min((x * yComponent.width) div state.imageWidth, yComponent.width - 1),
              yY
            )],
            cb.data[cb.dataIndex(
              min((x * cbComponent.width) div state.imageWidth, cbComponent.width - 1),
              cbY
            )],
            cr.data[cr.dataIndex(
              min((x * crComponent.width) div state.imageWidth, crComponent.width - 1),
              crY
            )],
          )
    else:
      for component in state.components.mitems:
        while component.yScale < state.maxYScale:
          component.channel = component.channel.magnifyXBy2()
          component.yScale *= 2

        while component.xScale < state.maxXScale:
          component.channel = component.channel.magnifyYBy2()
          component.xScale *= 2

      let
        cy = state.components[0].channel
        cb = state.components[1].channel
        cr = state.components[2].channel
      for y in 0 ..< state.imageHeight:
        var channelIndex = cy.dataIndex(0, y)
        for x in 0 ..< state.imageWidth:
          result.unsafe[x, y] = yCbCrToRgbx(
            cy.data[channelIndex],
            cb.data[channelIndex],
            cr.data[channelIndex],
          )
          inc channelIndex

  of 1:
    let cy = state.components[0].channel
    for y in 0 ..< state.imageHeight:
      var channelIndex = cy.dataIndex(0, y)
      for x in 0 ..< state.imageWidth:
        result.unsafe[x, y] = grayScaleToRgbx(cy.data[channelIndex])
        inc channelIndex

  else:
    failInvalid()

  # Do any of the orientation flips from the Exif header.
  case state.orientation:
  of 0, 1:
    discard
  of 2:
    result.flipHorizontal()
  of 3:
    result.flipVertical()
    result.flipHorizontal()
  of 4:
    result.flipVertical()
  of 5:
    result.rotate90()
    result.flipHorizontal()
  of 6:
    result.rotate90()
  of 7:
    result.rotate90()
    result.flipVertical()
  of 8:
    result.rotate90()
    result.flipVertical()
    result.flipHorizontal()
  else:
    failInvalid("invalid orientation")

proc runJpegDecode(state: var DecoderState) {.raises: [PixieError].}

proc decodeJpegState(
  data: pointer,
  len: int,
  streamBaselineBlocks = false,
  scaledTargetWidth = 0,
  scaledTargetHeight = 0,
  fit = fitStretch,
  sink: Image = nil
): DecoderState {.raises: [PixieError].} =
  var state = DecoderState()
  state.buffer = cast[ptr UncheckedArray[uint8]](data)
  state.len = len
  state.streamBaselineBlocks = streamBaselineBlocks
  state.scaledTargetWidth = scaledTargetWidth
  state.scaledTargetHeight = scaledTargetHeight
  state.scaledFit = fit
  state.sink = sink
  runJpegDecode(state)
  state

proc decodeJpegStateStream(
  readProc: JpegSourceProc,
  totalLen: int,
  scaledTargetWidth, scaledTargetHeight: int,
  fit = fitStretch,
  rewind: JpegRewindProc = nil,
  sink: Image = nil
): DecoderState {.raises: [PixieError].} =
  ## Decodes a JPEG pulled incrementally from `readProc` through a small
  ## sliding window, never holding the whole input in memory.
  if readProc == nil or totalLen <= 2:
    failInvalid("invalid JPEG stream source")
  var state = DecoderState()
  state.readProc = readProc
  state.rewindProc = rewind
  state.window = newSeq[uint8](jpegStreamWindowSize)
  state.buffer = cast[ptr UncheckedArray[uint8]](state.window[0].addr)
  state.len = totalLen
  state.streamBaselineBlocks = true
  state.scaledTargetWidth = scaledTargetWidth
  state.scaledTargetHeight = scaledTargetHeight
  state.scaledFit = fit
  state.sink = sink
  runJpegDecode(state)
  state

proc fillTarget(state: var DecoderState, target: Image) =
  ## After a decode into `target`: the sink has drawn it, or the channel
  ## planes are whole and the fill draws it now.
  if not state.sinkActive:
    state.fillImage(target)

proc decodeSegments(state: var DecoderState) =
  ## One pass over the file: every marker segment up to the end of image.
  ## The first pass reads the headers and sizes the decode; a later pass of
  ## a strip decode reads the tables again (a scan's Huffman tables are
  ## defined right before it) and skips what it already knows.
  let firstPass = state.strip == 0
  while true:
    if state.pos >= state.len and state.foundSOS:
      break
    let chunkId = state.readMarker()
    if state.foundSOS and not state.progressive and chunkId != 0xD9:
      break
    case chunkId:
      of 0xC0:
        # Start Of Frame (Baseline DCT)
        if firstPass: state.decodeSOF0() else: state.skipChunk()
      of 0xC1:
        # Start Of Frame (Extended sequential DCT)
        state.decodeSOF1()
      of 0xC2:
        # Start Of Frame (Progressive DCT)
        if firstPass: state.decodeSOF2() else: state.skipChunk()
      of 0xC4:
        # Define Huffman Table
        state.decodeDHT()
      of 0xD8:
        # SOI - Start of Image
        discard
      of 0xD9:
        # EOI - End of Image
        break
      of 0xD0 .. 0xD7:
        # Restart markers
        discard
      of 0xDB:
        # Define Quantization Table(s)
        state.decodeDQT()
      of 0xDC:
        # Define Number of Lines
        if state.foundSOS and state.pos + 2 > state.len:
          break
        state.skipChunk()
      of 0xDD:
        # Define Restart Interval
        state.decodeDRI()
      of 0xDA:
        # Start Of Scan
        state.decodeSOS()
        # Entropy-coded data
        state.decodeScan()
      of 0XE0:
        # Application-specific
        # state.decodeAPP0(data, at)
        state.skipChunk()
      of 0xE1:
        # Exif/APP1
        if firstPass: state.decodeExif() else: state.skipChunk()
      of 0xE2..0xEF:
        # Application-specific
        state.skipChunk()
      of 0xFE:
        # Comment
        state.skipChunk()
      else:
        failInvalid("invalid chunk " & chunkId.toHex())

proc runJpegDecode(state: var DecoderState) {.raises: [PixieError].} =
  state.decodeSegments()
  state.idctStrip()
  if state.stripMcuRows > 0 and state.stripMcuRows < state.numMcuHigh:
    # The rest of the strips, a pass over the file each (decodeSOF0).
    let strips =
      (state.numMcuHigh + state.stripMcuRows - 1) div state.stripMcuRows
    for strip in 1 ..< strips:
      state.strip = strip
      state.scanIndex = 0
      state.foundSOS = false
      state.hitEnd = false
      state.bitBuffer = 0
      state.bitsBuffered = 0
      state.seekTo(0)
      state.decodeSegments()
      state.idctStrip()

  if state.useScaledChannels():
    # Drain the box sampler's last band and any partial vertical footprint,
    # so the channels are fully written before anything reads them.
    for component in state.components.mitems:
      component.finalizeScaledChannel()
    if state.sinkActive:
      state.sinkDrain()
      if state.sinkLinesLeft != 0:
        failInvalid("the sink left " & $state.sinkLinesLeft & " lines undrawn")

proc decodeJpeg*(data: string): Image {.raises: [PixieError].} =
  ## Decodes the JPEG into an Image.
  var state = decodeJpegState(data.cstring, data.len)
  state.buildImage()

proc decodeJpegScaled*(
  data: pointer, len, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Decodes the JPEG directly into a target-sized Image.
  var state = decodeJpegState(
    data,
    len,
    true,
    width,
    height,
    fit
  )
  state.buildImage(width, height)

proc decodeJpegScaledInto*(
  data: pointer, len: int, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes the JPEG directly into an existing target-sized Image.
  if target.isNil or target.width <= 0 or target.height <= 0:
    raise newException(PixieError, "Target image width and height must be > 0")
  var state = decodeJpegState(
    data,
    len,
    true,
    target.width,
    target.height,
    fit,
    target
  )
  state.fillTarget(target)

proc decodeJpegScaled*(
  data: var string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Decodes the JPEG directly into a target-sized Image.
  ## The input string is released before allocating the output image.
  var state = decodeJpegState(
    data.cstring,
    data.len,
    true,
    width,
    height,
    fit
  )
  data = ""
  state.buildImage(width, height)

proc decodeJpegScaledInto*(
  data: var string, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes the JPEG directly into an existing target-sized Image.
  ## The input string is released before writing the output image.
  if target.isNil or target.width <= 0 or target.height <= 0:
    raise newException(PixieError, "Target image width and height must be > 0")
  var state = decodeJpegState(
    data.cstring,
    data.len,
    true,
    target.width,
    target.height,
    fit,
    target
  )
  data = ""
  state.fillTarget(target)

proc decodeJpegScaled*(
  data: string, width, height: int, fit = fitStretch
): Image {.raises: [PixieError].} =
  ## Decodes the JPEG directly into a target-sized Image.
  decodeJpegScaled(data.cstring, data.len, width, height, fit)

proc decodeJpegScaledInto*(
  data: string, target: Image, fit = fitStretch
) {.raises: [PixieError].} =
  ## Decodes the JPEG directly into an existing target-sized Image.
  decodeJpegScaledInto(data.cstring, data.len, target, fit)

proc decodeJpegStreamScaled*(
  readProc: JpegSourceProc, totalLen, width, height: int, fit = fitStretch,
  rewind: JpegRewindProc = nil
): Image {.raises: [PixieError].} =
  ## Decodes a JPEG pulled from `readProc` into a target-sized Image,
  ## holding only a small window of the compressed input in memory. A
  ## progressive JPEG whose coefficients the budget cannot hold whole is
  ## read in strips, a pass over the input each, which needs `rewind`;
  ## without one it raises a catchable PixieError (retry from a buffer).
  var state = decodeJpegStateStream(
    readProc, totalLen, width, height, fit, rewind)
  state.buildImage(width, height)

proc decodeJpegStreamScaledInto*(
  readProc: JpegSourceProc, totalLen: int, target: Image, fit = fitStretch,
  rewind: JpegRewindProc = nil
) {.raises: [PixieError].} =
  ## Decodes a JPEG pulled from `readProc` directly into an existing
  ## target-sized Image, holding only a small window of the compressed
  ## input in memory. A progressive JPEG whose coefficients the budget
  ## cannot hold whole is read in strips, a pass over the input each, which
  ## needs `rewind`; without one it raises a catchable PixieError (retry
  ## from a buffer).
  if target.isNil or target.width <= 0 or target.height <= 0:
    raise newException(PixieError, "Target image width and height must be > 0")
  var state = decodeJpegStateStream(
    readProc, totalLen, target.width, target.height, fit, rewind, target
  )
  state.fillTarget(target)

proc decodeJpegDimensions*(
  data: pointer, len: int
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes the JPEG dimensions.

  var state = DecoderState()
  state.buffer = cast[ptr UncheckedArray[uint8]](data)
  state.len = len

  while true:
    let chunkId = state.readMarker()
    case chunkId:
      of 0xD8:
        # SOI - Start of Image
        discard
      of 0xC0, 0xC2:
        # Start Of Frame (Baseline DCT or Progressive DCT)
        discard state.readUint16be().int # Chunk len
        discard state.readUint8() # Precision
        state.imageHeight = state.readUint16be().int
        state.imageWidth = state.readUint16be().int
        break
      of 0xC1:
        failInvalid("unsupported extended sequential DCT format")
      of 0xC4:
        # Define Huffman Table
        state.decodeDHT()
      of 0xD0..0xD7:
        # Restart markers
        discard
      of 0xDB:
        # Define Quantization Table(s)
        state.skipChunk()
      of 0xDC:
        # Define Number of Lines
        state.skipChunk()
      of 0xDD:
        # Define Restart Interval
        state.skipChunk()
      of 0XE0:
        # Application-specific
        state.skipChunk()
      of 0xE1:
        # Exif/APP1
        state.decodeExif()
      of 0xE2..0xEF:
        # Application-specific
        state.skipChunk()
      of 0xFE:
        # Comment
        state.skipChunk()
      else:
        failInvalid("invalid chunk " & chunkId.toHex())

  case state.orientation:
    of 0, 1, 2, 3, 4:
      result.width = state.imageWidth
      result.height = state.imageHeight
    of 5, 6, 7, 8:
      result.width = state.imageHeight
      result.height = state.imageWidth
    else:
      failInvalid("invalid orientation")

proc decodeJpegDimensions*(
  data: string
): ImageDimensions {.raises: [PixieError].} =
  ## Decodes the JPEG dimensions.
  decodeJpegDimensions(data.cstring, data.len)

type
  JpegInfo* = object
    ## Cheap header probe used for pre-decode memory planning.
    width*, height*: int ## oriented (post-EXIF-rotation) dimensions
    progressive*: bool
    components*: int
    maxXScale*, maxYScale*: int
    componentScales*: seq[tuple[xScale, yScale: int]]

proc decodeJpegInfo*(
  data: pointer, len: int
): JpegInfo {.raises: [PixieError].} =
  ## Probes a JPEG header for dimensions, encoding mode and subsampling
  ## without decoding any image data.
  var state = DecoderState()
  state.buffer = cast[ptr UncheckedArray[uint8]](data)
  state.len = len

  while true:
    let chunkId = state.readMarker()
    case chunkId:
      of 0xD8, 0xD0 .. 0xD7:
        discard
      of 0xC0, 0xC2:
        result.progressive = chunkId == 0xC2
        discard state.readUint16be().int # Chunk len
        discard state.readUint8() # Precision
        state.imageHeight = state.readUint16be().int
        state.imageWidth = state.readUint16be().int
        let numComponents = state.readUint8().int
        if numComponents notin {1, 3}:
          failInvalid("unsupported component count")
        result.components = numComponents
        for _ in 0 ..< numComponents:
          discard state.readUint8() # Component id
          let info = state.readUint8()
          discard state.readUint8() # Quantization table id
          let
            xScale = (info and 15).int
            yScale = (info shr 4).int
          result.componentScales.add((xScale: xScale, yScale: yScale))
          result.maxXScale = max(result.maxXScale, xScale)
          result.maxYScale = max(result.maxYScale, yScale)
        break
      of 0xC1:
        failInvalid("unsupported extended sequential DCT format")
      of 0xC4:
        state.decodeDHT()
      of 0xE1:
        state.decodeExif()
      of 0xDB, 0xDC, 0xDD, 0xE0, 0xE2..0xEF, 0xFE:
        state.skipChunk()
      else:
        failInvalid("invalid chunk " & chunkId.toHex())

  if state.imageWidth <= 0 or state.imageHeight <= 0 or
      result.maxXScale <= 0 or result.maxYScale <= 0:
    failInvalid()
  case state.orientation:
    of 0, 1, 2, 3, 4:
      result.width = state.imageWidth
      result.height = state.imageHeight
    of 5, 6, 7, 8:
      result.width = state.imageHeight
      result.height = state.imageWidth
    else:
      failInvalid("invalid orientation")

proc decodeJpegInfo*(data: string): JpegInfo {.raises: [PixieError].} =
  ## Probes a JPEG header for dimensions, encoding mode and subsampling.
  decodeJpegInfo(data.cstring, data.len)

proc jpegDecodeIntermediateBytes*(
  info: JpegInfo, targetWidth, targetHeight: int
): int64 {.raises: [].} =
  ## Estimates the decode-intermediate bytes (coefficient blocks + channel
  ## masks) a scaled decode of this JPEG to targetWidth x targetHeight will
  ## allocate. Baseline JPEGs stream their blocks, so only target-sized
  ## masks count; progressive JPEGs additionally hold one strip of
  ## coefficient blocks, as many MCU rows as the current budget leaves room
  ## for beside the masks (decodeSOF0), or every row with no budget set.
  if info.maxXScale <= 0 or info.maxYScale <= 0:
    return 0
  let
    mcuWidth = info.maxYScale * 8
    mcuHeight = info.maxXScale * 8
    numMcuWide = (info.width + mcuWidth - 1) div mcuWidth
    numMcuHigh = (info.height + mcuHeight - 1) div mcuHeight
  var perRow, masks: int64
  for scale in info.componentScales:
    if info.progressive:
      perRow += numMcuWide.int64 * scale.yScale.int64 * scale.xScale.int64 *
        64 * sizeof(int16).int64
    let
      sampleWidth = max(1'i64,
        (targetWidth.int64 * scale.yScale.int64 + info.maxYScale - 1) div info.maxYScale)
      sampleHeight = max(1'i64,
        (targetHeight.int64 * scale.xScale.int64 + info.maxXScale - 1) div info.maxXScale)
    masks += sampleWidth * sampleHeight
  var rows = numMcuHigh.int64
  if perRow > 0:
    if jpegStripMcuRows > 0:
      rows = min(rows, jpegStripMcuRows.int64)
    elif decodeBudgetBytes() > 0:
      rows = clamp((decodeBudgetBytes().int64 - masks) div perRow, 1'i64, rows)
  result = masks + perRow * rows

when defined(release):
  {.pop.}
