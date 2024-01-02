import pixie
from frameos/types import FrameScene, FrameConfig, ExecutionContext, Logger

type
  AppConfig* = object
    startColor*: Color
    endColor*: Color
    angle*: float

  App* = ref object
    nodeId*: string
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: string, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

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

proc run*(self: App, context: ExecutionContext) =
  let paint = newPaint(LinearGradientPaint)
  paint.gradientStops = @[
    ColorStop(color: self.appConfig.startColor, position: 0),
    ColorStop(color: self.appConfig.endColor, position: 1.0),
  ]
  paint.gradientHandlePositions = angleToPoints(self.appConfig.angle,
      context.image.width.toFloat, context.image.height.toFloat)
  context.image.fillGradient(paint)
