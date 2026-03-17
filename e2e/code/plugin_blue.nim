
import frameos/channels
import frameos/types
import scenes/scene_blue as scene_blue

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "blue".SceneId,
    name: "Blue",
    isDefault: false,
    scene: scene_blue.exportedScene,
  )
