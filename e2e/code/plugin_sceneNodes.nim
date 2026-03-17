
import frameos/channels
import frameos/types
import scenes/scene_sceneNodes as scene_sceneNodes

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "sceneNodes".SceneId,
    name: "3",
    isDefault: false,
    scene: scene_sceneNodes.exportedScene,
  )
