## A byte range of a file read as what it holds: compressed bytes inflated,
## or an image's raw samples turned into a picture of the size asked. A PDF
## keeps its page contents, fonts and pictures this way, each a stream at an
## offset of the file (FlateDecode is zlib); `frameos.readAsset` and
## `frameos.loadAssetImage` reach them with `offset`, `length` and `inflate`
## or `pixels`.
##
## Both read the range front to back in 16 KB pieces after one seek (a seek a
## piece walks a big file's index on an ESP32's SPIFFS, as zip_entry.nim
## says) and inflate with pixie's streaming inflater, already in every image:
## the inflated text is kept up to the caller's limit and no further, and
## pixels go into the picture a row at a time, scaled as they come, so a
## 4000 x 3000 scan costs one row of it plus the picture asked for.
##
## A damaged stream keeps what came out before the damage, as PDF readers do:
## a file cut short still shows the part of its page it has.

import pixie
import pixie/inflatestream

type
  FileSliceError* = object of CatchableError
  FileSliceTooBig* = object of FileSliceError
    ## The inflated bytes run past the caller's limit.

  RawPixels* = object
    ## Samples as a PDF image's dictionary describes them: `colors` of `bits`
    ## each a pixel (1 grey, 3 RGB, 4 CMYK; 1 with a palette of RGB triples
    ## is indexed), rows padded to a byte, and `predictor` as /DecodeParms
    ## says (1 none, 2 TIFF, 10 and up PNG: a filter byte a row). `invert`
    ## reads each sample the other way round (/Decode [1 0]).
    width*, height*, colors*, bits*, predictor*: int
    palette*: string
    invert*: bool

const
  SliceChunkBytes = 16 * 1024
  MaxSourceSide = 32768 ## samples a row or a column, at most
  MaxPictureSide = 8192 ## pixels a side of the picture made

proc fail(message: string) {.noreturn.} =
  raise newException(FileSliceError, message)

proc isZlibHeader(a, b: uint8): bool =
  (a and 0x0F) == 8 and (a shr 4) <= 7 and ((a.int * 256 + b.int) mod 31) == 0

proc streamSlice(path: string, offset, length: int, inflate: bool,
    onData: InflateOnData) =
  ## Hands the range to onData, inflated when asked (zlib, else a raw deflate
  ## stream). onData raising PixieError("enough") stops it early.
  var f: File
  if not f.open(path):
    fail("could not open " & path)
  defer: f.close()
  let size = f.getFileSize()
  let start = max(0, offset).int64
  if start >= size:
    return
  var left = min(max(0, length).int64, size - start)
  var chunk = newString(SliceChunkBytes)
  f.setFilePos(start)
  proc next(): int =
    if left <= 0: return 0
    let take = int(min(left, SliceChunkBytes.int64))
    result = try: f.readBuffer(addr chunk[0], take) except IOError, OSError: 0
    if result > 0: left -= result
    else: left = 0
  if not inflate:
    while true:
      let got = next()
      if got <= 0: break
      onData(toOpenArray(cast[ptr UncheckedArray[uint8]](addr chunk[0]), 0, got - 1))
    return
  # The first piece decides zlib or raw deflate; it is handed over again as
  # the inflater's first segment.
  var first = next()
  if first < 2:
    return
  let zlib = isZlibHeader(chunk[0].uint8, chunk[1].uint8)
  let pull = proc (): InflateSegment {.gcsafe, raises: [PixieError].} =
    var got = first
    if got > 0:
      first = 0
    else:
      try: got = next()
      except Exception: got = 0
    if got <= 0:
      return InflateSegment(data: nil, len: 0)
    InflateSegment(data: cast[ptr UncheckedArray[uint8]](addr chunk[0]), len: got)
  if zlib: uncompressStreamZlib(onData, pull, keepPartial = true)
  else: uncompressStreamDeflate(onData, pull, keepPartial = true)

proc readFileSlice*(path: string, offset, length: int, inflate: bool, limit: int): string =
  ## The range's bytes, inflated with `inflate`. Raises FileSliceTooBig when
  ## the inflated bytes run past `limit`; a damaged stream gives what came
  ## out of it before the damage.
  var output = ""
  var over = false
  let onData = proc (data: openArray[uint8]) {.gcsafe, raises: [PixieError].} =
    if output.len + data.len > limit:
      over = true
      raise newException(PixieError, "enough")
    let at = output.len
    output.setLen(at + data.len)
    if data.len > 0:
      copyMem(addr output[at], unsafeAddr data[0], data.len)
  try:
    streamSlice(path, offset, length, inflate, onData)
  except PixieError:
    discard # damaged: what came out so far, or over the limit below
  if over:
    raise newException(FileSliceTooBig, "the inflated slice is over the " & $limit & " byte limit")
  output

proc paeth(a, b, c: int): int {.inline.} =
  let p = a + b - c
  let pa = abs(p - a)
  let pb = abs(p - b)
  let pc = abs(p - c)
  if pa <= pb and pa <= pc: a elif pb <= pc: b else: c

type RawDecoder = object
  spec: RawPixels
  image: Image
  w, h, width, height, rowBytes, rowLen, bpp, maxSample: int
  png, indexed: bool
  row, prev: seq[uint8]
  filled, y, ty, rowN: int ## bytes of the row in, the source row coming, the picture's row being made
  colStart: seq[int32]
  acc, cur: seq[uint32] ## the picture's row so far, and this source row with its columns averaged

proc rowEnd(d: RawDecoder, t: int): int {.inline.} =
  max(t * d.h div d.height + 1, (t + 1) * d.h div d.height)

proc sample(d: RawDecoder, data: openArray[uint8], i: int): int {.inline.} =
  ## Sample i of the row, scaled to 0..255 (an index as it is).
  let bits = d.spec.bits
  case bits
  of 8: result = data[i].int
  of 16: result = data[i * 2].int
  else:
    let bit = i * bits
    result = (data[bit shr 3].int shr (8 - bits - (bit and 7))) and d.maxSample
    if not d.indexed:
      result = result * 255 div d.maxSample
  if d.spec.invert:
    result = (if d.indexed: d.maxSample else: 255) - result

proc emitRow(d: var RawDecoder, data: openArray[uint8]) =
  # Columns first: each of the picture's the mean of its samples.
  let colors = d.spec.colors
  for tx in 0 ..< d.width:
    let a = d.colStart[tx].int
    let b = min(max(a + 1, d.colStart[tx + 1].int), d.w)
    var r, g, bl: uint32
    for x in a ..< b:
      var cr, cg, cb: int
      if d.indexed:
        let k = min(d.sample(data, x), d.spec.palette.len div 3 - 1) * 3
        cr = d.spec.palette[k].int
        cg = d.spec.palette[k + 1].int
        cb = d.spec.palette[k + 2].int
      elif colors == 1:
        cr = d.sample(data, x)
        cg = cr
        cb = cr
      elif colors == 3:
        cr = d.sample(data, x * 3)
        cg = d.sample(data, x * 3 + 1)
        cb = d.sample(data, x * 3 + 2)
      else:
        let k = 255 - d.sample(data, x * 4 + 3)
        cr = (255 - d.sample(data, x * 4)) * k div 255
        cg = (255 - d.sample(data, x * 4 + 1)) * k div 255
        cb = (255 - d.sample(data, x * 4 + 2)) * k div 255
      r += cr.uint32
      g += cg.uint32
      bl += cb.uint32
    let n = uint32(max(1, b - a))
    d.cur[tx * 3] = r div n
    d.cur[tx * 3 + 1] = g div n
    d.cur[tx * 3 + 2] = bl div n
  for i in 0 ..< d.acc.len:
    d.acc[i] += d.cur[i]
  inc d.rowN
  # Then rows: a picture's row is done when its last source row is in; one
  # larger than the samples takes the same row again.
  while d.ty < d.height and d.rowEnd(d.ty) <= d.y + 1:
    let n = uint32(max(1, d.rowN))
    var at = d.image.dataIndex(0, d.ty)
    for tx in 0 ..< d.width:
      d.image.data[at] = rgbx(uint8(d.acc[tx * 3] div n), uint8(d.acc[tx * 3 + 1] div n),
        uint8(d.acc[tx * 3 + 2] div n), 255)
      inc at
    inc d.ty
    if d.ty < d.height and d.ty * d.h div d.height <= d.y:
      for i in 0 ..< d.acc.len: d.acc[i] = d.cur[i]
      d.rowN = 1
    else:
      for i in 0 ..< d.acc.len: d.acc[i] = 0
      d.rowN = 0

proc unfilter(d: var RawDecoder) =
  ## The row's samples undone from its predictor, prev the row above.
  if d.png:
    let kind = d.row[0]
    let bpp = d.bpp
    for i in 0 ..< d.rowBytes:
      let left = if i >= bpp: d.row[1 + i - bpp].int else: 0
      let up = d.prev[i].int
      let upLeft = if i >= bpp: d.prev[i - bpp].int else: 0
      let v = d.row[1 + i].int
      d.row[1 + i] = uint8((case kind
        of 1: v + left
        of 2: v + up
        of 3: v + (left + up) div 2
        of 4: v + paeth(left, up, upLeft)
        else: v) and 0xFF) # 0 and anything unknown: as it is
      d.prev[i] = d.row[1 + i]
  elif d.spec.predictor == 2 and d.spec.bits == 8:
    let colors = d.spec.colors
    for i in colors ..< d.rowBytes:
      d.row[i] = d.row[i] + d.row[i - colors]

proc feed(d: var RawDecoder, data: openArray[uint8]): bool =
  ## Takes the bytes in; true once every row is in.
  var i = 0
  while i < data.len:
    let take = min(d.rowLen - d.filled, data.len - i)
    copyMem(addr d.row[d.filled], unsafeAddr data[i], take)
    d.filled += take
    i += take
    if d.filled == d.rowLen:
      d.filled = 0
      d.unfilter()
      if d.png: d.emitRow(toOpenArray(d.row, 1, d.rowLen - 1))
      else: d.emitRow(d.row)
      inc d.y
      if d.y >= d.h:
        return true

proc decodeRawPixels*(path: string, offset, length: int, inflate: bool,
    spec: RawPixels, width, height: int): Image =
  ## The range's samples as a picture of width x height (each pixel the mean
  ## of the samples it covers, or the nearest one when larger), opaque.
  if spec.width <= 0 or spec.height <= 0 or width <= 0 or height <= 0:
    fail("no size")
  # Sizes a file says are not trusted: a row and the picture stay small
  # enough that nothing below overflows a 32-bit int (an ESP32's).
  if spec.width > MaxSourceSide or spec.height > MaxSourceSide or width > MaxPictureSide or height > MaxPictureSide:
    fail("too big")
  if spec.colors notin [1, 3, 4] or spec.bits notin [1, 2, 4, 8, 16]:
    fail("unsupported samples")
  var d = RawDecoder(spec: spec, w: spec.width, h: spec.height, width: width, height: height)
  d.rowBytes = (spec.width * spec.colors * spec.bits + 7) div 8
  d.png = spec.predictor >= 10
  d.bpp = max(1, spec.colors * spec.bits div 8) # PNG's filter distance
  d.rowLen = d.rowBytes + (if d.png: 1 else: 0)
  d.indexed = spec.colors == 1 and spec.palette.len >= 3
  d.maxSample = (1 shl min(spec.bits, 8)) - 1
  d.image = newImage(width, height)
  d.row = newSeq[uint8](d.rowLen)
  d.prev = newSeq[uint8](d.rowBytes)
  d.colStart = newSeq[int32](width + 1)
  d.acc = newSeq[uint32](width * 3)
  d.cur = newSeq[uint32](width * 3)
  for tx in 0 .. width:
    d.colStart[tx] = int32(tx * spec.width div width)
  let onData = proc (data: openArray[uint8]) {.gcsafe, raises: [PixieError].} =
    if d.feed(data):
      raise newException(PixieError, "enough")
  try:
    streamSlice(path, offset, length, inflate, onData)
  except PixieError:
    discard # done, or damaged: the rows that came
  # Rows a short stream never gave stay white.
  while d.ty < height:
    var at = d.image.dataIndex(0, d.ty)
    for tx in 0 ..< width:
      d.image.data[at] = rgbx(255, 255, 255, 255)
      inc at
    inc d.ty
  d.image
