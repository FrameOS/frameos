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
    runs: ptr UncheckedArray[ChangedRun]; count: var int): int =
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
    rowBytes: int; runs: openArray[ChangedRun]; rotate: int; errors: ptr UncheckedArray[int32]) =
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

{.pop.}
