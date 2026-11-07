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
    let cached = make(kind)
    cached.draw(box, shape, vec2(3.4, 2.75), view)
    let misses = coverageCacheMisses
    doAssert misses == 4, "every element a miss the first time: " & $misses
    doAssert coverageCacheHits == 0
    let again = make(kind)
    again.draw(box, shape, vec2(3.4, 2.75), view)
    doAssert coverageCacheHits == 4, "the second draw is hits: " & $coverageCacheHits
    doAssert coverageCacheMisses == misses
    let diff = maxDiff(plain, cached)
    doAssert diff <= tolerance(kind), kind & " view=" & $view & ": cached differs from a fresh fill by " & $diff
    doAssert differing(plain, cached) <= plain.width * plain.height div 200, kind & ": " & $differing(plain, cached) & " pixels differ"
    doAssert maxDiff(cached, again) == 0
    # A different fractional offset is another mask.
    let moved = make(kind)
    moved.draw(box, shape, vec2(3.9, 2.75), view)
    doAssert coverageCacheMisses == misses + 4
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
doAssert coverageCacheUsedBytes() == 0, "a 120x60 mask does not fit 3 KB"
coverageCacheBudget = 0
echo "coverage cache ok"
