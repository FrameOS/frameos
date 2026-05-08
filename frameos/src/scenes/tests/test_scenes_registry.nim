import std/[options, tables, unittest]

import ../scenes

suite "compiled scenes registry":
  test "default scene id is exported":
    check defaultSceneId.isSome()
    check defaultSceneId.get().string == "default"

  test "scene options expose default scene metadata":
    check sceneOptions.len == 1
    check sceneOptions[0].id.string == "default"
    check sceneOptions[0].name == "Default Scene"

  test "getExportedScenes contains default exported scene hooks":
    let exportedScenes = getExportedScenes()
    check exportedScenes.len == 1
    check exportedScenes.hasKey(defaultSceneId.get())

    let exported = exportedScenes[defaultSceneId.get()]
    check not exported.isNil
    check exported.init != nil
    check exported.runEvent != nil
    check exported.render != nil
