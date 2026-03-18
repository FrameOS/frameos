
import frameos/channels
import frameos/types
import scenes/scene_renderImageMask as scene_renderImageMask

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderImageMask".SceneId,
    name: "Image Mask",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderImageMask.exportedScene,
  )
