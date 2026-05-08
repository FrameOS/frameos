import std/[json, strutils, unittest]

import ../js_runtime
import ../types
import ../values

proc testScene(): InterpretedFrameScene =
  InterpretedFrameScene(
    id: "tests/js-runtime".SceneId,
    logger: Logger(
      enabled: true,
      log: proc(payload: JsonNode) = discard payload,
      enable: proc() = discard,
      disable: proc() = discard
    )
  )

proc testContext(scene: FrameScene): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: "."
  )

suite "js runtime helper seams":
  test "toJsIdent sanitizes invalid identifiers":
    check toJsIdentForTest("") == "_"
    check toJsIdentForTest("alpha_1") == "alpha_1"
    check toJsIdentForTest("1 bad-name") == "___bad_name"
    check toJsIdentForTest("$ok") == "$ok"

  test "jsQuote escapes slash quote and control characters":
    check jsQuoteForTest("a\"b\\c\n\r") == "a\\\"b\\\\c\\n\\r"

  test "envelopeToValue handles undefined with and without expected type":
    let asNone = envelopeToValueForTest(%*{"k": "undefined"})
    check asNone.kind == fkNone

    let undefinedAsInt = envelopeToValueForTest(%*{"k": "undefined"}, "integer")
    check undefinedAsInt.kind == fkInteger
    check undefinedAsInt.asInt() == 0

  test "envelopeToValue infers primitive kinds":
    let s = envelopeToValueForTest(%*{"k": "string", "v": "x"})
    check s.kind == fkString
    check s.asString() == "x"

    let nInt = envelopeToValueForTest(%*{"k": "number", "v": 7})
    check nInt.kind == fkInteger
    check nInt.asInt() == 7

    let nFloat = envelopeToValueForTest(%*{"k": "number", "v": 1.5})
    check nFloat.kind == fkFloat
    check abs(nFloat.asFloat() - 1.5) < 0.0001

    let b = envelopeToValueForTest(%*{"k": "boolean", "v": true})
    check b.kind == fkBoolean
    check b.asBool()

    let j = envelopeToValueForTest(%*{"k": "array", "v": [1, 2]})
    check j.kind == fkJson
    check j.asJson().len == 2

  test "envelopeToValue bigint keeps in-range integers and overflows to string":
    let inRange = envelopeToValueForTest(%*{"k": "bigint", "v": {"__bigint": "9223372036854775807"}})
    check inRange.kind == fkInteger
    check inRange.asInt() == 9223372036854775807'i64

    let overflow = envelopeToValueForTest(%*{"k": "bigint", "v": {"__bigint": "922337203685477580799"}})
    check overflow.kind == fkString
    check overflow.asString() == "922337203685477580799"

  test "expected type coercion overrides envelope kind":
    let coerced = envelopeToValueForTest(%*{"k": "string", "v": "12"}, "integer")
    check coerced.kind == fkInteger
    check coerced.asInt() == 12

  test "transpileSource removes types and lowers jsx":
    let transpiled = transpileSourceForTest(
      """
function demo(input: number) {
  return <card active={input > 0}>{input as number}</card>;
}
"""
    )
    check "input: number" notin transpiled
    check "__frameosJsx(" in transpiled
    cleanupCompilerJs()

  test "transpileSource does not initialize a scene runtime":
    var scene = testScene()
    discard transpileSourceForTest("const answer: number = 42;")
    check scene.jsReady == false
    check scene.js.context == nil
    cleanupCompilerJs()

  test "evalSnippet runs typescript and jsx through quickjs":
    var scene = testScene()
    let value = evalSnippet(
      scene,
      testContext(scene),
      1.NodeId,
      "(({count}: {count: number}) => <result total={count + 1}>{count}</result>)({ count: 2 })"
    )
    check value.kind == fkJson
    let jsonValue = value.asJson()
    check jsonValue["type"].getStr() == "result"
    check jsonValue["props"]["total"].getInt() == 3
    check jsonValue["props"]["children"].getInt() == 2
    cleanupSceneJs(scene)
    cleanupCompilerJs()

  test "cleanupSceneJs closes the quickjs runtime":
    var scene = testScene()
    ensureSceneJs(scene)
    check scene.jsReady
    check scene.js.context != nil

    cleanupSceneJs(scene)

    check scene.jsReady == false
    check scene.js.context == nil
    check scene.js.runtime == nil
