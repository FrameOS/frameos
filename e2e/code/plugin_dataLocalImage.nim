
import frameos/channels
import frameos/types
import scenes/scene_dataLocalImage as scene_dataLocalImage

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataLocalImage".SceneId,
    name: "Local Image",
    isDefault: false,
    abiVersion: 1,
    scene: scene_dataLocalImage.exportedScene,
  )
