import ./wifiHotspot/scene as wifiHotspotScene
import frameos/types
import tables

const sceneOptions*: array[1, tuple[id: SceneId, name: string]] = [
  ("system/wifiHotspot".SceneId, "Wifi Captive Portal"),
]

proc getSystemScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  result["system/wifiHotspot".SceneId] = wifiHotspotScene.exportedScene
