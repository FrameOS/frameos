
import frameos/channels
import frameos/types
import scenes/scene_dataCodeFloat as scene_dataCodeFloat

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataCodeFloat".SceneId,
    name: "Numeric Code Nodes",
    isDefault: false,
    scene: scene_dataCodeFloat.exportedScene,
  )
