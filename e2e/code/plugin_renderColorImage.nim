
import frameos/channels
import frameos/types
import scenes/scene_renderColorImage as scene_renderColorImage

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderColorImage".SceneId,
    name: "Color",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderColorImage.exportedScene,
  )
