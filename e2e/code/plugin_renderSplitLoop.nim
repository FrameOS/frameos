
import frameos/channels
import frameos/types
import scenes/scene_renderSplitLoop as scene_renderSplitLoop

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderSplitLoop".SceneId,
    name: "Split Loop",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderSplitLoop.exportedScene,
  )
