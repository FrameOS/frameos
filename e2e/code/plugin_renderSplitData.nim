
import frameos/channels
import frameos/types
import scenes/scene_renderSplitData as scene_renderSplitData

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderSplitData".SceneId,
    name: "Split",
    isDefault: false,
    scene: scene_renderSplitData.exportedScene,
  )
