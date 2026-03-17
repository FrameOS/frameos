
import frameos/channels
import frameos/types
import scenes/scene_renderImage as scene_renderImage

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderImage".SceneId,
    name: "Render image",
    isDefault: false,
    scene: scene_renderImage.exportedScene,
  )
