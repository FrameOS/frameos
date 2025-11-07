import ./wifiHotspot/scene as wifiHotspotScene
import ./index/scene as indexScene
from ./options import sceneOptions
import frameos/types
import tables

export sceneOptions

proc getSystemScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result["system/index".SceneId] = indexScene.exportedScene
  result["system/wifiHotspot".SceneId] = wifiHotspotScene.exportedScene
