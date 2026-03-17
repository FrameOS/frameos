
import frameos/channels
import frameos/types
import scenes/scene_logicIfElse as scene_logicIfElse

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "logicIfElse".SceneId,
    name: "If Else",
    isDefault: false,
    scene: scene_logicIfElse.exportedScene,
  )
