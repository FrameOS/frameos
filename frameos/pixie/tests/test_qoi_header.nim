import pixie/common, pixie/fileformats/qoi

# A QOI whose header claims more pixels than its data could hold: one op
# byte covers 62 pixels at most, so the decoder refuses it before it
# allocates the picture (fuzz_qoi, 2026-11-24: one byte of the width changed,
# and the decode asked for gigabytes).

let original = readFile("tests/fileformats/qoi/testcard_rgba.qoi")

proc refused(data: string): bool =
  try:
    discard decodeQoi(data)
  except PixieError:
    return true

block:
  let qoi = decodeQoi(original)
  doAssert qoi.width > 0 and qoi.height > 0

block:
  var data = original
  data[5] = char(82) # the width's second byte: about 5.4 million pixels wide
  doAssert refused(data)

block:
  var data = original
  for i in 4 .. 11:
    data[i] = '\xff' # 4 billion by 4 billion
  doAssert refused(data)

block:
  # The header of a 1 by 1 picture and a run that covers it: the smallest
  # picture there is still reads.
  let tiny = "qoif" & "\0\0\0\x01" & "\0\0\0\x01" & "\x04\x00" & "\xc0" &
    "\0\0\0\0\0\0\0\x01"
  let qoi = decodeQoi(tiny)
  doAssert qoi.width == 1 and qoi.height == 1

echo "QOI header bounds: ok"
