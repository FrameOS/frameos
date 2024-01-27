import json, strformat
import pixie
import frameos/types
import QRgen
import ./renderer

type
  AppConfig* = object
    code*: string
    size*: float
    sizeUnit*: string
    position*: string
    offsetX*: float
    offsetY*: float
    padding*: float
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
  let code = if self.appConfig.code == "": (if self.frameConfig.framePort mod 1000 == 443: "https" else: "http") &
      "://" & self.frameConfig.frameHost & ":" & $self.frameConfig.framePort else: self.appConfig.code
  let myQR = newQR(code)

  let width = case self.appConfig.sizeUnit
    of "percentage": self.appConfig.size / 100.0 * min(context.image.width,
        context.image.height).float
    else: self.appConfig.size

  let qrImage = myQR.renderImg(
    self.appConfig.backgroundColor.toHtmlHex,
      self.appConfig.qrCodeColor.toHtmlHex,
    30, 30, 0, width.uint32,
    padding = self.appConfig.padding.uint8
  )
  context.image.draw(qrImage)
