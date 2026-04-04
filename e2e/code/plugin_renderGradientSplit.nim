
import frameos/channels
import frameos/types
import scenes/scene_renderGradientSplit as scene_renderGradientSplit

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderGradientSplit".SceneId,
    name: "Gradient",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderGradientSplit.exportedScene,
  )
