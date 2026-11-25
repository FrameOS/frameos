## A picture turned as it is copied: a video whose display matrix says it is
## shown turned (a phone's, docs/video.md "Turned videos"). Neither the
## VideoCore's ISP nor a display plane turns a picture a quarter (the ISP
## mirrors, vc4's planes too), so the CPU does, after the ISP made it the
## size it is shown at: the copy the player makes of each frame anyway,
## turned. Pure: no device, every host.
##
## `turn` is in degrees clockwise (0, 90, 180, 270): what ffmpeg's own
## autorotate does for the same file. The source is in memory the CPU caches
## (a copy of the ISP's picture, which it sees uncached and reads a row at a
## time): a quarter turn reads it a column at a time, in tiles, so each cache
## line it brings in is used whole.

{.push overflowChecks: off, rangeChecks: off.}

const TurnTile = 16

proc turnedSize*(width, height, turn: int): tuple[width, height: int] =
  ## A `width` x `height` picture's size turned by `turn` (and back).
  if turn mod 180 == 90: (height, width) else: (width, height)

proc turnAs[E](src: ptr UncheckedArray[byte], srcPitch, width, height: int,
    dst: ptr UncheckedArray[byte], dstPitch, turn: int) =
  const size = sizeof(E)
  template px(base: ptr UncheckedArray[byte], pitch, x, y: int): var E =
    cast[ptr E](addr base[y * pitch + x * size])[]
  case turn
  of 90:
    # The source's left column is the top row, read from the bottom up.
    for ty in countup(0, width - 1, TurnTile):
      for tx in countup(0, height - 1, TurnTile):
        for y in ty ..< min(ty + TurnTile, width):
          for x in tx ..< min(tx + TurnTile, height):
            px(dst, dstPitch, x, y) = px(src, srcPitch, y, height - 1 - x)
  of 270:
    # The source's right column is the top row, read from the top down.
    for ty in countup(0, width - 1, TurnTile):
      for tx in countup(0, height - 1, TurnTile):
        for y in ty ..< min(ty + TurnTile, width):
          for x in tx ..< min(tx + TurnTile, height):
            px(dst, dstPitch, x, y) = px(src, srcPitch, width - 1 - y, x)
  of 180:
    for y in 0 ..< height:
      for x in 0 ..< width:
        px(dst, dstPitch, x, y) = px(src, srcPitch, width - 1 - x, height - 1 - y)
  else:
    for y in 0 ..< height:
      copyMem(addr dst[y * dstPitch], addr src[y * srcPitch], width * size)

proc turnCopy*(src: ptr UncheckedArray[byte], srcPitch, width, height: int,
    dst: ptr UncheckedArray[byte], dstPitch, bpp, turn: int) =
  ## The `width` x `height` picture at `src` (rows of `srcPitch` bytes,
  ## `bpp` bytes a pixel: 1, 2 or 4) into `dst` turned `turn` degrees
  ## clockwise: `turnedSize` of it, rows of `dstPitch` bytes.
  case bpp
  of 1: turnAs[uint8](src, srcPitch, width, height, dst, dstPitch, turn)
  of 2: turnAs[uint16](src, srcPitch, width, height, dst, dstPitch, turn)
  else: turnAs[uint32](src, srcPitch, width, height, dst, dstPitch, turn)

proc turnYuv420*(src: ptr UncheckedArray[byte], width, height: int,
    dst: ptr UncheckedArray[byte], turn: int) =
  ## A packed YUV420 frame (`width` x `height`, even, rows of its width: Y,
  ## then U and V at half) into `dst` turned: the same, `turnedSize` of it.
  let
    (tw, th) = turnedSize(width, height, turn)
    (cw, ch) = (width div 2, height div 2)
    tcw = tw div 2
    luma = width * height
    chroma = cw * ch
  turnCopy(src, width, width, height, dst, tw, 1, turn)
  turnCopy(cast[ptr UncheckedArray[byte]](addr src[luma]), cw, cw, ch,
    cast[ptr UncheckedArray[byte]](addr dst[tw * th]), tcw, 1, turn)
  turnCopy(cast[ptr UncheckedArray[byte]](addr src[luma + chroma]), cw, cw, ch,
    cast[ptr UncheckedArray[byte]](addr dst[tw * th + chroma]), tcw, 1, turn)

{.pop.}
