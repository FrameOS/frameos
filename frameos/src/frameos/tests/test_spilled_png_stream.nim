# Spilled downloads (HTTP bodies too large for PSRAM, written to SD/SPIFFS)
# must decode PNGs by streaming from the file — never by buffering the body
# back into memory. This pins the pixie API the embedded decodeSpilledImageInto
# path relies on, using the exact source-proc type it passes
# (JpegSourceProc, shared by the JPEG and PNG file-streaming branches).
import std/[os, unittest]
import pixie
import pixie/fileformats/jpeg as pixie_jpeg
import pixie/fileformats/png as pixie_png

proc fileSource(file: File): JpegSourceProc =
  # Mirrors fileJpegSource in utils/image.nim (private there)
  result = proc(dst: pointer, maxBytes: int): int =
    try:
      file.readBuffer(dst, maxBytes)
    except IOError, OSError:
      0

suite "spilled PNG file-backed streaming decode":
  let source = newImage(320, 480)
  for y in 0 ..< source.height:
    for x in 0 ..< source.width:
      source.unsafe[x, y] = rgbx(
        uint8((x * 3) mod 256), uint8((y * 5) mod 256),
        uint8((x + y) mod 256), 255)
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
