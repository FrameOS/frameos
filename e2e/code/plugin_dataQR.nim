
import frameos/channels
import frameos/types
import scenes/scene_dataQR as scene_dataQR

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "dataQR".SceneId,
    name: "QR",
    isDefault: false,
    scene: scene_dataQR.exportedScene,
  )
