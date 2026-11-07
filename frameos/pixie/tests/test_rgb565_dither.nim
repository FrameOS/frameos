## Dithered stores on a 565 surface (`ditherStores`): a smooth gradient
## must not collapse into plateaus, re-storing what was read back must not
## drift, and the local mean must track the RGBX result.

import pixie

proc sky(img: Image) =
  let paint = newPaint(LinearGradientPaint)
  paint.gradientHandlePositions = @[vec2(0, 0), vec2(0, img.height.float32)]
  paint.gradientStops = @[
    ColorStop(color: color(0.10, 0.30, 0.60, 1), position: 0),
    ColorStop(color: color(0.55, 0.75, 0.95, 1), position: 1)]
  var p = newPath()
  p.rect(0, 0, img.width.float32, img.height.float32)
  img.fillPath(p, paint)

proc rowMeanBlueLevels(img: Image): int =
  ## How many distinct row-averaged blue values the gradient holds.
  var seen: seq[int]
  for y in 0 ..< img.height:
    var sum = 0
    for x in 0 ..< img.width:
      sum += img.unsafe[x, y].b.int
    let mean = (sum + img.width div 2) div img.width
    if mean notin seen:
      seen.add(mean)
  seen.len

block: # plain 565 plateaus, dithered 565 does not
  let
    plain = newImage565(800, 480)
    dithered = newImage565(800, 480)
    rgbx = newImage(800, 480)
  dithered.ditherStores = true
  plain.sky()
  dithered.sky()
  rgbx.sky()
  let
    plainLevels = plain.rowMeanBlueLevels()
    ditheredLevels = dithered.rowMeanBlueLevels()
    rgbxLevels = rgbx.rowMeanBlueLevels()
  doAssert plainLevels < 20, $plainLevels          # 11 when written
  doAssert ditheredLevels > rgbxLevels - 10, $ditheredLevels & " vs " & $rgbxLevels

  # The local mean tracks RGBX: every row's average blue is within one
  # couple of 8-bit units of the RGBX row average (one 5-bit step is 8).
  for y in 0 ..< 480:
    var a, b = 0
    for x in 0 ..< 800:
      a += dithered.unsafe[x, y].b.int
      b += rgbx.unsafe[x, y].b.int
    doAssert abs(a - b) <= 1600, "row " & $y & " mean drifts by " & $(abs(a - b) / 800)

block: # idempotent: storing what was read changes nothing
  let img = newImage565(320, 200)
  img.ditherStores = true
  img.sky()
  var before = newSeq[ColorRGBX](320 * 200)
  for y in 0 ..< 200:
    for x in 0 ..< 320:
      before[y * 320 + x] = img.unsafe[x, y]
  for round in 0 ..< 3:
    for y in 0 ..< 200:
      for x in 0 ..< 320:
        img.unsafe[x, y] = img.unsafe[x, y]
  for y in 0 ..< 200:
    for x in 0 ..< 320:
      doAssert before[y * 320 + x] == img.unsafe[x, y]

block: # exact colours stay exact: a solid fill is one value everywhere
  let img = newImage565(64, 64)
  img.ditherStores = true
  img.fill(rgbx(255, 255, 255, 255))
  for y in 0 ..< 64:
    for x in 0 ..< 64:
      doAssert img.unsafe[x, y] == rgbx(255, 255, 255, 255)
  img.fill(rgbx(0, 0, 0, 255))
  for y in 0 ..< 64:
    for x in 0 ..< 64:
      doAssert img.unsafe[x, y] == rgbx(0, 0, 0, 255)

block: # views inherit the flag
  let img = newImage565(64, 64)
  img.ditherStores = true
  doAssert img.view(8, 8, 16, 16).ditherStores

echo "test_rgb565_dither ok"
