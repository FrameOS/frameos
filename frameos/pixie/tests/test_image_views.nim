## A view is a window onto an owner's pixels: every draw into it must stay
## inside its rectangle. The antialiased fill kernels take row-by-row paths,
## but the fast paths in fillShapes (one flat multi-row fill when a partition
## spans the whole width) and clearUnsafe (the MaskBlend clear) assumed rows
## sat back to back — true for an owner, false for a view — and spilled into
## the owner's pixels beside the view.

import pixie, pixie/fileformats/svg

proc outside(owner: Image, x, y, w, h: int, background: ColorRGBX): int =
  ## Pixels outside the view's rectangle that are no longer the background.
  for py in 0 ..< owner.height:
    for px in 0 ..< owner.width:
      if px >= x and px < x + w and py >= y and py < y + h:
        continue
      if owner.unsafe[px, py] != background:
        inc result

proc inside(owner: Image, x, y, w, h: int, color: ColorRGBX): int =
  for py in y ..< y + h:
    for px in x ..< x + w:
      if owner.unsafe[px, py] == color:
        inc result

let
  white = rgbx(255, 255, 255, 255)
  cyan = rgbx(0, 255, 255, 255)

template eachFormat(body: untyped) =
  block:
    let owner {.inject.} = newImage(40, 30)
    owner.fill(white)
    body
  block:
    let owner {.inject.} = newImage565(40, 30)
    owner.fill(white)
    body

block whole_view_rect_fill_stays_inside:
  # The rect covers the whole view: the greedy multi-row fill path.
  eachFormat:
    let v = owner.view(36, 20, 2, 2)
    let path = newPath()
    path.rect(0, 0, 10, 10)
    v.fillPath(path, cyan)
    doAssert owner.inside(36, 20, 2, 2, cyan) == 4
    doAssert owner.outside(36, 20, 2, 2, white) == 0

block stroke_across_view_stays_inside:
  eachFormat:
    let v = owner.view(36, 20, 2, 2)
    let path = newPath()
    path.moveTo(0, 1)
    path.lineTo(10, 1)
    v.strokePath(path, cyan, strokeWidth = 2)
    doAssert owner.inside(36, 20, 2, 2, cyan) == 4
    doAssert owner.outside(36, 20, 2, 2, white) == 0

block svg_into_view_stays_inside:
  eachFormat:
    let v = owner.view(36, 20, 2, 2)
    let image = parseSvg("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2">
      <rect width="2" height="2" fill="#00ffff"/></svg>""", 2, 2)
    image.renderInto(v)
    doAssert owner.inside(36, 20, 2, 2, cyan) == 4
    doAssert owner.outside(36, 20, 2, 2, white) == 0

block mask_fill_in_view_clears_only_the_view:
  # MaskBlend keeps the shape and clears the rest of the TARGET — the view,
  # never the owner around it.
  block:
    let owner = newImage(40, 30)
    owner.fill(white)
    let v = owner.view(10, 10, 20, 10)
    let path = newPath()
    path.rect(5, 2, 10, 6)
    let paint = newPaint(SolidPaint)
    paint.color = color(0, 1, 1, 1)
    paint.blendMode = MaskBlend
    v.fillPath(path, paint)
    doAssert owner.outside(10, 10, 20, 10, white) == 0
    doAssert owner.unsafe[16, 13] == white, $owner.unsafe[16, 13]
    doAssert owner.unsafe[11, 11] == rgbx(0, 0, 0, 0), $owner.unsafe[11, 11]

block fractional_fill_in_view:
  eachFormat:
    let v = owner.view(30, 10, 8, 8)
    let path = newPath()
    path.circle(4, 4, 3.5)
    v.fillPath(path, cyan)
    doAssert owner.inside(30, 10, 8, 8, cyan) > 10
    doAssert owner.outside(30, 10, 8, 8, white) == 0

echo "test_image_views: ok"
