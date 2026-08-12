import std/[os, unittest]
import pixie
import pixie/fileformats/bmp as pixie_bmp
import pixie/fileformats/jpeg as pixie_jpeg
import pixie/fileformats/ppm as pixie_ppm
import ../image

# Which local files may be decoded straight into the render canvas.
#
# Streaming a file into the canvas writes its pixels over what is there rather
# than compositing them, so it is only equivalent to a normal draw when the
# source cannot be transparent. `bmpIsProvablyOpaque` is the gate for BMP, and
# getting it wrong is not a performance bug — it silently replaces a
# composited draw with an overwriting one.
#
# The streaming branches themselves are `when defined(frameosEmbedded)` and
# guarded by `when compiles(...)`, so a renamed pixie proc would not fail the
# build; it would quietly send the format back to the buffered path, which is
# exactly what `ensureFileReadBudget` refuses on a large file. The API pins
# below are what catch that.

proc fileSource(file: File): JpegSourceProc =
  # Mirrors fileJpegSource in utils/image.nim (private there).
  result = proc(dst: pointer, maxBytes: int): int =
    try:
      file.readBuffer(dst, maxBytes)
    except IOError, OSError:
      0

suite "bmpIsProvablyOpaque":
  proc bmpHeader(bitCount: int, compression: int): string =
    ## Just enough of a BMP header for the predicate: "BM", then the DIB
    ## header at offset 14 with bit count at 28 and compression at 30.
    result = newString(40)
    result[0] = 'B'
    result[1] = 'M'
    result[28] = chr(bitCount and 0xFF)
    result[29] = chr((bitCount shr 8) and 0xFF)
    for i in 0 .. 3:
      result[30 + i] = chr((compression shr (8 * i)) and 0xFF)

  test "24-bit BI_RGB has no alpha channel, so it is safe to stream":
    check bmpIsProvablyOpaque(bmpHeader(24, 0))

  test "palette and 16-bit BI_RGB are safe too":
    for bits in [1, 4, 8, 16]:
      check bmpIsProvablyOpaque(bmpHeader(bits, 0))

  test "32-bit is never proven opaque":
    # The fourth byte is usually padding, but BI_ALPHABITFIELDS and the V4/V5
    # headers can make it real alpha. "Usually" is not a basis for overwriting
    # a canvas.
    check not bmpIsProvablyOpaque(bmpHeader(32, 0))

  test "BI_BITFIELDS and BI_ALPHABITFIELDS are not proven opaque":
    check not bmpIsProvablyOpaque(bmpHeader(24, 3))
    check not bmpIsProvablyOpaque(bmpHeader(24, 6))

  test "RLE-compressed palette bitmaps stay safe":
    check bmpIsProvablyOpaque(bmpHeader(8, 1))
    check bmpIsProvablyOpaque(bmpHeader(4, 2))

  test "a truncated or non-BMP header is never proven opaque":
    check not bmpIsProvablyOpaque("")
    check not bmpIsProvablyOpaque("BM")
    check not bmpIsProvablyOpaque(bmpHeader(24, 0)[0 ..< 30])
    check not bmpIsProvablyOpaque("\x89PNG\r\n\x1a\n" & newString(40))

  test "a real encoded BMP is recognised":
    let image = newImage(8, 4)
    image.fill(rgbx(10, 20, 30, 255))
    check bmpIsProvablyOpaque(encodeBmp(image)[0 ..< 40]) ==
      (encodeBmp(image)[28].uint8.int in [1, 4, 8, 16, 24])

suite "file-backed streaming decoders pixie must keep providing":
  # readImageIntoTarget reaches for these by name on embedded. If pixie renames
  # or re-types one, this test fails loudly instead of the format silently
  # falling back to buffering the whole file.
  let source = newImage(64, 40)
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      source.unsafe[x, y] = rgbx(uint8(x * 4), uint8(y * 6), uint8((x + y)), 255)

  test "BMP streams from a file source into a target":
    let path = getTempDir() / "frameos_test_stream.bmp"
    writeFile(path, encodeBmp(source))
    defer: removeFile(path)
    for fit in [fitCover, fitContain, fitStretch]:
      let target = newImage(32, 32)
      var file: File
      check file.open(path)
      decodeBmpStreamScaledInto(fileSource(file), getFileSize(path).int, target, fit)
      file.close()
      var painted = 0
      for pixel in target:
        if pixel.a > 0: painted += 1
      check painted > 0

  test "PPM streams from a file source into a target":
    let path = getTempDir() / "frameos_test_stream.ppm"
    writeFile(path, encodePpm(source))
    defer: removeFile(path)
    let target = newImage(32, 32)
    var file: File
    check file.open(path)
    decodePpmStreamScaledInto(fileSource(file), getFileSize(path).int, target, fitCover)
    file.close()
    var painted = 0
    for pixel in target:
      if pixel.a > 0: painted += 1
    check painted > 0

echo "test_image_stream_formats: done"
