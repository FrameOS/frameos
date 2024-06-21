import pixie
import json
import strformat
import frameos/types

type
  AppConfig* = object
    image*: Image
    rotationDegree*: float
    scalingMode*: string

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

proc get*(self: App, context: ExecutionContext): Image =
  let originalImage = self.appConfig.image
  let rotationAngle = degToRad(self.appConfig.rotationDegree).float32

  # Calculate the new dimensions after rotation
  let cosAngle = abs(cos(rotationAngle))
  let sinAngle = abs(sin(rotationAngle))
  let newWidth = int(ceil(originalImage.width.float32 * cosAngle +
      originalImage.height.float32 * sinAngle))
  let newHeight = int(ceil(originalImage.width.float32 * sinAngle +
      originalImage.height.float32 * cosAngle))

  # Create a new target image with the calculated dimensions
  let targetImage = newImage(newWidth, newHeight)
  # targetImage.fill(self.scene.backgroundColor)

  # Calculate the center of the original and target images
  let originalCenterX = originalImage.width.float32 / 2
  let originalCenterY = originalImage.height.float32 / 2
  let targetCenterX = newWidth.float32 / 2
  let targetCenterY = newHeight.float32 / 2

  # Create a transformation that translates the image to the center of the target image, rotates it, and then translates it back
  let transform =
    translate(vec2(targetCenterX, targetCenterY)) *
    rotate(rotationAngle) *
    translate(vec2(-originalCenterX, -originalCenterY))

  targetImage.draw(
    originalImage,
    transform,
    OverwriteBlend
  )

  return targetImage

