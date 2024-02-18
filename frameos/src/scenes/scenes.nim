import default as defaultScene
import frameos/types
import tables

let defaultSceneId* = "default".SceneId

proc getExportedScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result[defaultSceneId] = defaultScene.exportedScene

# TODO Scene options:
# - start at boot / start when requested
# - stick around after closing / unmount if closed
# - background color
# - render interval

