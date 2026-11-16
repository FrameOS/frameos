## The embedded build's assertions (patched_assertions.nim), which only
## frameosEmbedded compiles in. Built with the patch
## (tests/test_patched_assertions.nims).

import std/[strutils, unittest]

when not declared(fosAssertionsPatched):
  {.error: "built without tests/test_patched_assertions.nims: this is testing std/assertions".}

proc failingAssert(x: int) =
  assert x > 0, "x must be positive " & $x

proc failingDoAssert(x: int) =
  doAssert x > 0, "x must be positive"

proc failingBareDoAssert(x: int) =
  doAssert x > 0

proc messageOf(body: proc ()): string =
  try:
    body()
  except AssertionDefect as e:
    return e.msg
  "nothing raised"

suite "patched assertions":
  test "a failed assert raises at its place, without the condition or its message":
    let msg = messageOf(proc () = failingAssert(-1))
    check msg.startsWith("test_patched_assertions.nim(11, ")
    check "x > 0" notin msg
    check "positive" notin msg

  test "a failed doAssert keeps its own message":
    let msg = messageOf(proc () = failingDoAssert(-1))
    check msg.startsWith("test_patched_assertions.nim(14, ")
    check msg.endsWith(" x must be positive")
    check "x > 0" notin msg

  test "a doAssert without a message gives the place":
    let msg = messageOf(proc () = failingBareDoAssert(-1))
    check msg.startsWith("test_patched_assertions.nim(17, ")

  test "a passing assert does nothing and does not evaluate its message":
    var evaluated = false
    proc note(): string =
      evaluated = true
      "note"
    assert 1 > 0, note()
    doAssert 1 > 0, note()
    check not evaluated

  test "a seq changed while iterating still raises":
    var s = @[1, 2, 3]
    let msg = messageOf(proc () =
      for x in s:
        s.add x)
    check msg.startsWith("iterators.nim(")

  test "doAssertRaises still works":
    doAssertRaises(ValueError):
      raise newException(ValueError, "boom")
