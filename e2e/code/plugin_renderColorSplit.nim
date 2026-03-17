
import frameos/channels
import frameos/types
import scenes/scene_renderColorSplit as scene_renderColorSplit

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderColorSplit".SceneId,
    name: "Color",
    isDefault: false,
    scene: scene_renderColorSplit.exportedScene,
  )
