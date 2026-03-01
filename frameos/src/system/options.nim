import frameos/types

const sceneOptions*: array[3, tuple[id: SceneId, name: string]] = [
  ("system/index".SceneId, "Index"),
  ("system/wifiHotspot".SceneId, "Wifi Captive Portal"),
  ("system/bootGuard".SceneId, "Boot Guard"),
]
