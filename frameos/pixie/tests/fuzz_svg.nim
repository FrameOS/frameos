import pixie/common, pixie/fileformats/svg, random, strformat

randomize()

let original = readFile("tests/fileformats/svg/Ghostscript_Tiger.svg")

for i in 0 ..< 10_000:
  var data = original
  let
    pos = rand(data.len - 1)
    value = rand(255).char
  data[pos] = value
  echo &"{i} {pos} {value}"
  try:
    # decodeSvg, as this was written for, is parseSvg + newImage now.
    discard newImage(parseSvg(data, 200, 200))
  except PixieError:
    discard
