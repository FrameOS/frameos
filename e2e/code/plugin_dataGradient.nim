
import frameos/channels
import frameos/types
import scenes/scene_dataGradient as scene_dataGradient

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataGradient".SceneId,
    name: "dataGradient",
    isDefault: false,
    scene: scene_dataGradient.exportedScene,
  )
