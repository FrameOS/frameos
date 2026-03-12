import std/unittest
import pixie

import ../app
import frameos/types

proc makeFrameConfig(
  width = 20,
  height = 16,
  rotate = 0,
  frameAccess = "private",
  frameAccessKey = "secret",
  frameHost = "frame.local",
  framePort = 9999
): FrameConfig =
  FrameConfig(
    width: width,
    height: height,
    rotate: rotate,
    frameAccess: frameAccess,
    frameAccessKey: frameAccessKey,
    frameHost: frameHost,
    framePort: framePort,
    httpsProxy: HttpsProxyConfig(enable: false, port: 0, exposeOnlyPort: false)
  )

proc makeApp(config: AppConfig, frameConfig: FrameConfig): App =
  App(appConfig: config, frameConfig: frameConfig)

proc darkPixelCount(image: Image): int =
  for px in image.data:
    if px.r < 128'u8 and px.g < 128'u8 and px.b < 128'u8 and px.a > 0:
      inc result

suite "data/qr app":
  test "percent size unit uses minimum context image dimension":
    let app = makeApp(
      AppConfig(
        codeType: "Text",
        code: "frameos",
        size: 50,
        sizeUnit: "percent",
        padding: 0,
        qrCodeColor: parseHtmlColor("#000000"),
        backgroundColor: parseHtmlColor("#ffffff")
      ),
      makeFrameConfig()
    )
    let context = ExecutionContext(image: newImage(18, 10), hasImage: true)

    let outputImage = app.get(context)
    check outputImage.width == 5
    check outputImage.height == 5

  test "pixels per dot size unit scales by qr module size and padding":
    let app = makeApp(
      AppConfig(
        codeType: "Text",
        code: "frameos",
        size: 3,
        sizeUnit: "pixels per dot",
        padding: 2,
        qrCodeColor: parseHtmlColor("#000000"),
        backgroundColor: parseHtmlColor("#ffffff")
      ),
      makeFrameConfig()
    )

    let outputImage = app.get(ExecutionContext(hasImage: false))
    check outputImage.width == outputImage.height
    check outputImage.width > 12

  test "absolute size unit uses direct pixel size":
    let app = makeApp(
      AppConfig(
        codeType: "Text",
        code: "frameos",
        size: 11,
        sizeUnit: "pixels",
        padding: 0,
        qrCodeColor: parseHtmlColor("#000000"),
        backgroundColor: parseHtmlColor("#ffffff")
      ),
      makeFrameConfig()
    )

    let outputImage = app.get(ExecutionContext(hasImage: false))
    check outputImage.width == 11
    check outputImage.height == 11

  test "frame control and image URL code types produce different qr patterns":
    let baseConfig = AppConfig(
      codeType: "Frame Control URL",
      code: "ignored",
      size: 200,
      sizeUnit: "pixels",
      padding: 0,
      qrCodeColor: parseHtmlColor("#000000"),
      backgroundColor: parseHtmlColor("#ffffff")
    )
    let frameConfig = makeFrameConfig()

    let controlImage = makeApp(baseConfig, frameConfig).get(ExecutionContext(hasImage: false))

    var imageConfig = baseConfig
    imageConfig.codeType = "Frame Image URL"
    let imageUrlImage = makeApp(imageConfig, frameConfig).get(ExecutionContext(hasImage: false))

    check darkPixelCount(controlImage) != darkPixelCount(imageUrlImage)
    check darkPixelCount(controlImage) > 0
    check darkPixelCount(imageUrlImage) > 0
