
import frameos/channels
import frameos/types
import scenes/scene_dataNewImage as scene_dataNewImage

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataNewImage".SceneId,
    name: "New Image",
    isDefault: false,
    abiVersion: 1,
    scene: scene_dataNewImage.exportedScene,
  )
