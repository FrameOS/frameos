import frameos/types
import default as defaultScene

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "default".SceneId,
    name: "Default Scene",
    isDefault: true,
    abiVersion: COMPILED_PLUGIN_ABI_VERSION,
    scene: defaultScene.exportedScene,
  )
