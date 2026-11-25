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
## line it brings in is used whole. A byte a pixel (a YUV plane) turns four
## by four in registers (turnBytes), into memory the CPU caches or straight
## into a display plane's buffer (turnYuv420Into), which takes it as fast.

{.push overflowChecks: off, rangeChecks: off.}

const TurnTile = 16

proc turnedSize*(width, height, turn: int): tuple[width, height: int] =
  ## A `width` x `height` picture's size turned by `turn` (and back).
  if turn mod 180 == 90: (height, width) else: (width, height)

proc turnAs[E](src: ptr UncheckedArray[byte], srcPitch, width, height: int,
    dst: ptr UncheckedArray[byte], dstPitch, turn: int, xa = 0, xb = -1, ya = 0, yb = -1) =
  ## The turn a pixel at a time; a quarter turn of the destination's columns
  ## `xa` ..< `xb` and rows `ya` ..< `yb` alone (all of it by default).
  const size = sizeof(E)
  template px(base: ptr UncheckedArray[byte], pitch, x, y: int): var E =
    cast[ptr E](addr base[y * pitch + x * size])[]
  let
    xb = if xb < 0: (if turn mod 180 == 90: height else: width) else: xb
    yb = if yb < 0: (if turn mod 180 == 90: width else: height) else: yb
  case turn
  of 90:
    # The source's left column is the top row, read from the bottom up.
    for ty in countup(ya, yb - 1, TurnTile):
      for tx in countup(xa, xb - 1, TurnTile):
        for y in ty ..< min(ty + TurnTile, yb):
          for x in tx ..< min(tx + TurnTile, xb):
            px(dst, dstPitch, x, y) = px(src, srcPitch, y, height - 1 - x)
  of 270:
    # The source's right column is the top row, read from the top down.
    for ty in countup(ya, yb - 1, TurnTile):
      for tx in countup(xa, xb - 1, TurnTile):
        for y in ty ..< min(ty + TurnTile, yb):
          for x in tx ..< min(tx + TurnTile, xb):
            px(dst, dstPitch, x, y) = px(src, srcPitch, width - 1 - y, x)
  of 180:
    for y in 0 ..< height:
      for x in 0 ..< width:
        px(dst, dstPitch, x, y) = px(src, srcPitch, width - 1 - x, height - 1 - y)
  else:
    for y in 0 ..< height:
      copyMem(addr dst[y * dstPitch], addr src[y * srcPitch], width * size)

proc load32(p: ptr UncheckedArray[byte], at: int): uint32 {.inline.} =
  copyMem(addr result, addr p[at], 4)

proc store32(p: ptr UncheckedArray[byte], at: int, v: uint32) {.inline.} =
  var v = v
  copyMem(addr p[at], addr v, 4)

proc turnBytes(src: ptr UncheckedArray[byte], srcPitch, width, height: int,
    dst: ptr UncheckedArray[byte], dstPitch, turn: int) =
  ## A quarter turn of one byte a pixel (a YUV plane), four by four: four
  ## words read, four written, the bytes moved between them in registers, in
  ## tiles so each cache line read is used whole. A 405x720 frame's three
  ## planes on a Pi Zero: 6.5 ms, 10.7 a byte at a time (2026-11-25). What is
  ## not a whole block at the right and bottom goes a pixel at a time.
  let
    (tw, th) = (height, width)
    bw = tw and not 3
    bh = th and not 3
  const Tile = 32
  for ty in countup(0, bh - 1, Tile):
    for tx in countup(0, bw - 1, Tile):
      for by in countup(ty, min(ty + Tile, bh) - 1, 4):
        for bx in countup(tx, min(tx + Tile, bw) - 1, 4):
          var r0, r1, r2, r3: uint32
          if turn == 90:
            # dst(bx + i, by + j) = src(by + j, height - 1 - bx - i): row i's byte j.
            r0 = load32(src, (height - 1 - bx) * srcPitch + by)
            r1 = load32(src, (height - 2 - bx) * srcPitch + by)
            r2 = load32(src, (height - 3 - bx) * srcPitch + by)
            r3 = load32(src, (height - 4 - bx) * srcPitch + by)
            for j in 0 .. 3:
              let sh = uint32(8 * j)
              store32(dst, (by + j) * dstPitch + bx,
                ((r0 shr sh) and 0xFF) or (((r1 shr sh) and 0xFF) shl 8) or
                (((r2 shr sh) and 0xFF) shl 16) or ((r3 shr sh) shl 24))
          else:
            # dst(bx + i, by + j) = src(width - 1 - by - j, bx + i): row i's byte 3 - j.
            let sc = width - 4 - by
            r0 = load32(src, (bx + 0) * srcPitch + sc)
            r1 = load32(src, (bx + 1) * srcPitch + sc)
            r2 = load32(src, (bx + 2) * srcPitch + sc)
            r3 = load32(src, (bx + 3) * srcPitch + sc)
            for j in 0 .. 3:
              let sh = uint32(8 * (3 - j))
              store32(dst, (by + j) * dstPitch + bx,
                ((r0 shr sh) and 0xFF) or (((r1 shr sh) and 0xFF) shl 8) or
                (((r2 shr sh) and 0xFF) shl 16) or ((r3 shr sh) shl 24))
  # The right strip, then the bottom one under the blocks.
  if bw < tw:
    turnAs[uint8](src, srcPitch, width, height, dst, dstPitch, turn, xa = bw, xb = tw, ya = 0, yb = th)
  if bh < th:
    turnAs[uint8](src, srcPitch, width, height, dst, dstPitch, turn, xa = 0, xb = bw, ya = bh, yb = th)

proc turnCopy*(src: ptr UncheckedArray[byte], srcPitch, width, height: int,
    dst: ptr UncheckedArray[byte], dstPitch, bpp, turn: int) =
  ## The `width` x `height` picture at `src` (rows of `srcPitch` bytes,
  ## `bpp` bytes a pixel: 1, 2 or 4) into `dst` turned `turn` degrees
  ## clockwise: `turnedSize` of it, rows of `dstPitch` bytes.
  case bpp
  of 1:
    if turn mod 180 == 90:
      turnBytes(src, srcPitch, width, height, dst, dstPitch, turn)
    else:
      turnAs[uint8](src, srcPitch, width, height, dst, dstPitch, turn)
  of 2: turnAs[uint16](src, srcPitch, width, height, dst, dstPitch, turn)
  else: turnAs[uint32](src, srcPitch, width, height, dst, dstPitch, turn)

proc turnYuv420Into*(src: ptr UncheckedArray[byte], width, height: int,
    dstY, dstU, dstV: ptr UncheckedArray[byte], yPitch, cPitch, turn: int) =
  ## A packed YUV420 frame (as turnYuv420's) turned into three planes of
  ## their own pitches: a display plane's buffer, written once.
  let
    (cw, ch) = (width div 2, height div 2)
    luma = width * height
    chroma = cw * ch
  turnCopy(src, width, width, height, dstY, yPitch, 1, turn)
  turnCopy(cast[ptr UncheckedArray[byte]](addr src[luma]), cw, cw, ch, dstU, cPitch, 1, turn)
  turnCopy(cast[ptr UncheckedArray[byte]](addr src[luma + chroma]), cw, cw, ch, dstV, cPitch, 1, turn)

proc turnYuv420*(src: ptr UncheckedArray[byte], width, height: int,
    dst: ptr UncheckedArray[byte], turn: int) =
  ## A packed YUV420 frame (`width` x `height`, even, rows of its width: Y,
  ## then U and V at half) into `dst` turned: the same, `turnedSize` of it.
  let
    (tw, th) = turnedSize(width, height, turn)
    chroma = (width div 2) * (height div 2)
  turnYuv420Into(src, width, height, dst, cast[ptr UncheckedArray[byte]](addr dst[tw * th]),
    cast[ptr UncheckedArray[byte]](addr dst[tw * th + chroma]), tw, tw div 2, turn)

{.pop.}
