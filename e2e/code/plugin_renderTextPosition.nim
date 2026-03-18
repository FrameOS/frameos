
import frameos/channels
import frameos/types
import scenes/scene_renderTextPosition as scene_renderTextPosition

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderTextPosition".SceneId,
    name: "Text",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderTextPosition.exportedScene,
  )
