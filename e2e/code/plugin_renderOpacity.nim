
import frameos/channels
import frameos/types
import scenes/scene_renderOpacity as scene_renderOpacity

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderOpacity".SceneId,
    name: "Opacity",
    isDefault: false,
    scene: scene_renderOpacity.exportedScene,
  )
