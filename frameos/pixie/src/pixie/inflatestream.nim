import common

## Self-contained streaming zlib/deflate decompressor for PNG scanline
## decoding. Emits output through a callback as bytes leave the 32KB
## back-reference window, so peak memory is a fixed ~64KB working buffer
## regardless of the uncompressed size.
##
## The huffman machinery and constants are vendored from zippy 0.10.16
## (https://github.com/guzba/zippy, MIT license) so this module has no
## dependency beyond pixie/common. The zlib adler32 trailer is not verified
## (the output is not retained to hash); PNG chunk CRCs cover integrity.

when defined(clang):
  func builtinBitreverse16(v: uint16): uint16 {.importc: "__builtin_bitreverse16", nodecl.}
  proc reverseBits(v: uint16): uint16 {.inline.} =
    builtinBitreverse16(v)
else:
  import std/bitops

const
  maxLitLenCodes = 286
  maxDistanceCodes = 30
  maxFixedLitLenCodes = 288

  baseLengths = [
    3.uint16, 4, 5, 6, 7, 8, 9, 10, # 257 - 264
    11, 13, 15, 17, # 265 - 268
    19, 23, 27, 31, # 269 - 273
    35, 43, 51, 59, # 274 - 276
    67, 83, 99, 115, # 278 - 280
    131, 163, 195, 227, # 281 - 284
    258 # 285
  ]

  baseLengthsExtraBits = [
    0.uint8, 0, 0, 0, 0, 0, 0, 0, # 257 - 264
    1, 1, 1, 1, # 265 - 268
    2, 2, 2, 2, # 269 - 273
    3, 3, 3, 3, # 274 - 276
    4, 4, 4, 4, # 278 - 280
    5, 5, 5, 5, # 281 - 284
    0 # 285
  ]

  baseDistances = [
    1.uint16, 2, 3, 4, # 0-3
    5, 7, # 4-5
    9, 13, # 6-7
    17, 25, # 8-9
    33, 49, # 10-11
    65, 97, # 12-13
    129, 193, # 14-15
    257, 385, # 16-17
    513, 769, # 18-19
    1025, 1537, # 20-21
    2049, 3073, # 22-23
    4097, 6145, # 24-25
    8193, 12289, # 26-27
    16385, 24577 # 28-29
  ]

  baseDistanceExtraBits = [
    0.uint8, 0, 0, 0, # 0-3
    1, 1, # 4-5
    2, 2, # 6-7
    3, 3, # 8-9
    4, 4, # 10-11
    5, 5, # 12-13
    6, 6, # 14-15
    7, 7, # 16-17
    8, 8, # 18-19
    9, 9, # 20-21
    10, 10, # 22-23
    11, 11, # 24-25
    12, 12, # 26-27
    13, 13 # 28-29
  ]

  clclOrder = [
    16.uint8, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
  ]

  fixedLitLenCodeLengths = block:
    var lengths = newSeq[uint8](maxFixedLitLenCodes)
    for i in 0 ..< lengths.len:
      if i <= 143:
        lengths[i] = 8
      elif i <= 255:
        lengths[i] = 9
      elif i <= 279:
        lengths[i] = 7
      else:
        lengths[i] = 8
    lengths

  fixedDistanceCodeLengths = block:
    var lengths = newSeq[uint8](maxDistanceCodes)
    for i in 0 ..< lengths.len:
      lengths[i] = 5
    lengths

  fastBits = 9
  fastMask = (1 shl fastBits) - 1

  inflateWindowSize = 32768 # Max deflate back-reference distance (RFC 1951)
  inflateChunkSize = 32768
  # Room for the longest match (258) plus copy64's 13-byte overwrite slack
  inflateBufferSize = inflateWindowSize + inflateChunkSize + 288

type
  InflateOnData* = proc (data: openArray[uint8]) {.gcsafe, raises: [PixieError].}

  InflateSegment* = object
    ## One piece of a compressed stream. Lets callers hand over data that is
    ## not contiguous in memory (e.g. a PNG's many IDAT chunks) without
    ## first concatenating it into one big allocation.
    data*: ptr UncheckedArray[uint8]
    len*: int

  InflatePull* = proc (): InflateSegment {.gcsafe, raises: [PixieError].}
    ## Pull callback for streaming input: returns the next segment of the
    ## compressed stream, or a segment with len <= 0 at end of input. Each
    ## segment is consumed fully before the next pull, so the callback may
    ## reuse the same backing buffer (e.g. one file-read buffer) every call.

  BitStreamReader = object
    segments: seq[InflateSegment]
    pull: InflatePull
    segIndex: int
    src: ptr UncheckedArray[uint8] # Current segment's data
    len, pos: int                  # Current segment's length and read position
    when (defined(arm64) and defined(macosx)) or sizeof(int) == 4:
      bitBuffer: uint32
    else:
      bitBuffer: uint64
    bitsBuffered: int

  Huffman = object
    firstCode, firstSymbol: array[16, uint16]
    maxCodes: array[17, uint32]
    values: array[288, uint16]
    fast: array[1 shl fastBits, uint16]

  InflateStreamState = object
    buf: string
    op: int      # Write position; buf[0 ..< op] is not yet emitted
    emitted: int # Total bytes handed to onData so far
    onData: InflateOnData

template failStream() =
  raise newException(PixieError, "Invalid buffer, unable to uncompress")

template failStreamEOF() =
  raise newException(PixieError, "Cannot read further, at end of buffer")

when defined(release):
  {.push checks: off.}

proc read64(src: ptr UncheckedArray[uint8], ip: int): uint64 {.inline.} =
  copyMem(result.addr, src[ip].unsafeAddr, 8)

proc write64(dst: ptr UncheckedArray[uint8], op: int, v: uint64) {.inline.} =
  copyMem(dst[op].unsafeAddr, v.unsafeAddr, 8)

proc copy64(dst, src: ptr UncheckedArray[uint8], op, ip: int) {.inline.} =
  write64(dst, op, read64(src, ip))

proc advanceSegment(b: var BitStreamReader): bool =
  ## Moves to the next non-empty segment. Returns false at end of input.
  while b.segIndex + 1 < b.segments.len:
    inc b.segIndex
    let segment = b.segments[b.segIndex]
    if segment.len > 0:
      b.src = segment.data
      b.len = segment.len
      b.pos = 0
      return true
  if b.pull != nil:
    let segment = b.pull()
    if segment.len > 0 and segment.data != nil:
      b.src = segment.data
      b.len = segment.len
      b.pos = 0
      return true
    b.pull = nil
  false

proc initBitStreamReader(segments: openArray[InflateSegment]): BitStreamReader =
  result = BitStreamReader(segments: @segments, segIndex: -1)
  if not result.advanceSegment():
    # No data at all; leave an empty current segment so reads hit EOF paths
    result.src = nil
    result.len = 0
    result.pos = 0

proc initBitStreamReader(pull: InflatePull): BitStreamReader =
  result = BitStreamReader(segIndex: -1, pull: pull)
  if not result.advanceSegment():
    result.src = nil
    result.len = 0
    result.pos = 0

proc fillBitBufferSlow(b: var BitStreamReader) =
  ## Byte-at-a-time refill for segment boundaries and the end of the stream.
  ## Bits above bitsBuffered are always either zero or the true next stream
  ## bits (see fillBitBuffer), so OR-ing the same byte again is harmless.
  let bufferBitSize = sizeof(b.bitBuffer) * 8
  while b.bitsBuffered <= bufferBitSize - 8:
    if b.pos >= b.len:
      if not b.advanceSegment():
        return # At end of input: consumers drive bitsBuffered negative
      continue
    b.bitBuffer = b.bitBuffer or
      (typeof(b.bitBuffer)(b.src[b.pos]) shl b.bitsBuffered)
    inc b.pos
    b.bitsBuffered += 8

proc fillBitBuffer(b: var BitStreamReader) {.inline.} =
  # Fast path: a whole bit-buffer's worth of bytes remains in the current
  # segment. Loads the full word; bits beyond the bytes accounted for are the
  # true next stream bytes, so the next fill ORs identical values over them.
  if b.pos + sizeof(b.bitBuffer) <= b.len:
    let
      bufferBitSize = sizeof(b.bitBuffer).uint * 8
      bytesNeeded = cast[int]((bufferBitSize - cast[uint](b.bitsBuffered)) div 8)
    var src: typeof(b.bitBuffer)
    copyMem(src.addr, b.src[b.pos].addr, sizeof(src))
    b.bitBuffer = b.bitBuffer or (src shl b.bitsBuffered)
    b.pos += bytesNeeded
    b.bitsBuffered += 8 * bytesNeeded
  else:
    b.fillBitBufferSlow()

proc readBits(
  b: var BitStreamReader,
  bits: int,
  fillBitBuffer: static[bool] = true
): uint16 {.inline.} =
  assert bits >= 0 and bits <= 16

  when fillBitBuffer:
    b.fillBitBuffer()

  result = (b.bitBuffer and ((1.uint32 shl bits) - 1)).uint16
  b.bitBuffer = b.bitBuffer shr bits
  b.bitsBuffered -= bits # Can go negative if we've read past the end

proc readBytes(b: var BitStreamReader, dst: pointer, len: int) =
  if b.bitsBuffered mod 8 != 0:
    raise newException(PixieError, "Must be at a byte boundary")

  let dst = cast[ptr UncheckedArray[uint8]](dst)
  var i = 0
  # Drain whole bytes already sitting in the bit buffer (they may have been
  # loaded from an earlier segment, so rewinding pos is not an option)
  while i < len and b.bitsBuffered >= 8:
    dst[i] = uint8(b.bitBuffer and 0xff)
    b.bitBuffer = b.bitBuffer shr 8
    b.bitsBuffered -= 8
    inc i
  if b.bitsBuffered == 0:
    b.bitBuffer = 0 # Clear any true-next-byte bits loaded beyond bitsBuffered
  # Copy the rest straight from the segments
  while i < len:
    if b.pos >= b.len:
      if not b.advanceSegment():
        failStreamEOF()
      continue
    let take = min(len - i, b.len - b.pos)
    copyMem(dst[i].addr, b.src[b.pos].addr, take)
    i += take
    b.pos += take

proc skipRemainingBitsInCurrentByte(b: var BitStreamReader) =
  let mod8 = b.bitsBuffered mod 8
  if mod8 != 0:
    b.bitsBuffered -= mod8
    b.bitBuffer = b.bitBuffer shr mod8

proc initHuffman(codeLengths: openArray[uint8]): Huffman =
  ## See https://raw.githubusercontent.com/madler/zlib/master/doc/algorithm.txt
  var histogram: array[17, uint16]
  for i in 0 ..< codeLengths.len:
    inc histogram[codeLengths[i]]
  histogram[0] = 0

  for i in 1 ..< 16:
    if histogram[i] > (1.uint16 shl i):
      failStream()

  var
    code: uint32
    k: uint16
    nextCode: array[16, uint32]
  for i in 1 ..< 16:
    nextCode[i] = code
    result.firstCode[i] = code.uint16
    result.firstSymbol[i] = k
    code = code + histogram[i]
    if histogram[i] > 0.uint16 and code - 1 >= (1.uint32 shl i):
      failStream()
    result.maxCodes[i] = (code shl (16 - i))
    code = code shl 1
    k += histogram[i]

  result.maxCodes[16] = 1 shl 16

  for i, len in codeLengths:
    if len > 0.uint8:
      let symbolId =
        nextCode[len] - result.firstCode[len] + result.firstSymbol[len]
      result.values[symbolId] = i.uint16
      if len <= fastBits:
        let fast = (len.uint16 shl fastBits) or i.uint16
        var k = reverseBits(nextCode[len].uint16) shr (16.uint16 - len)
        while k < (1 shl fastBits):
          result.fast[k] = fast
          k += (1.uint16 shl len)
      inc nextCode[len]

proc decodeSymbolSlow(b: var BitStreamReader, h: Huffman): uint16 =
  let
    k = reverseBits(b.bitBuffer.uint16)
    maxCodeLength = h.maxCodes.len.uint16
  var codeLength = fastBits.uint16 + 1
  while codeLength < maxCodeLength:
    if k.uint32 < h.maxCodes[codeLength]:
      break
    inc codeLength

  if codeLength >= 16.uint16:
    # Let the callers' checks on the return value raise
    return uint16.high

  let symbolId =
    (k shr (16.uint16 - codeLength)) -
    h.firstCode[codeLength] +
    h.firstSymbol[codeLength]

  result = h.values[symbolId]
  b.bitBuffer = b.bitBuffer shr codeLength
  b.bitsBuffered -= codeLength.int

proc decodeSymbol(b: var BitStreamReader, h: Huffman): uint16 {.inline.} =
  let fast = h.fast[b.bitBuffer and fastMask]
  if fast > 0.uint16:
    let codeLength = fast shr fastBits
    result = fast and fastMask
    b.bitBuffer = b.bitBuffer shr codeLength
    b.bitsBuffered -= codeLength.int
  else: # Slow path
    result = b.decodeSymbolSlow(h)

proc totalOut(s: InflateStreamState): int {.inline.} =
  s.emitted + s.op

proc flushWindow(s: var InflateStreamState) =
  ## Emits everything except the trailing window, then slides the window to
  ## the front of the buffer. Back-references only reach inflateWindowSize
  ## bytes back, so the retained tail is all the history the stream needs.
  let emitLen = s.op - inflateWindowSize
  if emitLen <= 0:
    return
  s.onData(s.buf.toOpenArrayByte(0, emitLen - 1))
  s.emitted += emitLen
  moveMem(s.buf[0].addr, s.buf[emitLen].addr, inflateWindowSize)
  s.op = inflateWindowSize

proc finishStream(s: var InflateStreamState) =
  if s.op > 0:
    s.onData(s.buf.toOpenArrayByte(0, s.op - 1))
    s.emitted += s.op
    s.op = 0

proc inflateBlockStream(
  s: var InflateStreamState,
  b: var BitStreamReader,
  fixedCodes: bool
) =
  var literalsHuffman, distancesHuffman: Huffman
  if fixedCodes:
    literalsHuffman = initHuffman(fixedLitLenCodeLengths)
    distancesHuffman = initHuffman(fixedDistanceCodeLengths)
  else:
    let
      hlit = b.readBits(5).int + 257
      hdist = b.readBits(5).int + 1
      hclen = b.readBits(4).int + 4

    if hlit > maxLitLenCodes:
      failStream()

    if hdist > maxDistanceCodes:
      failStream()

    var clcls: array[19, uint8]
    for i in 0 ..< hclen:
      clcls[clclOrder[i]] = b.readBits(3).uint8

    let clclsHuffman = initHuffman(clcls)

    var
      unpacked: array[320, uint8]
      i: int
    while i != hlit + hdist:
      if b.bitsBuffered < 15:
        b.fillBitBuffer()
      let symbol = decodeSymbol(b, clclsHuffman)
      if b.bitsBuffered < 0:
        failStreamEOF()
      if symbol <= 15:
        unpacked[i] = symbol.uint8
        inc i
      elif symbol == 16:
        if i == 0:
          failStream()
        let
          prev = unpacked[i - 1]
          repeatCount = b.readBits(2).int + 3
        if i + repeatCount > unpacked.len:
          failStream()
        for _ in 0 ..< repeatCount:
          unpacked[i] = prev
          inc i
      elif symbol == 17:
        let repeatZeroCount = b.readBits(3).int + 3
        i += repeatZeroCount
      elif symbol == 18:
        let repeatZeroCount = b.readBits(7).int + 11
        i += repeatZeroCount
      else:
        raise newException(PixieError, "Invalid symbol")

      if i > hlit + hdist:
        failStream()

    literalsHuffman = initHuffman(unpacked.toOpenArray(0, hlit - 1))
    distancesHuffman = initHuffman(unpacked.toOpenArray(hlit, hlit + hdist - 1))

  while true:
    if b.bitsBuffered < 15:
      b.fillBitBuffer()
    let symbol = decodeSymbol(b, literalsHuffman)
    if b.bitsBuffered < 0:
      failStreamEOF()
    if symbol <= 255:
      if s.op >= s.buf.len:
        s.flushWindow()
      s.buf[s.op] = symbol.char
      inc s.op
    elif symbol == 256:
      break
    else:
      b.fillBitBuffer()

      let lengthIdx = (symbol - 257).int
      if lengthIdx >= baseLengths.len:
        failStream()

      let copyLength = (
        baseLengths[lengthIdx] +
        b.readBits(baseLengthsExtraBits[lengthIdx].int, false) # Up to 5
      ).int

      let distanceIdx = decodeSymbol(b, distancesHuffman) # Up to 15
      if distanceIdx >= baseDistances.len.uint16:
        failStream()

      when sizeof(b.bitBuffer) == 4:
        if b.bitsBuffered < 13:
          b.fillBitBuffer()

      let distance = (
        baseDistances[distanceIdx] +
        b.readBits(baseDistanceExtraBits[distanceIdx].int, false) # Up to 13
      ).int

      if distance > s.totalOut:
        failStream()

      # Min match is 3 so leave room to overwrite by 13
      if s.op + copyLength + 13 > s.buf.len:
        s.flushWindow()

      # After a flush s.op >= inflateWindowSize >= distance, so the
      # back-reference always lands inside the buffer
      let dst = cast[ptr UncheckedArray[uint8]](s.buf[0].addr)

      if copyLength <= 16 and distance >= 8:
        copy64(dst, dst, s.op, s.op - distance)
        copy64(dst, dst, s.op + 8, s.op - distance + 8)
      else:
        var
          copyFrom = s.op - distance
          copyTo = s.op
          remaining = copyLength
        while copyTo - copyFrom < 8:
          copy64(dst, dst, copyTo, copyFrom)
          remaining -= copyTo - copyFrom
          copyTo += copyTo - copyFrom
        while remaining > 0:
          copy64(dst, dst, copyTo, copyFrom)
          copyFrom += 8
          copyTo += 8
          remaining -= 8
      s.op += copyLength

proc inflateNoCompressionStream(
  s: var InflateStreamState,
  b: var BitStreamReader
) =
  b.skipRemainingBitsInCurrentByte()
  var len = b.readBits(16).int
  let nlen = b.readBits(16).int
  if len + nlen != 65535:
    failStream()
  while len > 0:
    if s.op >= s.buf.len:
      s.flushWindow()
    let take = min(len, s.buf.len - s.op)
    b.readBytes(s.buf[s.op].addr, take)
    s.op += take
    len -= take

proc inflateStream(
  onData: InflateOnData,
  b: var BitStreamReader
) =
  var
    s = InflateStreamState(buf: newString(inflateBufferSize), onData: onData)
    finalBlock: bool
  while not finalBlock:
    let
      bfinal = b.readBits(1)
      btype = b.readBits(2)

    if bfinal != 0.uint16:
      finalBlock = true

    case btype:
    of 0: # No compression
      inflateNoCompressionStream(s, b)
    of 1: # Compressed with fixed Huffman codes
      inflateBlockStream(s, b, true)
    of 2: # Compressed with dynamic Huffman codes
      inflateBlockStream(s, b, false)
    else:
      raise newException(PixieError, "Invalid block header")

  s.finishStream()

proc uncompressZlibFrom(
  onData: InflateOnData,
  b: var BitStreamReader
) {.raises: [PixieError].} =
  let
    cmf = b.readBits(8).uint8
    flg = b.readBits(8).uint8
    cm = cmf and 0b00001111
    cinfo = cmf shr 4

  if b.bitsBuffered < 0:
    failStreamEOF()

  if cm != 8: # DEFLATE
    raise newException(PixieError, "Unsupported compression method")

  if cinfo > 7.uint8:
    raise newException(PixieError, "Invalid compression info")

  if ((cmf.uint16 * 256) + flg.uint16) mod 31 != 0:
    raise newException(PixieError, "Invalid header")

  if (flg and 0b00100000) != 0: # FDICT
    raise newException(PixieError, "Preset dictionary is not yet supported")

  inflateStream(onData, b)

proc uncompressStreamZlib*(
  onData: InflateOnData,
  segments: openArray[InflateSegment]
) {.raises: [PixieError].} =
  ## Uncompresses a zlib stream split across any number of segments (e.g. a
  ## PNG's IDAT chunks), emitting output through onData in order as it is
  ## decompressed. Peak memory stays at a fixed ~64KB working buffer
  ## regardless of the uncompressed size; the segments are never copied
  ## into a contiguous buffer.
  var total = 0
  for segment in segments:
    total += segment.len
  if total < 6:
    failStream()

  var b = initBitStreamReader(segments)
  uncompressZlibFrom(onData, b)

proc uncompressStreamZlib*(
  onData: InflateOnData,
  pull: InflatePull
) {.raises: [PixieError].} =
  ## Uncompresses a zlib stream whose input arrives on demand from `pull`
  ## (e.g. read from a file), emitting output through onData in order as it
  ## is decompressed. Only the pull callback's current segment is held at a
  ## time, so neither the compressed input nor the output ever needs to fit
  ## in memory.
  var b = initBitStreamReader(pull)
  uncompressZlibFrom(onData, b)

proc uncompressStreamZlib*(
  onData: InflateOnData,
  src: pointer,
  len: int
) {.raises: [PixieError].} =
  ## Uncompresses a contiguous zlib stream; see the segmented overload.
  let segment = [InflateSegment(
    data: cast[ptr UncheckedArray[uint8]](src), len: len
  )]
  uncompressStreamZlib(onData, segment)

when defined(release):
  {.pop.}
