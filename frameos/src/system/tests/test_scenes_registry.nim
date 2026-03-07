import std/[tables, unittest]

import ../options
import ../scenes

suite "system scene registry":
  test "scene options expose expected ids and labels":
    check sceneOptions.len == 3
    check sceneOptions[0].id.string == "system/index"
    check sceneOptions[1].id.string == "system/wifiHotspot"
    check sceneOptions[2].id.string == "system/bootGuard"
    check sceneOptions[0].name == "Index"
    check sceneOptions[1].name == "Wifi Captive Portal"
    check sceneOptions[2].name == "Boot Guard"

  test "getSystemScenes contains all option ids":
    let scenes = getSystemScenes()
    check scenes.len == sceneOptions.len
    for opt in sceneOptions:
      check scenes.hasKey(opt.id)
