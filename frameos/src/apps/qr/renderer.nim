# Copied from:
# https://raw.githubusercontent.com/aruZeta/QRgen/main/src/QRgen/renderer.nim
#
# Adapted to support variable width padding

## # An optional QR renderer using pixie
##
## This module contains a QR renderer using pixie, which can be used to render
## QR's into PNG images (and any format pixie supports) with an almost equal
## API to `printSvg` (some parameter names vary, you can specify the size in
## pixels of the resulting image).
## You can find pixie `here<https://github.com/treeform/pixie>`_.
##
## As said, this module requires the pixie nimble package, and it's also not
## exported by default, so to avoid requiring pixie for the whole project
## when `printSvg` does not use it.

import
  QRgen/private/[
    DrawedQRCode/DrawedQRCode,
    DrawedQRCode/print,
    Drawing,
    qrTypes
  ],
  pkg/[pixie]

template size: uint8 =
  ## Helper template to get the size of the passed `DrawedQRCode`'s `drawing`.
  self.drawing.size

func genDefaultCoords(self: DrawedQRCode): tuple[x, y, w, h: uint8] =
  let size: uint8 = (self.drawing.size div (
    case self.ecLevel
    of qrECL: 24
    of qrECM: 12
    of qrECQ: 6
    of qrECH: 3
  ) div 2) * 2 + 1
  let margin: uint8 = (self.drawing.size - size) div 2
  result = (
    x: margin,
    y: margin,
    w: size,
    h: size
  )

proc renderImg*(
  self: DrawedQRCode,
  light: string = "#ffffff",
  dark: string = "#000000",
  alRad: Percentage = 0,
  moRad: Percentage = 0,
  moSep: Percentage = 0,
  pixels: uint32 = 512,
  padding: uint8 = 2,
  img: Image = Image(width: 0, height: 0),
  imgCoords: tuple[x, y, w, h: uint8] = self.genDefaultCoords
): Image =
  ## Print a `DrawedQRCode` in PNG format (returned as a `Image` from pixie).
  ##
  ## .. note:: You can pass the hexadecimal color values light and dark,
  ##    which represent the background color and the dark module's color,
  ##    respectively. By default light is white (`#ffffff`) and dark is black
  ##    (`#000000`).
  ##
  ## .. note:: You can make the alignment patterns circles by passing `alRad`,
  ##    and the modules by passing `moRad`. These values are a `Percentage`, a
  ##    value between `0` and `100` (inclusive) which determines the roundness,
  ##    `0` being a square and `100` a perfect circle. By default these are set
  ##    to `0`.
  ##
  ## .. note:: You can separate the modules from each other by
  ##    specifying `moSep`, which is a `Percentage`, a value between `0`
  ##    and `100` (inclusive) which determines the separation, `0` being no
  ##    separation and `100` making the modules minuscule. By default it is
  ##    `0`, and the recommended max value is `25`.
  ##
  ## .. note:: You can embed an `Image` in the generated QR code, as a logo for
  ##    example, by passinng it to `img`.
  ##
  ## .. note:: By default the embedded `Image` will be drawed in the center of
  ##    the QR, and it's size will vary depending on the `ecLevel` the QR code
  ##    was made with, the higher the `ecLevel` the bigger the embedded image
  ##    will be. You can change this by setting `imgCoords`, which contains a
  ##    tuple with the `x,y` position of `img` and it's width an height.
  echo("pixels: " & $pixels & ", drawing.size: " & $self.drawing.size & ", padding: " & $padding)
  let
    modules: uint8 = self.drawing.size + padding * 2
    modulePixels: uint16 = (pixels div modules).uint16
    pixelsMargin: uint16 = (pixels mod modules).uint16 div 2 + modulePixels*(padding)
    actualSize: uint32 = modulePixels.uint32*(modules-(padding * 2)) + (pixelsMargin+1)*2
  let pixels: uint32 =
    if actualSize < pixels: actualSize
    else: pixels
  echo("modules: " & $modules & ", modulePixels: " & $modulePixels &
      ", pixelsMargin: " & $pixelsMargin & ", actualSize: " & $actualSize & ", pixels: " & $pixels)
  result = newImage(pixels.int, pixels.int)
  result.fill(light)
  let ctx: Context = result.newContext
  ctx.fillStyle = dark
  ctx.strokeStyle = dark
  template calcPos(modulePos: uint8): float32 =
    (pixelsMargin + modulePos * modulePixels).float32
  template drawRegion(ax, bx, ay, by: uint8, f: untyped) {.dirty.} =
    for y in ay..<by:
      for x in ax..<bx:
        if self.drawing[x, y]:
          let pos = vec2(x.calcPos + moSepPx, y.calcPos + moSepPx)
          f
  template drawQRModulesOnly(f: untyped) {.dirty.} =
    drawRegion 0'u8, size, 7'u8, size-7, f
    drawRegion 7'u8, size-7, 0'u8, 7'u8, f
    drawRegion 7'u8, size, size-7, size, f
  if moRad > 0 or moSep > 0:
    let
      moSepPx: float32 = modulePixels.float32 * 0.4 * moSep / 100
      s: Vec2 = vec2(
        modulePixels.float32 - moSepPx*2,
        modulePixels.float32 - moSepPx*2
      )
      moRadPx: float32 = (modulePixels.float32 / 2 - moSepPx) * moRad / 100
    drawQRModulesOnly ctx.fillRoundedRect(rect(pos, s), moRadPx)
  else:
    let
      moSepPx: float32 = 0
      s: Vec2 = vec2(
        modulePixels.float32,
        modulePixels.float32
      )
    if alRad > 0:
      drawQRModulesOnly ctx.fillRect(rect(pos, s))
    else:
      drawRegion 0'u8, size, 0'u8, size, ctx.fillRect(rect(pos, s))
  if alRad > 0 or moRad > 0 or moSep > 0:
    let alRadPx: float32 = 3.5 * alRad / 100
    template innerRadius(lvl: static range[0'i8..2'i8]): float32 =
      when lvl == 0: alRadPx
      else:
        if alRadPx == 0: 0f
        elif alRadPx-lvl <= 0: 1f / (lvl * 2)
        else: alRadPx-lvl
    template drawAlPatterns(lvl: range[0'i8..2'i8], c: untyped) {.dirty.} =
      template s1: float32 = ((7-lvl*2) * modulePixels).float32
      template s: Vec2 {.dirty.} = vec2(s1, s1)
      template r: float32 = innerRadius(lvl) * modulePixels.float32
      template vec2F(a, b: untyped): Vec2 = vec2(a.calcPos, b.calcPos)
      when c == "light":
        ctx.fillStyle = light
        ctx.strokeStyle = light
      ctx.fillRoundedRect rect(vec2F(0'u8+lvl, 0'u8+lvl), s), r
      ctx.fillRoundedRect rect(vec2F(size-7'u8+lvl, 0'u8+lvl), s), r
      ctx.fillRoundedRect rect(vec2F(0'u8+lvl, size-7+lvl), s), r
      when c == "light":
        ctx.fillStyle = dark
        ctx.strokeStyle = dark
    drawAlPatterns 0, "dark"
    drawAlPatterns 1, "light"
    drawAlPatterns 2, "dark"
  if img.width > 0 and img.height > 0:
    template calc(n: uint8): float32 = (n * modulePixels).float32
    ctx.drawImage(
      img,
      (calc imgCoords.x) + pixelsMargin.float32,
      (calc imgCoords.y) + pixelsMargin.float32,
      calc imgCoords.w,
      calc imgCoords.h
    )
