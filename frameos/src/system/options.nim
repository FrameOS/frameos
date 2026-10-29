import frameos/types

const sceneOptions*: array[5, tuple[id: SceneId, name: string]] = [
  ("system/index".SceneId, "Index"),
  ("system/wifiHotspot".SceneId, "Wifi Captive Portal"),
  ("system/bootGuard".SceneId, "Boot Guard"),
  ("system/sceneSwitcher".SceneId, "Scene switcher"),
  ("system/sceneSettings".SceneId, "Scene settings"),
]
