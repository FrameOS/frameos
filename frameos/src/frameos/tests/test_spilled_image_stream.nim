# Spilled downloads (HTTP bodies too large for PSRAM, written to SD/SPIFFS)
# must decode by streaming from the file — never by buffering the body back
# into memory. This pins the pixie API the embedded decodeSpilledImageInto
# path relies on, using the exact source-proc type it passes (JpegSourceProc,
# an alias of ImageSourceProc shared by every file-streaming branch).
#
# decodeSpilledImageInto guards each branch with `when compiles(...)`, so a
# renamed or re-typed pixie proc would not fail the build — it would silently
# turn that format back into "no file-backed streaming decoder" at runtime.
# These tests are what catches that.
import std/[os, unittest]
import pixie
import pixie/fileformats/bmp as pixie_bmp
import pixie/fileformats/jpeg as pixie_jpeg
import pixie/fileformats/png as pixie_png
import pixie/fileformats/ppm as pixie_ppm

proc fileSource(file: File): JpegSourceProc =
  # Mirrors fileJpegSource in utils/image.nim (private there)
  result = proc(dst: pointer, maxBytes: int): int =
    try:
      file.readBuffer(dst, maxBytes)
    except IOError, OSError:
      0

let source = newImage(320, 480)
for y in 0 ..< source.height:
  for x in 0 ..< source.width:
    source.unsafe[x, y] = rgbx(
      uint8((x * 3) mod 256), uint8((y * 5) mod 256),
      uint8((x + y) mod 256), 255)

suite "spilled PNG file-backed streaming decode":
  let encoded = encodePng(source)
  let path = getTempDir() / "frameos_test_spilled.png"
  writeFile(path, encoded)
  defer: removeFile(path)

  test "streams from a file source, pixel-identical to buffered decode":
    for fit in [fitCover, fitContain, fitStretch]:
      let expected = newImage(120, 90)
      var buffered = encoded
      discard decodeImageScaledInto(buffered, expected, fit)

      var file: File
      check file.open(path)
      let target = newImage(120, 90)
      # JpegSourceProc must satisfy the PNG source parameter: this is the
      # call shape decodeSpilledImageInto makes under `when compiles`, so a
      # type mismatch here means the device branch silently compiles out.
      decodePngStreamScaledInto(fileSource(file), encoded.len, target, fit)
      file.close()

      for i in 0 ..< target.data.len:
        check target.data[i] == expected.data[i]

  test "truncated spill files fail with a catchable error":
    let truncatedPath = getTempDir() / "frameos_test_spilled_truncated.png"
    writeFile(truncatedPath, encoded[0 ..< encoded.len div 2])
    defer: removeFile(truncatedPath)
    var file: File
    check file.open(truncatedPath)
    defer: file.close()
    let target = newImage(64, 48)
    expect PixieError:
      decodePngStreamScaledInto(fileSource(file), encoded.len, target, fitCover)

suite "spilled BMP file-backed streaming decode":
  # Bottom-up rows, the layout every encoder in the wild writes: the streaming
  # engine walks them in file order and maps them to descending target rows.
  let encoded = encodeBmp(source)
  let path = getTempDir() / "frameos_test_spilled.bmp"
  writeFile(path, encoded)
  defer: removeFile(path)

  test "streams from a file source, pixel-identical to buffered decode":
    for fit in [fitCover, fitContain, fitStretch]:
      let expected = newImage(120, 90)
      var buffered = encoded
      decodeBmpScaledInto(buffered, expected, fit)

      var file: File
      check file.open(path)
      let target = newImage(120, 90)
      decodeBmpStreamScaledInto(fileSource(file), encoded.len, target, fit)
      file.close()

      for i in 0 ..< target.data.len:
        check target.data[i] == expected.data[i]

  test "truncated spill files fail with a catchable error":
    let truncatedPath = getTempDir() / "frameos_test_spilled_truncated.bmp"
    writeFile(truncatedPath, encoded[0 ..< encoded.len div 2])
    defer: removeFile(truncatedPath)
    var file: File
    check file.open(truncatedPath)
    defer: file.close()
    let target = newImage(64, 48)
    expect PixieError:
      decodeBmpStreamScaledInto(fileSource(file), encoded.len, target, fitCover)

suite "spilled PPM file-backed streaming decode":
  let encoded = encodePpm(source)
  let path = getTempDir() / "frameos_test_spilled.ppm"
  writeFile(path, encoded)
  defer: removeFile(path)

  test "streams from a file source, pixel-identical to buffered decode":
    # PPM has no buffered scaled decoder to compare against (decodeImageScaled
    # would fall back to decode-then-resize, which interpolates), so the
    # reference is the full decode sampled with the same nearest-neighbour
    # mapping the streaming engine uses. Pixels outside the fitted rect stay
    # untouched by contract — both images start zeroed, so a whole-buffer
    # comparison still pins that.
    let full = decodePpm(encoded)
    for fit in [fitCover, fitContain, fitStretch]:
      let expected = newImage(120, 90)
      let rects = scaledFitRects(full.width, full.height,
        expected.width, expected.height, fit)
      for y in rects.dstY ..< rects.dstY + rects.dstH:
        let srcY = min(rects.srcY + ((y - rects.dstY) * rects.srcH) div
          rects.dstH, full.height - 1)
        for x in rects.dstX ..< rects.dstX + rects.dstW:
          let srcX = min(rects.srcX + ((x - rects.dstX) * rects.srcW) div
            rects.dstW, full.width - 1)
          expected.unsafe[x, y] = full.unsafe[srcX, srcY]

      var file: File
      check file.open(path)
      let target = newImage(120, 90)
      decodePpmStreamScaledInto(fileSource(file), encoded.len, target, fit)
      file.close()

      for i in 0 ..< target.data.len:
        check target.data[i] == expected.data[i]
