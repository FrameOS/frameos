import pixie/common, pixie/inflatestream

# A raw deflate stream made against a preset dictionary (zlib's
# deflateSetDictionary; Python: zlib.compressobj(9, DEFLATED, -15, 8,
# Z_DEFAULT_STRATEGY, dictionary)): its back-references reach before the
# output's first byte, into the dictionary, which is read where it lies (the
# indexed font's raw blocks, for its deflated ones).

let
  dictionary = "the quick brown fox jumps over the lazy dog; the quick brown fox jumps over the lazy dog; the quick brown fox jumps over the lazy dog; "
  expected = "over the lazy dog, the quick brown fox jumps; then the dog sleeps. over the lazy dog, the quick brown fox jumps; then the dog sleeps. "
  stream = "\xc3\x10\xd2\xc1\xad\x1f\x6c\x74\x1e\x58\x1e\xa8\x50\xa1\x38\x27\x35\xb5\xa0\x58\x8f\x1a\x46\x00\x00"

block:
  let got = uncompressDeflate(stream[0].unsafeAddr, stream.len, expected.len,
    dictionary[0].unsafeAddr, dictionary.len)
  doAssert got == expected

block:
  # Without the dictionary, or with less of it than the stream reaches back
  # into, the stream is refused.
  for dictLen in [0, 10]:
    var refused = false
    try:
      let tail = if dictLen == 0: nil else: dictionary[dictionary.len - dictLen].unsafeAddr
      discard uncompressDeflate(stream[0].unsafeAddr, stream.len, expected.len, tail, dictLen)
    except PixieError:
      refused = true
    doAssert refused, $dictLen

block:
  # Not sized in advance: the 64 KB window's buffer reads the dictionary the
  # same way.
  let got = uncompressDeflate(stream[0].unsafeAddr, stream.len, 0,
    dictionary[0].unsafeAddr, dictionary.len)
  doAssert got == expected

echo "inflate with a preset dictionary: ok"
