
import frameos/channels
import frameos/types
import scenes/scene_renderTextOverflow as scene_renderTextOverflow

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderTextOverflow".SceneId,
    name: "Text Overflow",
    isDefault: false,
    scene: scene_renderTextOverflow.exportedScene,
  )
