
import frameos/channels
import frameos/types
import scenes/scene_black as scene_black

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "black".SceneId,
    name: "Black",
    isDefault: true,
    abiVersion: 1,
    scene: scene_black.exportedScene,
  )
