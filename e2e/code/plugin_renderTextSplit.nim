
import frameos/channels
import frameos/types
import scenes/scene_renderTextSplit as scene_renderTextSplit

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderTextSplit".SceneId,
    name: "Text Split",
    isDefault: false,
    scene: scene_renderTextSplit.exportedScene,
  )
