
import frameos/channels
import frameos/types
import scenes/scene_dataResize as scene_dataResize

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataResize".SceneId,
    name: "Resize image",
    isDefault: false,
    scene: scene_dataResize.exportedScene,
  )
