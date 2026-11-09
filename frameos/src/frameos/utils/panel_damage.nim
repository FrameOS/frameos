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

when defined(frameosEmbedded):
  {.pragma: hotLoop, codegenDecl: "__attribute__((optimize(\"O2\"))) $# $#$#".}
else:
  {.pragma: hotLoop.}

type ChangedRun* = tuple[y, left, right: int32] ## scene pixels, `right` past the end; sorted by row

const
  RunGap = 16
    ## Unchanged pixels a run carries on through: the letters of a word are one run.
  MaxRuns = 4096
    ## A picture scattered wider than this is packed whole.

proc panelPoint*(x, y, srcW, srcH, rotate: int): tuple[px, py: int] {.inline.} =
  ## Where a pixel of the (rotated) canvas lands on the panel.
  case rotate
  of 90: (srcH - 1 - y, x)
  of 180: (srcW - 1 - x, srcH - 1 - y)
  of 270: (y, srcW - 1 - x)
  else: (x, y)

proc changedRuns*(current, previous: ptr UncheckedArray[uint8]; width, height: int;
    runs: var seq[ChangedRun]): int {.hotLoop.} =
  ## Fills `runs` with what differs between two gray canvases. The pixels in
  ## them; width * height when there are too many runs to be worth it.
  runs.setLen(0)
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
      if runs.len == MaxRuns:
        return width * height
      runs.add((y.int32, left.int32, int32(last + 1)))
      result += last + 1 - left

proc packRuns1bpp*(pixels: ptr UncheckedArray[uint8]; width, height: int; buf: ptr UncheckedArray[uint8];
    rowBytes: int; runs: openArray[ChangedRun]; rotate: int) {.hotLoop.} =
  ## Floyd-Steinberg over the runs of a gray canvas, into the bits of those
  ## pixels in a packed picture (white = 1, MSB first).
  var
    currentError = newSeq[float32](width + 2)
    nextError = newSeq[float32](width + 2)
    errorBytes = (width + 2) * sizeof(float32)
    fromRow = -2
    i = 0
  while i < runs.len:
    let y = runs[i].y.int
    if y != fromRow + 1:
      # Nothing above it was dithered: no error comes down.
      zeroMem(currentError[0].addr, errorBytes)
      zeroMem(nextError[0].addr, errorBytes)
    fromRow = y
    let row = y * width
    while i < runs.len and runs[i].y.int == y:
      let
        left = runs[i].left.int
        right = runs[i].right.int
      for x in left ..< right:
        let
          gray = pixels[row + x].float32 / 255.0f + currentError[x + 1]
          white = gray >= 0.5f
          (px, py) = panelPoint(x, y, width, height, rotate)
          at = py * rowBytes + (px shr 3)
          mask = 0x80'u8 shr (px and 7)
        buf[at] = if white: buf[at] or mask else: buf[at] and not mask
        let error = gray - (if white: 1.0f else: 0.0f)
        if x + 1 < right:
          currentError[x + 2] += error * 7.0f / 16.0f
        nextError[x] += error * 3.0f / 16.0f
        nextError[x + 1] += error * 5.0f / 16.0f
        nextError[x + 2] += error * 1.0f / 16.0f
      inc i
    swap(currentError, nextError)
    zeroMem(nextError[0].addr, errorBytes)

{.pop.}
