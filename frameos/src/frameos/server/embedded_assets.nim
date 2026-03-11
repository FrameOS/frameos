import assets/frame_web as frameWebAssets
import assets/web as webAssets

proc readFrameWebAsset(path: string): string =
  when compiles(frameWebAssets.getAssetToStr(path)):
    frameWebAssets.getAssetToStr(path)
  else:
    frameWebAssets.getAsset(path)

proc readWebAsset(path: string): string =
  when compiles(webAssets.getAssetToStr(path)):
    webAssets.getAssetToStr(path)
  else:
    webAssets.getAsset(path)

proc getFrameWebAsset*(path: string): string {.gcsafe.} =
  # nimassets-generated modules store data in global tables, so GC analysis
  # needs an explicit escape hatch at the boundary.
  {.cast(gcsafe).}:
    result = readFrameWebAsset(path)

proc getWebAsset*(path: string): string {.gcsafe.} =
  {.cast(gcsafe).}:
    result = readWebAsset(path)
