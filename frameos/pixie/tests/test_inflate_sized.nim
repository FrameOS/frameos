import pixie/common, pixie/inflatestream, std/random, zippy

# A raw deflate stream told a size smaller than it holds, at every size near
# the window (32 KB). The inflater sizes its buffer by the size it is told,
# and a buffer just over the window used to leave less room after a window
# flush than one match writes: up to 270 bytes past the buffer (found by
# fuzz_inflate, seed 46206826 round 252, under AddressSanitizer). A stream
# that holds more than it said now ends in all of its bytes or a PixieError,
# never in a write outside the buffer.

proc text(size: int): string =
  ## Runs and copies, so the stream is mostly long matches.
  var rng = initRand(7)
  result = newStringOfCap(size)
  while result.len < size:
    if result.len < 64 or rng.rand(9) == 0:
      result.add rng.rand(255).char
    else:
      let distance = rng.rand(1 .. min(result.len, 32768))
      for _ in 0 ..< rng.rand(3 .. 258):
        result.add result[result.len - distance]
  result.setLen(size)

let
  original = text(48_000)
  stream = compress(original, BestSpeed, dfDeflate)

var refused, whole = 0
for told in countup(32_200, 33_100, 3):
  try:
    let got = uncompressDeflate(stream[0].unsafeAddr, stream.len, told)
    doAssert got == original, $told
    inc whole
  except PixieError:
    inc refused

# Told the truth, or nothing, it is the text.
doAssert uncompressDeflate(stream[0].unsafeAddr, stream.len, original.len) == original
doAssert uncompressDeflate(stream[0].unsafeAddr, stream.len, 0) == original

echo "inflate told a smaller size: ok (", whole, " whole, ", refused, " refused)"
