
import frameos/channels
import frameos/types
import scenes/scene_logicSetAsState as scene_logicSetAsState

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "logicSetAsState".SceneId,
    name: "Set as State",
    isDefault: false,
    scene: scene_logicSetAsState.exportedScene,
  )
