import scenes/default as defaultScene

proc frameosSceneId*(): cstring {.exportc, dynlib, cdecl.} =
  "custom/default"

proc frameosSceneName*(): cstring {.exportc, dynlib, cdecl.} =
  "Custom Default Scene"

proc frameosGetExportedScene*(): pointer {.exportc, dynlib, cdecl.} =
  cast[pointer](defaultScene.exportedScene)
