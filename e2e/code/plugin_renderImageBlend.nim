
import frameos/channels
import frameos/types
import scenes/scene_renderImageBlend as scene_renderImageBlend

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderImageBlend".SceneId,
    name: "Blend Modes",
    isDefault: false,
    scene: scene_renderImageBlend.exportedScene,
  )
