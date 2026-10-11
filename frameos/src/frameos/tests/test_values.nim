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

suite "state field defaults":
  test "stateFieldSeed converts the declared default to the field's type":
    check stateFieldSeed(StateField(name: "n", fieldType: "integer", value: %"300")) == %300
    check stateFieldSeed(StateField(name: "f", fieldType: "float", value: %300)) == %300.0
    check stateFieldSeed(StateField(name: "b", fieldType: "boolean", value: %"yes")) == %true
    check stateFieldSeed(StateField(name: "j", fieldType: "json", value: %"{\"a\": 1}")) == %*{"a": 1}
    check stateFieldSeed(StateField(name: "s", fieldType: "string", value: %"album-1")) == %"album-1"
    # Nothing to seed: no default, null, or an empty string
    check stateFieldSeed(StateField(name: "e", fieldType: "string", value: %"")).isNil
    check stateFieldSeed(StateField(name: "e", fieldType: "string", value: newJNull())).isNil
    check stateFieldSeed(StateField(name: "e", fieldType: "string")).isNil
    check stateFieldSeed(nil).isNil

  test "stateAtDeclaredDefault compares in the field's type":
    let seconds = StateField(name: "seconds", fieldType: "integer", value: %300, persist: "disk")
    check stateAtDeclaredDefault(seconds, %300)
    check stateAtDeclaredDefault(seconds, %"300") # a control form's string
    check stateAtDeclaredDefault(seconds, %300.0)
    check not stateAtDeclaredDefault(seconds, %10)
    check not stateAtDeclaredDefault(seconds, %"10")
    check not stateAtDeclaredDefault(seconds, nil)
    let mode = StateField(name: "mode", fieldType: "select", value: %"random")
    check stateAtDeclaredDefault(mode, %"random")
    check not stateAtDeclaredDefault(mode, %"album")
    # A field that seeds nothing: empty is what a fresh init leaves
    let albumId = StateField(name: "albumId", fieldType: "string", value: %"")
    check stateAtDeclaredDefault(albumId, %"")
    check stateAtDeclaredDefault(albumId, newJNull())
    check not stateAtDeclaredDefault(albumId, %"album-1")
    check stateAtDeclaredDefault(StateField(name: "x", fieldType: "string"), %"")

  test "worthPersistingState keeps customized and undeclared keys only":
    let fields = @[
      StateField(name: "seconds", fieldType: "integer", value: %300, persist: "disk"),
      StateField(name: "mode", fieldType: "select", value: %"random", persist: "disk"),
    ]
    check not worthPersistingState(fields, "seconds", %300)
    check worthPersistingState(fields, "seconds", %10)
    check not worthPersistingState(fields, "mode", %"random")
    check worthPersistingState(fields, "mode", %"album")
    check worthPersistingState(fields, "undeclared", %"anything")

  test "declaredStateFields lists every interpreted field, only public compiled ones":
    let private = StateField(name: "secret", fieldType: "string", value: %"x", access: "private", persist: "disk")
    let public = StateField(name: "mode", fieldType: "string", value: %"random", access: "public")
    let interpreted = ExportedInterpretedScene(stateFields: @[private, public], publicStateFields: @[public])
    check declaredStateFields(interpreted).len == 2
    let compiled = ExportedScene(publicStateFields: @[public])
    check declaredStateFields(compiled).len == 1
    check declaredStateFields(nil).len == 0
