## Whole-image operations on the narrow storage formats (`pfRgb565`,
## `pfGray8`: no alpha, read back opaque), shared by the scalar bodies in
## `images.nim` and by every SIMD variant in `simd/`.
##
## The SIMD variants need these too, not just the scalar fallbacks: on amd64
## and arm64 the `hasSimd` macro replaces the scalar body wholesale with a
## call to the SIMD variant, so a format check written only in the scalar
## body is compiled out exactly where the SIMD kernels would then read a 565
## buffer as RGBX. Every image-level SIMD kernel therefore starts with
## `if image.format != pfRgbx: return <the proc here>`.

import chroma, common

when defined(release):
  {.push checks: off.}

proc isOneColor565*(image: Image): bool {.raises: [].} =
  if image.isView:
    return false
  result = true
  if image.format == pfGray8:
    let first = image.data8[0]
    for i in 0 ..< image.dataLen:
      if image.data8[i] != first:
        return false
    return
  let first = image.data16[0]
  for i in 0 ..< image.dataLen:
    if image.data16[i] != first:
      return false

proc applyOpacity565*(image: Image, opacity: uint16) {.raises: [].} =
  ## `opacity` already scaled to 0..255. No alpha to scale, so this scales the
  ## colour — which is what a driver reading RGB off a premultiplied RGBA
  ## canvas would have seen after `applyOpacity` there.
  if image.format == pfGray8:
    image.forEachSpan:
      for i in spanStart ..< spanStart + spanLen:
        image.data8[i] = ((image.data8[i].uint16 * opacity) div 255).uint8
    return
  image.forEachSpan:
    for i in spanStart ..< spanStart + spanLen:
      var rgbx = rgb565ToRgbx(image.data16[i])
      rgbx.r = ((rgbx.r * opacity) div 255).uint8
      rgbx.g = ((rgbx.g * opacity) div 255).uint8
      rgbx.b = ((rgbx.b * opacity) div 255).uint8
      image.data16[i] = rgbxToRgb565(rgbx)

proc invert565*(image: Image) {.raises: [].} =
  ## Complementing each packed field is the exact complement of the expanded
  ## channel: `expand(31 - r) + expand(r) == 255` for every `r`. A grey
  ## inverts the same way.
  if image.format == pfGray8:
    image.forEachSpan:
      for i in spanStart ..< spanStart + spanLen:
        image.data8[i] = not image.data8[i]
    return
  image.forEachSpan:
    for i in spanStart ..< spanStart + spanLen:
      image.data16[i] = not image.data16[i]

proc ceil565*(image: Image) {.raises: [].} =
  if image.format == pfGray8:
    image.forEachSpan:
      for i in spanStart ..< spanStart + spanLen:
        image.data8[i] = if image.data8[i] == 0: 0 else: 255
    return
  image.forEachSpan:
    for i in spanStart ..< spanStart + spanLen:
      var rgbx = rgb565ToRgbx(image.data16[i])
      rgbx.r = if rgbx.r == 0: 0 else: 255
      rgbx.g = if rgbx.g == 0: 0 else: 255
      rgbx.b = if rgbx.b == 0: 0 else: 255
      image.data16[i] = rgbxToRgb565(rgbx)

when defined(release):
  {.pop.}
