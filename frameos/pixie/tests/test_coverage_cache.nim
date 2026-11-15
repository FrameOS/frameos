## The coverage cache (paths.nim): a shared path drawn from its kept mask
## paints what a fresh fill paints, on every surface, through a view, and
## the second draw is a hit. The mask is rasterized at the offset's fraction
## with the integer part taken off, so float rounding can move an edge
## pixel's coverage by a unit or two: a handful of edge pixels may differ by
## one quantisation step of the surface (8 on 565's 5-bit channels).

import pixie, pixie/paths, pixie/fileformats/svg

proc roundedBox(): Path =
  result = newPath()
  result.roundedRect(10.3, 7.6, 120, 60, 12, 12, 12, 12)
  result.share()

proc blob(): Path =
  result = newPath()
  result.moveTo(5, 30)
  result.quadraticCurveTo(40, -10, 80, 30)
  result.bezierCurveTo(90, 60, 20, 70, 5, 30)
  result.closePath()
  result.share()

proc tolerance(kind: string): int =
  if kind == "565": 8 else: 2

proc differing(a, b: Image): int =
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a.unsafe[x, y] != b.unsafe[x, y]: inc result

proc maxDiff(a, b: Image): int =
  doAssert a.width == b.width and a.height == b.height
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let
        p = a.unsafe[x, y]
        q = b.unsafe[x, y]
      result = max(result, max(abs(p.r.int - q.r.int), max(abs(p.g.int - q.g.int),
        max(abs(p.b.int - q.b.int), abs(p.a.int - q.a.int)))))

proc draw(target: Image, box, blob: Path, offset: Vec2, view: bool) =
  var image = target
  if view:
    image = target.view(8, 8, target.width - 16, target.height - 16)
  let shift = if view: vec2(-8, -8) else: vec2(0, 0)
  image.fill(rgba(255, 255, 255, 255))
  image.fillPath(box, rgba(30, 90, 200, 255), translate(offset + shift))
  image.fillPath(box, rgba(200, 40, 40, 90), translate(offset + shift + vec2(40.25, 20.5)))
  image.fillPath(blob, rgba(10, 160, 60, 255), translate(offset + shift + vec2(150.7, 30.1)))
  image.strokePath(blob, rgba(0, 0, 0, 255), translate(offset + shift + vec2(150.7, 30.1)),
    strokeWidth = 2.5, lineCap = RoundCap, lineJoin = RoundJoin)
  # An icon: its viewBox scales it.
  image.strokePath(blob, rgba(90, 0, 120, 255),
    translate(offset + shift + vec2(30.2, 90.6)) * scale(vec2(0.75, 0.75)),
    strokeWidth = 2, lineCap = RoundCap, lineJoin = RoundJoin)

proc make(kind: string): Image =
  case kind
  of "565": newImage565(300, 160)
  of "gray8": newImageGray8(300, 160)
  else: newImage(300, 160)

for kind in ["rgbx", "565", "gray8"]:
  for view in [false, true]:
    let
      box = roundedBox()
      shape = blob()
    coverageCacheBudget = 0
    let plain = make(kind)
    plain.draw(box, shape, vec2(3.4, 2.75), view)
    coverageCacheBudget = 4 * 1024 * 1024
    clearCoverageCache()
    coverageCacheHits = 0
    coverageCacheMisses = 0
    let first = make(kind)
    first.draw(box, shape, vec2(3.4, 2.75), view) # seen once: filled as always
    doAssert coverageCacheMisses == 0 and coverageCacheHits == 0
    doAssert maxDiff(plain, first) == 0
    let cached = make(kind)
    cached.draw(box, shape, vec2(3.4, 2.75), view)
    let misses = coverageCacheMisses
    doAssert misses == 5, "every element a miss the second time: " & $misses
    doAssert coverageCacheHits == 0
    let again = make(kind)
    again.draw(box, shape, vec2(3.4, 2.75), view)
    doAssert coverageCacheHits == 5, "the second draw is hits: " & $coverageCacheHits
    doAssert coverageCacheMisses == misses
    let diff = maxDiff(plain, cached)
    doAssert diff <= tolerance(kind), kind & " view=" & $view & ": cached differs from a fresh fill by " & $diff
    doAssert differing(plain, cached) <= plain.width * plain.height div 200, kind & ": " & $differing(plain, cached) & " pixels differ"
    doAssert maxDiff(cached, again) == 0
    # A different fractional offset is another mask.
    let moved = make(kind)
    moved.draw(box, shape, vec2(3.9, 2.75), view)
    moved.draw(box, shape, vec2(3.9, 2.75), view)
    doAssert coverageCacheMisses == misses + 5
    coverageCacheBudget = 0
    let movedPlain = make(kind)
    movedPlain.draw(box, shape, vec2(3.9, 2.75), view)
    doAssert maxDiff(moved, movedPlain) <= tolerance(kind)
    clearCoverageCache()
    doAssert coverageCacheUsedBytes() == 0

# The budget: masks beyond it are drawn but not kept.
coverageCacheBudget = 3000
clearCoverageCache()
let small = make("rgbx")
let box = roundedBox()
small.fillPath(box, rgba(0, 0, 0, 255), translate(vec2(1, 1)))
small.fillPath(box, rgba(0, 0, 0, 255), translate(vec2(1, 1)))
doAssert coverageCacheUsedBytes() == 0, "a 120x60 mask does not fit 3 KB"

# An animation: a path at fifty fractions over and over (the JSX DVD bounce
# at `Date.now()`'s whole milliseconds), in a budget of two masks, beside a
# label drawn where it always is. The second-sight rule alone made a mask
# for nearly every frame of it, each evicted before its fraction came back;
# moving now, it is drawn at quarter pixels (snapMoving), five masks over
# the pixel it crosses, and nearly every draw is a hit.
block:
  coverageCacheBudget = 20 * 1024
  clearCoverageCache()
  let
    canvas = make("rgbx")
    moving = roundedBox()
    label = blob()
  var churnMisses, movingHits, labelHits: int
  for round in 0 ..< 4:
    for i in 0 ..< 50:
      let (misses0, hits0) = (coverageCacheMisses, coverageCacheHits)
      canvas.fillPath(moving, rgba(0, 0, 0, 255), translate(vec2(20 + i.float32 / 50, 10)))
      if round >= 2:
        churnMisses += coverageCacheMisses - misses0
        movingHits += coverageCacheHits - hits0
      let hits1 = coverageCacheHits
      canvas.fillPath(label, rgba(0, 0, 255, 255), translate(vec2(150.5, 40.25)))
      if round >= 2: labelHits += coverageCacheHits - hits1
  doAssert churnMisses <= 10, "the moving path keeps making masks: " & $churnMisses & " in 100 draws"
  doAssert movingHits >= 90, "the moving path is drawn from its masks: " & $movingHits & " hits in 100 draws"
  doAssert labelHits == 100, "the label's mask is hit every draw: " & $labelHits

# Snapping is for paths that move, and only once they have: a path filled
# where it always is, or at a few places in turn (one icon on several cards),
# keeps the exact fraction and the pixels a fill without the cache paints.
block:
  for places in [1, 3, 4]:
    coverageCacheBudget = 4 * 1024 * 1024
    clearCoverageCache()
    let shape = blob()
    var canvas: Image
    for round in 0 ..< 30:
      canvas = make("565")
      for k in 0 ..< places:
        canvas.fillPath(shape, rgba(10, 160, 60, 255), translate(vec2(10.37 + k.float32 * 60.13, 20.61)))
    coverageCacheBudget = 0
    let plain = make("565")
    for k in 0 ..< places:
      plain.fillPath(shape, rgba(10, 160, 60, 255), translate(vec2(10.37 + k.float32 * 60.13, 20.61)))
    # A mask's rounding: a few edge pixels a step of 565's channels apart.
    doAssert maxDiff(canvas, plain) <= 12 and differing(canvas, plain) <= 8 * places,
      $places & " places: " & $maxDiff(canvas, plain) & ", " & $differing(canvas, plain) & " pixels"
    # The same pixels to the last one as a fill at the exact fraction,
    # not at the quarter pixel 10.37 would snap to.
    let snapped = make("565")
    for k in 0 ..< places:
      snapped.fillPath(shape, rgba(10, 160, 60, 255), translate(vec2(round((10.37 + k.float32 * 60.13) * 4) / 4, 20.5)))
    doAssert differing(canvas, plain) < differing(snapped, plain), $places & " places drawn snapped"

# A moving path's fills, cached or not, are where a fill at the nearest
# quarter pixel would be: within an eighth of a pixel of the exact one.
block:
  coverageCacheBudget = 4 * 1024 * 1024
  clearCoverageCache()
  let shape = blob()
  for i in 0 ..< 40:
    let canvas = make("rgbx")
    canvas.fill(rgba(255, 255, 255, 255))
    let at = vec2(30 + i.float32 * 1.37, 12 + i.float32 * 0.71)
    canvas.fillPath(shape, rgba(10, 160, 60, 255), translate(at))
    if i >= 20:
      coverageCacheBudget = 0
      let quarter = make("rgbx")
      quarter.fill(rgba(255, 255, 255, 255))
      quarter.fillPath(shape, rgba(10, 160, 60, 255),
        translate(vec2(round(at.x * 4) / 4, round(at.y * 4) / 4)))
      coverageCacheBudget = 4 * 1024 * 1024
      doAssert maxDiff(canvas, quarter) <= tolerance("rgbx"), "draw " & $i & ": " & $maxDiff(canvas, quarter)
coverageCacheBudget = 0
echo "coverage cache ok"
