
import frameos/channels
import frameos/types
import scenes/scene_renderTextRich as scene_renderTextRich

proc bindCompiledPluginRuntimeChannels*(hooks: ptr CompiledRuntimeHooks) {.exportc, dynlib, cdecl.} =
  bindCompiledRuntimeHooks(hooks)

proc getCompiledScenePlugin*(): CompiledScenePlugin {.exportc, dynlib, cdecl.} =
  CompiledScenePlugin(
    id: "renderTextRich".SceneId,
    name: "Rich text",
    isDefault: false,
    abiVersion: 1,
    scene: scene_renderTextRich.exportedScene,
  )
