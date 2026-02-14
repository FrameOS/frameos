import json, strformat
import pixie
import frameos/types
import frameos/urls
import QRgen
import QRgen/renderer

type
  AppConfig* = object
    codeType*: string
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

proc run*(self: App, context: ExecutionContext) =
  let code = if self.appConfig.codeType == "Frame Control URL":
      authenticatedFrameUrl(self.frameConfig, "/c")
    elif self.appConfig.codeType == "Frame Image URL":
      authenticatedFrameUrl(self.frameConfig, "/", requireWriteAccess = false)
    else:
      self.appConfig.code

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
