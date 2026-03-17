
import frameos/channels
import frameos/types
import scenes/scene_dataDownloadUrl as scene_dataDownloadUrl

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataDownloadUrl".SceneId,
    name: "Download URL",
    isDefault: false,
    scene: scene_dataDownloadUrl.exportedScene,
  )
