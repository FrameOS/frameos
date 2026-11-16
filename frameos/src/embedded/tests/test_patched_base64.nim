## The embedded build's base64 (patched/base64.nim), which only frameosEmbedded
## compiles in. Built with the patch (tests/test_patched_base64.nims).

import std/[base64, unittest]

when not declared(fosBase64Patched):
  {.error: "built without tests/test_patched_base64.nims: this is testing std/base64".}

proc decodeError(s: string): string =
  try:
    discard decode(s)
  except ValueError as e:
    return e.msg
  "nothing raised"

suite "patched base64":
  test "decodes what the stock module decodes":
    check decode("SGVsbG8gV29ybGQ=") == "Hello World"
    check decode("  SGVsbG8gV29ybGQ=") == "Hello World"
    check decode("SGVsbG8gV29ybGQ") == "Hello World"
    check decode("SGVs\nbG8g\nV29ybGQ=\n") == "Hello World"
    check decode("") == ""
    check decode("YQ==") == "a"
    check decode("YWI=") == "ab"
    check decode("-_-_") == decode("+/+/")

  test "round-trips every byte":
    var all = ""
    for i in 0 .. 255:
      all.add char(i)
    for n in 0 .. all.len:
      check decode(encode(all[0 ..< n])) == all[0 ..< n]
      check decode(encode(all[0 ..< n], safe = true)) == all[0 ..< n]

  test "an invalid character raises the stock message":
    check decodeError("SGV$bG8=") ==
      "Invalid base64 format character `$` (ord 36) at location 3."
    check decodeError("SGVsbG8gV29ybG!") ==
      "Invalid base64 format character `!` (ord 33) at location 14."
    # Whitespace is skipped only before a group of four, as the stock does.
    check decodeError("SGVs\nbG8g\r\nV29y bGQ=\n") ==
      "Invalid base64 format character `=` (ord 61) at location 19."
    check decodeError("ab*") ==
      "Invalid base64 format character `*` (ord 42) at location 2."
