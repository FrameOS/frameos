import pixie
import std/math
import frameos/types
import frameos/utils/app_images

type
  AppConfig* = object
    image*: Image
    rotationDegree*: float
    scalingMode*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let originalImage = self.appConfig.image
  let rotationAngle = degToRad(self.appConfig.rotationDegree).float32

  # 180 degrees preserves the dimensions, so it is the one rotation that can
  # honour `forwardsTarget` (declared in config.json, gated on this config):
  # when the planner cleared this node to mutate in place, the image below is
  # one the chain allocated for itself, and two in-place flips ARE the
  # rotation — no bounding-box image, no draw. 90/270 change the output's
  # dimensions and stay on the allocating path; that native-resolution
  # intermediate is the hole the value-pipeline doc still lists as open.
  if floorMod(self.appConfig.rotationDegree, 360.0) == 180.0 and
      self.mayMutateImageInPlace(context):
    originalImage.flipHorizontal()
    originalImage.flipVertical()
    return originalImage

  # Calculate the new dimensions after rotation. Snap near-integer trig
  # values first: float32 noise at exact right angles (sin(pi) ~ -8.7e-8)
  # otherwise ceil()s a 180-degree bounding box one pixel too wide.
  var cosAngle = abs(cos(rotationAngle))
  var sinAngle = abs(sin(rotationAngle))
  if abs(cosAngle - round(cosAngle)) < 1e-6: cosAngle = round(cosAngle)
  if abs(sinAngle - round(sinAngle)) < 1e-6: sinAngle = round(sinAngle)
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
