## What changed on a kept gray canvas since it was last packed for a 1-bit
## panel, and the packing of just that (docs/realtime-rendering.md, "Partial
## refresh on e-paper").
##
## Floyd-Steinberg carries its error across the picture, so dithering a whole
## frame again after a small change rewrites the pattern of every grey below
## it: on a partial update all of those pixels move. Here each run of changed
## pixels is dithered with no error coming in from outside it, over the packed
## picture from before. Everything else stays as it was, bit for bit. The first
## frame, and one that mostly changed, is packed whole by the caller.
##
## Runs are per row and a row can have several: a crosshair that moved is two
## full-height lines, and even one span per row would be everything between
## them.
##
## The canvas is compared with a copy of itself and not with what the renderer
## says it drew: a scene is more than its SVGs (a `render/text` over a
## `render/image`, a photo, the frame-wide colors), and the copy cannot miss a
## writer.

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

# The firmware is built for size; these loops run over every pixel of a frame
# and are compiled at -O2 there, as embedded_main.nim's packers are.
when defined(frameosEmbedded):
  {.pragma: hotLoop, codegenDecl: "__attribute__((optimize(\"O2\"))) $# $#$#".}
else:
  {.pragma: hotLoop.}

type ChangedRun* = tuple[y, left, right: uint16] ## scene pixels, `right` past the end; sorted by row

const
  RunGap = 16
    ## Unchanged pixels a run carries on through: the letters of a word are one run.
  MaxRuns* = 4096
    ## A picture scattered wider than this is packed whole.

proc panelPoint*(x, y, srcW, srcH, rotate: int): tuple[px, py: int] {.inline.} =
  ## Where a pixel of the (rotated) canvas lands on the panel.
  case rotate
  of 90: (srcH - 1 - y, x)
  of 180: (srcW - 1 - x, srcH - 1 - y)
  of 270: (y, srcW - 1 - x)
  else: (x, y)

proc changedRuns*(current, previous: ptr UncheckedArray[uint8]; width, height: int;
    runs: ptr UncheckedArray[ChangedRun]; count: var int): int {.hotLoop.} =
  ## Fills `runs` (room for MaxRuns) with what differs between two gray
  ## canvases. The pixels in them; width * height when there are too many runs
  ## to be worth it.
  count = 0
  for y in 0 ..< height:
    let row = y * width
    if equalMem(current[row].addr, previous[row].addr, width):
      continue
    var x = 0
    while x < width:
      while x < width and current[row + x] == previous[row + x]:
        inc x
      if x >= width:
        break
      let left = x
      var last = x
      inc x
      while x < width and x - last <= RunGap:
        if current[row + x] != previous[row + x]:
          last = x
        inc x
      if count == MaxRuns:
        return width * height
      runs[count] = (y.uint16, left.uint16, uint16(last + 1))
      inc count
      result += last + 1 - left

proc packRuns1bpp*(pixels: ptr UncheckedArray[uint8]; width, height: int; buf: ptr UncheckedArray[uint8];
    rowBytes: int; runs: openArray[ChangedRun]; rotate: int; errors: ptr UncheckedArray[int32]) {.hotLoop.} =
  ## Floyd-Steinberg over the runs of a gray canvas, into the bits of those
  ## pixels in a packed picture (white = 1, MSB first). `errors` has room for
  ## two rows of width + 2. The errors are in sixteenths of a gray level.
  var
    currentError = errors
    nextError = cast[ptr UncheckedArray[int32]](errors[width + 2].addr)
    fromRow = -2
    i = 0
  let errorBytes = (width + 2) * sizeof(int32)
  while i < runs.len:
    let y = runs[i].y.int
    if y != fromRow + 1:
      # Nothing above it was dithered: no error comes down.
      zeroMem(currentError, errorBytes)
      zeroMem(nextError, errorBytes)
    fromRow = y
    let row = y * width
    while i < runs.len and runs[i].y.int == y:
      let
        left = runs[i].left.int
        right = runs[i].right.int
      if rotate == 0 and left == 0 and right == width and (width and 7) == 0:
        # A whole upright row: eight pixels a byte, no panel arithmetic for
        # each (the same error arithmetic as below).
        let outRow = y * rowBytes
        var x = 0
        while x < right:
          var bits = 0'u8
          for b in 0 ..< 8:
            let
              xx = x + b
              gray = pixels[row + xx].int32 + ashr(currentError[xx + 1] + 8, 4)
              white = gray >= 128
              error = gray - (if white: 255 else: 0)
            if white:
              bits = bits or (0x80'u8 shr b)
            if xx + 1 < right:
              currentError[xx + 2] += error * 7
            nextError[xx] += error * 3
            nextError[xx + 1] += error * 5
            nextError[xx + 2] += error
          buf[outRow + (x shr 3)] = bits
          x += 8
        inc i
        continue
      for x in left ..< right:
        let
          gray = pixels[row + x].int32 + ashr(currentError[x + 1] + 8, 4)
          white = gray >= 128
          (px, py) = panelPoint(x, y, width, height, rotate)
          at = py * rowBytes + (px shr 3)
          mask = 0x80'u8 shr (px and 7)
          error = gray - (if white: 255 else: 0)
        buf[at] = if white: buf[at] or mask else: buf[at] and not mask
        if x + 1 < right:
          currentError[x + 2] += error * 7
        nextError[x] += error * 3
        nextError[x + 1] += error * 5
        nextError[x + 2] += error
      inc i
    swap(currentError, nextError)
    zeroMem(nextError, errorBytes)

proc reverseBits(b: uint8): uint8 {.inline.} =
  var v = b
  v = ((v and 0xF0'u8) shr 4) or ((v and 0x0F'u8) shl 4)
  v = ((v and 0xCC'u8) shr 2) or ((v and 0x33'u8) shl 2)
  ((v and 0xAA'u8) shr 1) or ((v and 0x55'u8) shl 1)

proc transpose8(rows: array[8, uint8]): array[8, uint8] {.inline.} =
  ## Eight rows of eight pixels (MSB first) as eight columns: column `c`'s
  ## bit for row `k` is `0x80 shr k`.
  var x = 0'u64
  for k in 0 ..< 8:
    x = (x shl 8) or rows[k].uint64
  var t = (x xor (x shr 7)) and 0x00AA00AA00AA00AA'u64
  x = x xor t xor (t shl 7)
  t = (x xor (x shr 14)) and 0x0000CCCC0000CCCC'u64
  x = x xor t xor (t shl 14)
  t = (x xor (x shr 28)) and 0x00000000F0F0F0F0'u64
  x = x xor t xor (t shl 28)
  for c in 0 ..< 8:
    result[c] = uint8((x shr (56 - 8 * c)) and 0xFF'u64)

proc rotateBits1bpp*(natural: ptr UncheckedArray[uint8]; srcW, srcH: int;
    buf: ptr UncheckedArray[uint8]; rowBytes, rotate: int) {.hotLoop.} =
  ## A packed 1bpp picture in the canvas's own orientation (`(srcW + 7) div 8`
  ## bytes a row) turned onto the panel (`rowBytes` a row), as `panelPoint`
  ## places each pixel. Dithering straight into a 90 or 270 degree panel moved
  ## to another row at every pixel, 0.7 s on the reTerminal Sticky's 480x800
  ## (2026-11-10), and so did turning it a bit at a time (1.2 s): a picture
  ## whose sides are whole bytes turns eight by eight pixels, eight bytes read
  ## and eight written, transposed in a word.
  let
    naturalRow = (srcW + 7) div 8
    (panelW, panelH) = if rotate == 90 or rotate == 270: (srcH, srcW) else: (srcW, srcH)
  if (rotate == 90 or rotate == 270) and srcW mod 8 == 0 and srcH mod 8 == 0 and
      rowBytes == srcH div 8:
    var rows: array[8, uint8]
    for y0 in countup(0, srcH - 8, 8):
      for cb in 0 ..< naturalRow:
        for k in 0 ..< 8:
          rows[k] = natural[(y0 + k) * naturalRow + cb]
        let columns = transpose8(rows)
        for c in 0 ..< 8:
          let x = cb * 8 + c
          if rotate == 270:
            # Panel row srcW - 1 - x; pixels y0 .. y0 + 7, left to right.
            buf[(srcW - 1 - x) * rowBytes + y0 div 8] = columns[c]
          else:
            # Panel row x; the same pixels from the right, so the bits turn.
            buf[x * rowBytes + (srcH - 8 - y0) div 8] = reverseBits(columns[c])
    return
  if rotate == 180 and srcW mod 8 == 0 and rowBytes == naturalRow:
    for y in 0 ..< srcH:
      let src = y * naturalRow
      let dst = (srcH - 1 - y) * rowBytes
      for cb in 0 ..< naturalRow:
        buf[dst + naturalRow - 1 - cb] = reverseBits(natural[src + cb])
    return
  for py in 0 ..< panelH:
    let outRow = py * rowBytes
    for byteX in 0 ..< rowBytes:
      var bits = 0'u8
      for bit in 0 ..< 8:
        let px = byteX * 8 + bit
        if px >= panelW:
          break
        let (x, y) =
          case rotate
          of 90: (py, srcH - 1 - px)
          of 180: (srcW - 1 - px, srcH - 1 - py)
          of 270: (srcW - 1 - py, px)
          else: (px, py)
        if (natural[y * naturalRow + (x shr 3)] and (0x80'u8 shr (x and 7))) != 0:
          bits = bits or (0x80'u8 shr bit)
      buf[outRow + byteX] = bits

{.pop.}
