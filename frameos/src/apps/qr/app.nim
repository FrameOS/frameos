import json, strformat
import pixie
import frameos/types
import QRgen
import
  QRgen/private/[
    DrawedQRCode/DrawedQRCode,
    DrawedQRCode/print,
    Drawing,
    qrTypes
  ]

type
  AppConfig* = object
    code*: string
    size*: float
    sizeUnit*: string
    alRad*: float
    moRad*: float
    moSep*: float
    position*: string
    offsetX*: float
    offsetY*: float
    padding*: int
    qrCodeColor*: Color
    backgroundColor*: Color

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    frameConfig*: FrameConfig
    appConfig*: AppConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:error", "error": message})

# The "renderImg" function is copied from:
# https://raw.githubusercontent.com/aruZeta/QRgen/main/src/QRgen/renderer.nim
#
# I adapted it to support variable width padding.
# TODO: patch and merge upstream

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
  let
    modules: uint8 = self.drawing.size + padding * 2
    modulePixels: uint16 = (pixels div modules).uint16
    pixelsMargin: uint16 = (pixels mod modules).uint16 div 2 + modulePixels*(padding)
    actualSize: uint32 = modulePixels.uint32*(modules-(padding * 2)) + (pixelsMargin+1)*2
  let pixels: uint32 =
    if actualSize < pixels: actualSize
    else: pixels
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
    template vec2F(a, b: untyped): Vec2 = vec2(a.calcPos, b.calcPos)
    template s1(lvl: untyped): float32 = ((7-lvl*2) * modulePixels).float32
    template s(lvl: untyped): Vec2 {.dirty.} = vec2(s1(lvl), s1(lvl))
    template r(lvl: untyped): float32 = innerRadius(lvl) * modulePixels.float32
    template drawAlPatterns(lvl: range[0'i8..2'i8], c: untyped) {.dirty.} =
      when c == "light":
        ctx.fillStyle = light
        ctx.strokeStyle = light
      ctx.fillRoundedRect rect(vec2F(0'u8+lvl, 0'u8+lvl), s(lvl)), r(lvl)
      ctx.fillRoundedRect rect(vec2F(size-7'u8+lvl, 0'u8+lvl), s(lvl)), r(lvl)
      ctx.fillRoundedRect rect(vec2F(0'u8+lvl, size-7+lvl), s(lvl)), r(lvl)
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

proc run*(self: App, context: ExecutionContext) =
  let code = if self.appConfig.code == "": (if self.frameConfig.framePort mod 1000 == 443: "https" else: "http") &
      "://" & self.frameConfig.frameHost & ":" & $self.frameConfig.framePort else: self.appConfig.code
  let myQR = newQR(code)

  let width = case self.appConfig.sizeUnit
    of "percent": self.appConfig.size / 100.0 * min(context.image.width, context.image.height).float
    of "pixels per dot": self.appConfig.size * (myQR.drawing.size.int + self.appConfig.padding * 2).float
    else: self.appConfig.size

  let qrImage = myQR.renderImg(
    light = self.appConfig.backgroundColor.toHtmlHex,
    dark = self.appConfig.qrCodeColor.toHtmlHex,
    alRad = self.appConfig.alRad,
    moRad = self.appConfig.moRad,
    moSep = self.appConfig.moSep,
    pixels = width.uint32,
    padding = self.appConfig.padding.uint8
  )

  let xAlign = case self.appConfig.position:
    of "top-left", "center-left", "bottom-left": self.appConfig.offsetX
    of "top-right", "center-right", "bottom-right": context.image.width.float - qrImage.width.float +
        self.appConfig.offsetX
    else: (context.image.width.float - qrImage.width.float) / 2.0 + self.appConfig.offsetX

  let yAlign = case self.appConfig.position:
    of "top-left", "top-center", "top-right": self.appConfig.offsetY
    of "bottom-left", "bottom-center", "bottom-right": context.image.height.float - qrImage.height.float +
        self.appConfig.offsetY
    else: (context.image.height.float - qrImage.height.float) / 2.0 + self.appConfig.offsetY

  context.image.draw(
    qrImage,
    translate(vec2(xAlign, yAlign))
  )
