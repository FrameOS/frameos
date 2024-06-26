import pixie
import options
import frameos/apps
import frameos/types

type
  AppConfig* = object
    inputImage*: Option[Image]
    startColor*: Color
    endColor*: Color
    angle*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc angleToPoints(angle: float, width: float, height: float): seq[Vec2] =
  let rad = angle * PI / 180.0
  let dx = cos(rad)
  let dy = sin(rad)
  let halfDiagonal = sqrt(width * width + height * height) / 2
  let centerX = width / 2
  let centerY = height / 2

  return @[
    vec2(centerX - dx * halfDiagonal, centerY - dy * halfDiagonal),
    vec2(centerX + dx * halfDiagonal, centerY + dy * halfDiagonal)
  ]

proc render*(self: App, context: ExecutionContext, image: Image) =
  let paint = newPaint(LinearGradientPaint)
  paint.gradientStops = @[
    ColorStop(color: self.appConfig.startColor, position: 0),
    ColorStop(color: self.appConfig.endColor, position: 1.0),
  ]
  paint.gradientHandlePositions = angleToPoints(self.appConfig.angle,
      image.width.toFloat, image.height.toFloat)
  image.fillGradient(paint)

proc run*(self: App, context: ExecutionContext) =
  render(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  result = if self.appConfig.inputImage.isSome:
    self.appConfig.inputImage.get()
  elif context.hasImage:
    newImage(context.image.width, context.image.height)
  else:
    newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  render(self, context, result)

