import ./wifiHotspot/scene as wifiHotspotScene
import ./index/scene as indexScene
import ./bootGuard/scene as bootGuardScene
import ./sceneSwitcher/scene as sceneSwitcherScene
from ./options import sceneOptions
import frameos/types
from frameos/events_gen import SceneSwitcherId
import tables

export sceneOptions

proc getSystemScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result["system/index".SceneId] = indexScene.exportedScene
  result["system/wifiHotspot".SceneId] = wifiHotspotScene.exportedScene
  result["system/bootGuard".SceneId] = bootGuardScene.exportedScene
  result[SceneSwitcherId.SceneId] = sceneSwitcherScene.exportedScene
