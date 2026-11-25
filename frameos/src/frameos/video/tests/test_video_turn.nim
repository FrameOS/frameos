import std/unittest
import frameos/video/turn

proc picture(width, height, bpp, pitch: int): seq[byte] =
  ## Every pixel's bytes say where it is: (x, y) and which byte.
  result = newSeq[byte](pitch * height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      for b in 0 ..< bpp:
        result[y * pitch + x * bpp + b] = byte((x * 7 + y * 13 + b * 101) mod 251)

proc at(data: seq[byte], pitch, bpp, x, y: int): seq[byte] =
  data[y * pitch + x * bpp ..< y * pitch + x * bpp + bpp]

proc turned(src: seq[byte], srcPitch, width, height, bpp, turn: int, dstPitch = 0): (seq[byte], int) =
  let (tw, th) = turnedSize(width, height, turn)
  let pitch = if dstPitch > 0: dstPitch else: tw * bpp
  var dst = newSeq[byte](pitch * th)
  turnCopy(cast[ptr UncheckedArray[byte]](unsafeAddr src[0]), srcPitch, width, height,
    cast[ptr UncheckedArray[byte]](addr dst[0]), pitch, bpp, turn)
  (dst, pitch)

proc whence(turn, width, height, x, y: int): (int, int) =
  ## Where the turned picture's (x, y) comes from, turned clockwise.
  case turn
  of 90: (y, height - 1 - x)
  of 180: (width - 1 - x, height - 1 - y)
  of 270: (width - 1 - y, x)
  else: (x, y)

suite "a picture turned as it is copied":
  test "a quarter turn swaps the sides, a half does not":
    check turnedSize(1280, 720, 90) == (720, 1280)
    check turnedSize(1280, 720, 270) == (720, 1280)
    check turnedSize(1280, 720, 180) == (1280, 720)
    check turnedSize(1280, 720, 0) == (1280, 720)

  test "clockwise: a quarter puts the top left at the top right, three quarters at the bottom left":
    # 3 x 2, one byte a pixel: a b c / d e f
    let src = @[byte 1, 2, 3, 4, 5, 6]
    let (q, _) = turned(src, 3, 3, 2, 1, 90)
    check q == @[byte 4, 1, 5, 2, 6, 3] # d a / e b / f c
    let (h, _) = turned(src, 3, 3, 2, 1, 180)
    check h == @[byte 6, 5, 4, 3, 2, 1]
    let (t, _) = turned(src, 3, 3, 2, 1, 270)
    check t == @[byte 3, 6, 2, 5, 1, 4] # c f / b e / a d
    let (n, _) = turned(src, 3, 3, 2, 1, 0)
    check n == src

  test "every pixel lands where the turn says, across tiles, for 1, 2 and 4 bytes, with row padding":
    for (width, height) in [(37, 23), (16, 16), (33, 1), (1, 40), (64, 48)]:
      for bpp in [1, 2, 4]:
        let srcPitch = width * bpp + 12
        let src = picture(width, height, bpp, srcPitch)
        for turn in [0, 90, 180, 270]:
          let (tw, th) = turnedSize(width, height, turn)
          let (dst, pitch) = turned(src, srcPitch, width, height, bpp, turn, dstPitch = tw * bpp + 8)
          var wrong = 0
          for y in 0 ..< th:
            for x in 0 ..< tw:
              let (sx, sy) = whence(turn, width, height, x, y)
              if dst.at(pitch, bpp, x, y) != src.at(srcPitch, bpp, sx, sy):
                inc wrong
          check wrong == 0
          # The padding at the rows' ends is not written.
          for y in 0 ..< th:
            for i in tw * bpp ..< pitch:
              check dst[y * pitch + i] == 0

  test "a YUV420 frame turns plane by plane, its chroma at half":
    let (w, h) = (8, 6)
    let size = w * h + 2 * (w div 2) * (h div 2)
    var src = newSeq[byte](size)
    for i in 0 ..< size:
      src[i] = byte(i mod 256)
    for turn in [90, 180, 270]:
      var dst = newSeq[byte](size)
      turnYuv420(cast[ptr UncheckedArray[byte]](addr src[0]), w, h, cast[ptr UncheckedArray[byte]](addr dst[0]), turn)
      let (tw, th) = turnedSize(w, h, turn)
      for y in 0 ..< th:
        for x in 0 ..< tw:
          let (sx, sy) = whence(turn, w, h, x, y)
          check dst[y * tw + x] == src[sy * w + sx]
      let (cw, ch) = (w div 2, h div 2)
      let (tcw, tch) = turnedSize(cw, ch, turn)
      for plane in 0 ..< 2:
        let at = w * h + plane * cw * ch
        for y in 0 ..< tch:
          for x in 0 ..< tcw:
            let (sx, sy) = whence(turn, cw, ch, x, y)
            check dst[at + y * tcw + x] == src[at + sy * cw + sx]
