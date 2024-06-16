import json, strformat
import pixie
import frameos/types
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

proc run*(self: App, context: ExecutionContext): Image =
  let code = if self.appConfig.codeType == "Frame Control URL":
      (if self.frameConfig.framePort mod 1000 == 443: "https" else: "http") & "://" & self.frameConfig.frameHost &
        ":" & $self.frameConfig.framePort & "/c" & (if self.frameConfig.frameAccess != "public": "?k=" &
            self.frameConfig.frameAccessKey else: "")
    elif self.appConfig.codeType == "Frame Image URL":
      (if self.frameConfig.framePort mod 1000 == 443: "https" else: "http") & "://" & self.frameConfig.frameHost &
        ":" & $self.frameConfig.framePort & (if self.frameConfig.frameAccess == "private": "/?k=" &
            self.frameConfig.frameAccessKey else: "")
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
  return qrImage
