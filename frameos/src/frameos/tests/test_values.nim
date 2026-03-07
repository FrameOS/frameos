import std/[json, unittest]

import pixie

import ../types
import ../values

suite "values helpers":
  test "typed accessors and json serialization":
    let vStr = VString("hello")
    let vFloat = VFloat(1.5)
    let vInt = VInt(3)
    let vBool = VBool(true)
    let vColor = VColor(parseHtmlColor("#123456"))
    let vJson = VJson(%*{"a": 1})
    let vNode = VNode(12.NodeId)
    let vScene = VScene("scene/main".SceneId)
    let vNone = VNone()

    check vStr.asString() == "hello"
    check abs(vFloat.asFloat() - 1.5) < 0.0001
    check vInt.asInt() == 3
    check vBool.asBool()
    check vJson.asJson()["a"].getInt() == 1
    check vNode.asNode().int == 12
    check vScene.asScene().string == "scene/main"
    check vNone.isNone()
    check valueToJson(vColor).getStr() == "#123456"
    check valueToJson(vNode).getInt() == 12
    check valueToJson(vScene).getStr() == "scene/main"
    check valueToJson(vNone).kind == JNull

  test "valueFromJsonByType applies coercion rules":
    check valueFromJsonByType(%*"12", "integer").asInt() == 12
    check valueFromJsonByType(%*3.9, "integer").asInt() == 3
    check abs(valueFromJsonByType(%*"2.5", "float").asFloat() - 2.5) < 0.0001
    check valueFromJsonByType(%*"yes", "boolean").asBool()
    check valueFromJsonByType(%*"17", "node").asNode().int == 17
    check valueFromJsonByType(%*"scene/a", "scene").asScene().string == "scene/a"
    check valueFromJsonByType(%*"#abcdef", "color").asColor().toHtmlHex == "#ABCDEF"
    check valueFromJsonByType(%*{"k": "v"}, "json").asJson()["k"].getStr() == "v"
    check valueFromJsonByType(%*{"x": 1}, "unknown").asString() == """{"x":1}"""

  test "debug string avoids large payload dumps":
    let img = newImage(4, 3)
    check $VText("abc") == "text(3 chars)"
    check $VImage(img) == "image(4x3)"
