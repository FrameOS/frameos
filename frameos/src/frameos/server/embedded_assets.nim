import assets/frame_web as frameWebAssets
import assets/web as webAssets

proc getFrameWebAsset*(path: string): string {.gcsafe.} =
  # nimassets-generated modules store data in global tables, so GC analysis
  # needs an explicit escape hatch at the boundary.
  {.cast(gcsafe).}:
    result = frameWebAssets.getAsset(path)

proc getWebAsset*(path: string): string {.gcsafe.} =
  {.cast(gcsafe).}:
    result = webAssets.getAsset(path)
