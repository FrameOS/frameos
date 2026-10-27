## The embedded build's packed CSS color names (src/embedded/patched_chroma_names.nim)
## against chroma's own table, which every other build uses.

import std/[tables, unittest]
import chroma/names as chroma_names
import ../patched_chroma_names as patched

suite "patched chroma names":
  test "every name chroma knows has chroma's color":
    var count = 0
    for name, hex in chroma_names.colorNames.pairs:
      check name in patched.colorNames
      check patched.colorNames[name] == hex
      inc count
    check count == 148

  test "nothing else is a name":
    for name in ["", "whit", "whites", "white ", " white", "White", "=", ";",
        "F0F8FF", "aliceblue=F0F8FF", "aliceblue=", "yellowgreen;", "x"]:
      check name notin patched.colorNames
    expect KeyError:
      discard patched.colorNames["whit"]
