import std/[hashes, json, unittest]

import ../types

suite "frameos type id helpers":
  test "NodeId comparisons work across NodeId and int":
    let node = 42.NodeId
    check node == 42.NodeId
    check node == 42
    check 42 == node
    check node != 7
    check 7 != node

  test "NodeId string and json conversion are stable":
    let node = 123.NodeId
    check $node == "123"
    let asJson = %node
    check asJson.kind == JInt
    check asJson.getInt() == 123

  test "SceneId equality/hash/string/json conversion are stable":
    let sceneA = "scene/main".SceneId
    let sceneACopy = "scene/main".SceneId
    let sceneB = "scene/other".SceneId

    check sceneA == sceneACopy
    check sceneA != sceneB
    check hash(sceneA) == hash(sceneACopy)
    check hash(sceneA) != hash(sceneB)
    check $sceneA == "scene/main"
    let asJson = %sceneA
    check asJson.kind == JString
    check asJson.getStr() == "scene/main"
