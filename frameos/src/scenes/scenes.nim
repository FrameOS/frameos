import default as defaultScene
import frameos/types
import tables, options

let defaultSceneId* = some("default".SceneId)

const sceneOptions*: array[1, tuple[id: SceneId, name: string]] = [
  ("default".SceneId, "Default Scene"),
]

proc getExportedScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result["default".SceneId] = defaultScene.exportedScene
