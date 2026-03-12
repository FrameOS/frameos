import std/[json, unittest]

import ../js_runtime
import ../types
import ../values

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
