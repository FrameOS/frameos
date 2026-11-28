import std/[json, unittest]
import pixie
import ../cache_key
import ../types
import ../values

suite "node cache keys":
  test "values equal as JSON key the same":
    check valueKey(VString("abc")) == valueKey(Value(kind: fkText, s: "abc"))
    check valueKey(VInt(7)) == valueKey(Value(kind: fkNode, nId: 7.NodeId))
    check valueKey(VJson(%*{"a": 1, "b": [true, nil, "x"]})) ==
      valueKey(VJson(%*{"b": [true, nil, "x"], "a": 1}))
    check valueKey(VFloat(0.0)) == valueKey(VFloat(-0.0))
    check valueKey(VJson(nil)) == valueKey(VJson(newJObject()))

  test "different values key differently":
    check valueKey(VString("abc")) != valueKey(VString("abd"))
    check valueKey(VInt(1)) != valueKey(VFloat(1.0))
    check valueKey(VString("1")) != valueKey(VInt(1))
    check valueKey(VJson(%*{"a": 1})) != valueKey(VJson(%*{"a": 2}))
    check valueKey(VJson(%*{"a": 1})) != valueKey(VJson(%*{"b": 1}))
    check valueKey(VJson(%*[1, 2])) != valueKey(VJson(%*[2, 1]))
    check valueKey(VJson(%*["ab", "c"])) != valueKey(VJson(%*["a", "bc"]))
    check valueKey(VBool(true)) != valueKey(VBool(false))

  test "images key by their size":
    check valueKey(VImage(newImage(4, 3))) == valueKey(VImage(newImage(4, 3)))
    check valueKey(VImage(newImage(4, 3))) != valueKey(VImage(newImage(3, 4)))

  test "a spool keys by its bytes, not by how it is held":
    check valueKey(Value(kind: fkSpool, sp: newMemorySpool("hello world"))) ==
      valueKey(Value(kind: fkSpool, sp: newMemorySpool("hello world")))
    check valueKey(Value(kind: fkSpool, sp: newMemorySpool("hello world"))) !=
      valueKey(Value(kind: fkSpool, sp: newMemorySpool("hello there")))

  test "the key is never NoCacheKey":
    check valueKey(VNone()) != NoCacheKey
    check valueKey(VString("")) != NoCacheKey

  test "a run's inputs: any order, the last value of a field, none is no key":
    var a, b, c: seq[(uint64, CacheKey)]
    check inputsKey(a) == NoCacheKey
    a.setInputKey("url", VString("x"))
    a.setInputKey("width", VInt(10))
    b.setInputKey("width", VInt(10))
    b.setInputKey("url", VString("old"))
    b.setInputKey("url", VString("x"))
    check b.len == 2
    check inputsKey(a) == inputsKey(b)
    c.setInputKey("url", VInt(10))
    c.setInputKey("width", VString("x"))
    check inputsKey(a) != inputsKey(c)
