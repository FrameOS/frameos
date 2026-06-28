import assets/frame_web as frameWebAssets
import assets/repo_scenes as repoSceneAssets
import assets/web as webAssets

proc readFrameWebAsset(path: string): string =
  when compiles(frameWebAssets.getAssetToStr(path)):
    frameWebAssets.getAssetToStr(path)
  else:
    frameWebAssets.getAsset(path)

proc readCompressedFrameWebAsset(path: string): string =
  frameWebAssets.getCompressedAsset(path)

proc readWebAsset(path: string): string =
  when compiles(webAssets.getAssetToStr(path)):
    webAssets.getAssetToStr(path)
  else:
    webAssets.getAsset(path)

proc readRepoSceneAsset(path: string): string =
  when compiles(repoSceneAssets.getAssetToStr(path)):
    repoSceneAssets.getAssetToStr(path)
  else:
    repoSceneAssets.getAsset(path)

proc getFrameWebAsset*(path: string): string {.gcsafe.} =
  # nimassets-generated modules store data in global tables, so GC analysis
  # needs an explicit escape hatch at the boundary.
  {.cast(gcsafe).}:
    result = readFrameWebAsset(path)

proc getCompressedFrameWebAsset*(path: string): string {.gcsafe.} =
  {.cast(gcsafe).}:
    result = readCompressedFrameWebAsset(path)

proc getWebAsset*(path: string): string {.gcsafe.} =
  {.cast(gcsafe).}:
    result = readWebAsset(path)

proc getRepoSceneAsset*(path: string): string {.gcsafe.} =
  {.cast(gcsafe).}:
    result = readRepoSceneAsset(path)

proc listRepoSceneAssetPaths*(): seq[string] {.gcsafe.} =
  {.cast(gcsafe).}:
    result = repoSceneAssets.listAssetPaths()
