import pixie
import QRgen
import QRgen/renderer
import frameos/apps
import frameos/types
import frameos/utils/url

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

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let code = if self.appConfig.codeType == "Frame Control URL":
      authenticatedFrameUrl(self.frameConfig, "/c")
    elif self.appConfig.codeType == "Frame Image URL":
      authenticatedFrameUrl(self.frameConfig, "/", requireWriteAccess = false)
    else:
      self.appConfig.code

  let myQR = newQR(code)

  let width = case self.appConfig.sizeUnit
    of "percent": self.appConfig.size / 100.0 * min(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
            if context.hasImage: context.image.height else: self.frameConfig.renderHeight()).float
    of "pixels per dot": self.appConfig.size * (myQR.drawing.size.int + self.appConfig.padding * 2).float
    else: self.appConfig.size

  result = myQR.renderImg(
    light = self.appConfig.backgroundColor.toHtmlHex,
    dark = self.appConfig.qrCodeColor.toHtmlHex,
    alRad = self.appConfig.alRad,
    moRad = self.appConfig.moRad,
    moSep = self.appConfig.moSep,
    pixels = width.uint32,
    padding = self.appConfig.padding.uint8
  )
