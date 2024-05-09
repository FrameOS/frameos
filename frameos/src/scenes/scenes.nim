import default as defaultScene
import frameos/types
import tables, options

let defaultSceneId* = some("default".SceneId)

const sceneOptions* = [
  ("753d9439-8470-4834-8c5d-73264875c5b1".SceneId, "Default Scene"),
]

proc getExportedScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result["default".SceneId] = defaultScene.exportedScene

# TODO Scene options:
# - start at boot / start when requested
# - stick around after closing / unmount if closed
# - background color
# - render interval

