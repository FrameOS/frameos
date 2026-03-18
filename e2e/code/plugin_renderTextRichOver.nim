
import frameos/channels
import frameos/types
import scenes/scene_renderTextRichOver as scene_renderTextRichOver

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderTextRichOver".SceneId,
    name: "Rich text overflow",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderTextRichOver.exportedScene,
  )
