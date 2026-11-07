import strutils, pixie, pixie/fileformats/ppm

block:
  for format in @["p3", "p6"]:
    let
      path = "tests/fileformats/ppm/feep." & $format & ".master.ppm"
      image = decodePpm(readFile(path))
      dimensions = decodePpmDimensions(readFile(path))
    writeFile("tests/fileformats/ppm/feep." & $format & ".ppm", encodePpm(image))
    doAssert image.width == dimensions.width
    doAssert image.height == dimensions.height

block:
  let
    path = "tests/fileformats/ppm/feep.p3.hidepth.master.ppm"
    image = decodePpm(readFile(path))
    dimensions = decodePpmDimensions(readFile(path))
  writeFile("tests/fileformats/ppm/feep.p3.hidepth.ppm", encodePpm(image))
  doAssert image.width == dimensions.width
  doAssert image.height == dimensions.height

  # produced output should be identical to P6 master
  let p6Master = readFile("tests/fileformats/ppm/feep.p6.master.ppm")
  for image in @["p3", "p6", "p3.hidepth"]:
    doAssert readFile("tests/fileformats/ppm/feep." & $image & ".ppm") == p6Master

block:
  let payload = "P6\n10 10\n255\n" & "\x12\x34\x56"

  doAssertRaises PixieError:
    discard decodeImage(payload)

block: # pull-source scaled decodes match the buffered decoder
  proc sourceOf(data: string, readSize: int): ImageSourceProc =
    var pos = 0
    result = proc (dst: pointer, maxBytes: int): int =
      let n = min(min(readSize, maxBytes), data.len - pos)
      if n <= 0:
        return 0
      copyMem(dst, data[pos].unsafeAddr, n)
      pos += n
      n

  let
    data = readFile("tests/fileformats/ppm/feep.p6.master.ppm")
    full = decodePpm(data)

  # Identity size matches the buffered decode exactly
  block:
    let target = newImage(full.width, full.height)
    decodePpmStreamScaledInto(sourceOf(data, 7), data.len, target, fitStretch)
    doAssert target.pixelsEqual(full)

  # Per axis: downscales are box averages of each pixel's exact source
  # footprint, upscale axes keep the nearest pick (4 wide into 5 here).
  for readSize in [1, 7, 1 shl 20]:
    for totalLen in [data.len, 0]:
      let target = newImage(5, 3)
      decodePpmStreamScaledInto(
        sourceOf(data, readSize), totalLen, target, fitStretch)
      for ty in 0 ..< target.height:
        var ys: seq[int]
        if target.height <= full.height:
          for sy in 0 ..< full.height:
            if (sy * target.height) div full.height == ty: ys.add(sy)
        else:
          ys.add((ty * full.height) div target.height)
        for tx in 0 ..< target.width:
          var xs: seq[int]
          if target.width <= full.width:
            for sx in 0 ..< full.width:
              if (sx * target.width) div full.width == tx: xs.add(sx)
          else:
            xs.add((tx * full.width) div target.width)
          var r, g, b: uint64
          for sy in ys:
            for sx in xs:
              let px = full.unsafe[sx, sy]
              r += px.r
              g += px.g
              b += px.b
          let n = uint64(xs.len * ys.len)
          doAssert target.unsafe[tx, ty] == rgbx(
            uint8((r + n div 2) div n),
            uint8((g + n div 2) div n),
            uint8((b + n div 2) div n),
            255)

  # 16-bit maxVal payloads stream too
  block:
    var data16 = "P6\n2 2\n65535\n"
    for v in [0, 1000, 30000, 65535, 12345, 255, 500, 40000, 65534, 1, 2, 3]:
      data16.add(char((v shr 8) and 0xff))
      data16.add(char(v and 0xff))
    let
      full16 = decodePpm(data16)
      target = newImage(2, 2)
    decodePpmStreamScaledInto(sourceOf(data16, 3), data16.len, target, fitStretch)
    doAssert target.pixelsEqual(full16)

  # P3 (ASCII) PPMs cannot stream and must fail cleanly
  block:
    let p3 = readFile("tests/fileformats/ppm/feep.p3.master.ppm")
    try:
      let target = newImage(4, 4)
      decodePpmStreamScaledInto(sourceOf(p3, 100), p3.len, target, fitStretch)
      doAssert false
    except PixieError as e:
      doAssert "P6" in e.msg

  # Truncated input fails instead of hanging on the exhausted source
  block:
    let truncated = data[0 ..< data.len div 2]
    for totalLen in [truncated.len, 0]:
      try:
        let target = newImage(4, 4)
        decodePpmStreamScaledInto(
          sourceOf(truncated, 100), totalLen, target, fitStretch)
        doAssert false
      except PixieError:
        discard
