
import frameos/channels
import frameos/types
import scenes/scene_dataNewImageNext as scene_dataNewImageNext

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataNewImageNext".SceneId,
    name: "Data Image Next",
    isDefault: false,
    scene: scene_dataNewImageNext.exportedScene,
  )
