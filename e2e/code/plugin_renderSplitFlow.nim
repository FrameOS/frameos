
import frameos/channels
import frameos/types
import scenes/scene_renderSplitFlow as scene_renderSplitFlow

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderSplitFlow".SceneId,
    name: "Split",
    isDefault: false,
    scene: scene_renderSplitFlow.exportedScene,
  )
