## A long round-joined stroke (a hand-drawn line: thousands of points once
## flattened) is outlined with the circle's sector on the outer side of each
## turn, not a whole circle at every point, and in pieces when one subpath
## is longer than a batch. The Sketchbook's 713-point eraser stroke took 6 MB
## that way on an ESP32 that had 5 (2026-11-25). The shape is the same: every
## pixel well inside the stroke is covered, every pixel well outside is not,
## so a sector wound against the rectangles (a hole where they overlap) or a
## piece's missing join shows here.

import pixie, std/math

const
  W = 466
  Half = 10.7'f32 # half of the eraser's 21.4 px

# A wave through the panel, as a finger draws it: points a few pixels apart,
# joined by quadratic curves through their midpoints (the Sketchbook's ink).
var points: seq[Vec2]
for i in 0 .. 1400:
  let t = i.float32 / 1400
  points.add vec2(30 + 400 * t, 233 + 150 * sin(t * 9 * PI) * cos(t * 2.3))

let path = newPath()
path.moveTo(points[0])
for i in 1 ..< points.high:
  let mid = (points[i] + points[i + 1]) / 2
  path.quadraticCurveTo(points[i], mid)
path.lineTo(points[^1])

let before = getOccupiedMem()
let image = newImage(W, W)
image.strokePath(path, rgba(0, 0, 0, 255), strokeWidth = 2 * Half, lineCap = RoundCap,
  lineJoin = RoundJoin)
let peak = getMaxMem() - before
doAssert peak < 3_000_000, "a long stroke's outline took " & $peak & " bytes"

proc distanceToLine(p: Vec2): float32 =
  ## How far `p` is from the curve, measured against the points finely
  ## enough (they are under 3 px apart) for the margins below.
  result = float32.high
  for i in 1 .. points.high:
    let
      a = points[i - 1]
      b = points[i]
      ab = b - a
      t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0, 1)
    result = min(result, dist(p, a + ab * t))

# The curve through the midpoints is within a pixel of the points' polyline
# here, so 2.5 px either side of the edge is beyond any doubt.
var inside, outside = 0
for y in countup(0, W - 1, 3):
  for x in countup(0, W - 1, 3):
    let d = distanceToLine(vec2(x.float32 + 0.5, y.float32 + 0.5))
    let a = image[x, y].a
    if d < Half - 2.5:
      doAssert a == 255, "a hole in the stroke at " & $x & "," & $y & " (alpha " & $a & ")"
      inc inside
    elif d > Half + 2.5:
      doAssert a == 0, "ink outside the stroke at " & $x & "," & $y & " (alpha " & $a & ")"
      inc outside
doAssert inside > 1000 and outside > 1000

# A translucent stroke stays one fill (two pieces would show where they
# cross): the same shape, at half the alpha everywhere inside.
let faint = newImage(W, W)
faint.strokePath(path, rgba(0, 0, 0, 128), strokeWidth = 2 * Half, lineCap = RoundCap,
  lineJoin = RoundJoin)
for y in countup(0, W - 1, 3):
  for x in countup(0, W - 1, 3):
    if distanceToLine(vec2(x.float32 + 0.5, y.float32 + 0.5)) < Half - 2.5:
      doAssert faint[x, y].a == 128, "translucent stroke not one fill at " & $x & "," & $y

# A closed shape keeps the join where it closes.
let ring = newPath()
ring.moveTo(233 + 120, 233)
for i in 1 .. 2000:
  let a = i.float32 / 2000 * 2 * PI
  ring.lineTo(233 + 120 * cos(a), 233 + 120 * sin(a))
ring.closePath()
let closed = newImage(W, W)
closed.strokePath(ring, rgba(0, 0, 0, 255), strokeWidth = 2 * Half, lineCap = ButtCap,
  lineJoin = RoundJoin)
for i in 0 ..< 360:
  let a = i.float32 / 360 * 2 * PI
  for r in [120'f32 - Half + 3, 120, 120 + Half - 3]:
    let p = vec2(233 + r * cos(a), 233 + r * sin(a))
    doAssert closed[p.x.int, p.y.int].a == 255, "a gap in the ring at " & $i & " degrees"

echo "stroke round joins: ", peak div 1024, " KB peak, ", inside, " inside and ", outside, " outside checked"
