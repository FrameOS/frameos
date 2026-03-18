
import frameos/channels
import frameos/types
import scenes/scene_renderColorFlow as scene_renderColorFlow

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderColorFlow".SceneId,
    name: "Color",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderColorFlow.exportedScene,
  )
