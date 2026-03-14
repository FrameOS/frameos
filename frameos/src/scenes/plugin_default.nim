import frameos/types
import default as defaultScene

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "default".SceneId,
    name: "Default Scene",
    isDefault: true,
    scene: defaultScene.exportedScene,
  )
