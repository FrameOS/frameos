import tables, json, chroma
import ../frameos/types

import render/calendar/app as render_calendarApp
import render/color/app as render_colorApp
import render/image/app as render_imageApp
import render/gradient/app as render_gradientApp
import render/split/app as render_splitApp
import render/opacity/app as render_opacityApp
import render/text/app as render_textApp

type AppExport* = ref object of RootObj
  build*: proc (params: JsonNode): AppRoot
  run*: proc (self: AppRoot, context: var ExecutionContext): void
  get*: proc (self: AppRoot, key: string): JsonNode

proc getApps*(): Table[string, AppExport] =
  result = initTable[string, AppExport]()
  result["render/image"] = AppExport(
    build: proc (params: JsonNode): AppRoot =
    let config = render_imageApp.AppConfig(
      # inputImage: if params.hasKey("inputImage"): some(getImageFromJson(params["inputImage"])) else: none(Image),
        # image: if params.hasKey("image"): getImageFromJson(params["image"]) else: nil,
      placement: if params.hasKey("placement"): params["placement"].getStr() else: "center",
      offsetX: if params.hasKey("offsetX"): params["offsetX"].getInt() else: 0,
      offsetY: if params.hasKey("offsetY"): params["offsetY"].getInt() else: 0,
      blendMode: if params.hasKey("blendMode"): params["blendMode"].getStr() else: "normal"
        )
    result = render_imageApp.App(
      nodeId: -1.NodeId,
      nodeName: if params.hasKey("nodeName"): params["nodeName"].getStr() else: "",
      scene: nil,
      frameConfig: FrameConfig(),
      appConfig: config
    )
  ,
    run: render_imageApp.run,
    get: proc (self: AppRoot, key: string): JsonNode =
    let app = render_imageApp.App(self)
    case key
    of "image":
      if app.appConfig.image != nil:
        discard
        # result = imageToJson(app.appConfig.image)
      else:
        result = newJNull()
    else:
      result = newJNull()
  )
  result["render/gradient"] = AppExport(
    build: proc (params: JsonNode): AppRoot =
    let config = render_gradientApp.AppConfig(
      # inputImage: if params.hasKey("inputImage"): some(getImageFromJson(params["inputImage"])) else: none(Image),
      startColor: if params.hasKey("startColor"): parseHtmlColor(params["startColor"].getStr()) else: rgb(0, 0, 0),
      endColor: if params.hasKey("endColor"): parseHtmlColor(params["endColor"].getStr()) else: rgb(255, 255, 255),
      angle: if params.hasKey("angle"): params["angle"].getFloat() else: 0.0
      )
    result = render_gradientApp.App(
      nodeId: -1.NodeId,
      nodeName: if params.hasKey("nodeName"): params["nodeName"].getStr() else: "",
      scene: nil,
      frameConfig: FrameConfig(),
      appConfig: config
    )
  ,
    run: render_gradientApp.run,
    get: proc (self: AppRoot, key: string): JsonNode =
    let app = render_gradientApp.App(self)
    case key
    of "startColor":
      result = newJString(colorToHtml(app.appConfig.startColor))
    of "endColor":
      result = newJString(colorToHtml(app.appConfig.endColor))
    of "angle":
      result = newJFloat(app.appConfig.angle)
    else:
      result = newJNull()
  )
