## A shape's antialiased edge comes out the same wherever its image sits in
## memory. The SIMD loops of a coverage fill (simd/sse2.nim, avx2.nim) start
## at the row's first 16-byte-aligned pixel and leave the pixels before it,
## and the last few, to the scalar loop: both must round a colour times its
## coverage the same way (`rgbx * coverage`, common.nim). The SIMD one
## truncated, so the same element drawn into two buffers differed by a step
## in some edge pixels, as the buffers' addresses fell, and FrameOS's
## test_ui_layout "a tree that did not change" failed under -d:useMalloc.

import pixie

proc drawnAt(shift: int): Image =
  ## A rounded box drawn over a backdrop into an image whose pixels start
  ## `shift` pixels (4 bytes each) past a 16-byte boundary: a view into a
  ## wider image.
  let wide = newImage(160 + 8, 80)
  wide.fill(rgba(20, 30, 60, 255))
  let view = wide.view(shift, 0, 160, 80)
  let path = newPath()
  path.roundedRect(10.3, 7.6, 120, 60, 12, 12, 12, 12)
  view.fillPath(path, rgba(252, 211, 77, 255))
  # A translucent colour too: the blend after the coverage.
  view.fillPath(path, rgba(255, 255, 255, 90))
  result = newImage(160, 80)
  for y in 0 ..< 80:
    for x in 0 ..< 160:
      result.unsafe[x, y] = view.unsafe[x, y]

block:
  let first = drawnAt(0)
  for shift in 1 .. 3:
    let other = drawnAt(shift)
    var differing = 0
    for y in 0 ..< 80:
      for x in 0 ..< 160:
        if first.unsafe[x, y] != other.unsafe[x, y]:
          inc differing
    doAssert differing == 0, $differing & " pixels differ at a shift of " & $shift

echo "coverage rounding ok"
