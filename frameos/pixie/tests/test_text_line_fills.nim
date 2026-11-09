## Text is filled a line at a time (fonts.nim `linePaths`), for what the fill
## allocates: the pixels and the bounds are the ones a single path makes.

import pixie, strutils

let font = readFont("tests/fonts/Roboto-Regular_1.ttf")
font.size = 24
font.paint.color = color(0, 0, 0, 1)

let arrangement = font.typeset(
  repeat("The quick brown fox jumps over the lazy dog. ", 12),
  bounds = vec2(380, 0)
)
doAssert arrangement.lines.len > 3, "the text wraps"

let lines = newImage(400, 400)
lines.fill(color(1, 1, 1, 1))
lines.fillText(arrangement, translate(vec2(8.25, 6.5)))

let whole = newImage(400, 400)
whole.fill(color(1, 1, 1, 1))
whole.fillPath(arrangement.computePath(), font.paint, translate(vec2(8.25, 6.5)))

var differing, largest = 0
for i in 0 ..< lines.dataLen:
  let d = max(max(abs(lines.data[i].r.int - whole.data[i].r.int), abs(lines.data[i].g.int - whole.data[i].g.int)),
    abs(lines.data[i].b.int - whole.data[i].b.int))
  if d > 0:
    inc differing
    largest = max(largest, d)
doAssert differing == 0, "a fill per line draws what one path draws: " & $differing & " pixels, up to " & $largest

let transform = translate(vec2(3, 4))
let bounds = arrangement.computeBounds(transform)
let wholeBounds = arrangement.computePath().computeBounds(transform)
doAssert abs(bounds.x - wholeBounds.x) < 0.001 and abs(bounds.y - wholeBounds.y) < 0.001
doAssert abs(bounds.w - wholeBounds.w) < 0.001 and abs(bounds.h - wholeBounds.h) < 0.001
echo "ok"
