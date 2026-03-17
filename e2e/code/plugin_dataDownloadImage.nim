
import frameos/channels
import frameos/types
import scenes/scene_dataDownloadImage as scene_dataDownloadImage

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataDownloadImage".SceneId,
    name: "Download Image",
    isDefault: false,
    scene: scene_dataDownloadImage.exportedScene,
  )
