# The embedded build's copy of Nim 2.2's lib/std/assertions.nim (config.nims,
# patchFile, frameosEmbedded only). A failed `assert` or `doAssert` raises
# the same AssertionDefect at the same place, but the message is the location
# ("iterators.nim(254, 11)") and a `doAssert`'s own message, without the
# condition's source text or an `assert`'s message. Those were a string
# literal per site and module: 440 sites, 274 of them the `len(a) == L` check
# in a seq's `items`. Without them the ESP32-S3 image is 20.2 KB smaller
# (2026-11-15). The line still finds the assert.
# tests/test_patched_assertions.nim.
when NimMajor != 2 or NimMinor != 2:
  {.error: "re-derive src/embedded/patched/assertions.nim from this Nim's lib/std/assertions.nim".}

const fosAssertionsPatched* = true

#
#
#            Nim's Runtime Library
#        (c) Copyright 2022 Nim contributors
#
#    See the file "copying.txt", included in this
#    distribution, for details about the copyright.
#

when not defined(nimPreviewSlimSystem) and not declared(sysFatal):
  include "system/rawquits"
  include "system/fatal"

## This module implements assertion handling.

import std/private/miscdollars
# ---------------------------------------------------------------------------
# helpers

type InstantiationInfo = tuple[filename: string, line: int, column: int]

proc `$`(info: InstantiationInfo): string =
  # The +1 is needed here
  # instead of overriding `$` (and changing its meaning), consider explicit name.
  result = ""
  result.toLocation(info.filename, info.line, info.column + 1)

# ---------------------------------------------------------------------------


proc raiseAssert*(msg: string) {.noinline, noreturn, nosinks.} =
  ## Raises an `AssertionDefect` with `msg`.
  when defined(nimPreviewSlimSystem):
    raise newException(AssertionDefect, msg)
  else:
    sysFatal(AssertionDefect, msg)

proc failedAssertImpl*(msg: string) {.raises: [], tags: [].} =
  ## Raises an `AssertionDefect` with `msg`, but this is hidden
  ## from the effect system. Called when an assertion failed.
  raiseAssert(msg)

template assertImpl(cond: bool, msg: string, expr: string, enabled: static[bool]) =
  when enabled:
    const
      loc = instantiationInfo(fullPaths = compileOption("excessiveStackTrace"))
      ploc = $loc
    bind instantiationInfo
    mixin failedAssertImpl
    {.line: loc.}:
      if not cond:
        failedAssertImpl(ploc & " " & msg)

proc failedAssertAt(loc: cstring) {.noinline, raises: [], tags: [].} =
  var msg = ""
  var i = 0
  while loc[i] != '\0':
    msg.add loc[i]
    inc i
  failedAssertImpl(msg)

template assertAtImpl(cond: bool, enabled: static[bool]) =
  # The location as a C string: the linker merges equal ones across modules
  # (a Nim string literal is a struct per module), so the 274 `items` checks
  # share a handful of strings.
  when enabled:
    const
      loc = instantiationInfo(fullPaths = compileOption("excessiveStackTrace"))
      ploc = $loc
    bind instantiationInfo, failedAssertAt
    {.line: loc.}:
      if not cond:
        failedAssertAt(cstring(ploc))

template assert*(cond: untyped, msg = "") =
  ## Raises `AssertionDefect` with `msg` if `cond` is false. Note
  ## that `AssertionDefect` is hidden from the effect system, so it doesn't
  ## produce `{.raises: [AssertionDefect].}`. This exception is only supposed
  ## to be caught by unit testing frameworks.
  ##
  ## No code will be generated for `assert` when passing `-d:danger` (implied by `--assertions:off`).
  ## See `command line switches <nimc.html#compiler-usage-commandminusline-switches>`_.
  runnableExamples: assert 1 == 1
  runnableExamples("--assertions:off"):
    assert 1 == 2 # no code generated, no failure here
  runnableExamples("-d:danger"): assert 1 == 2 # ditto
  assertAtImpl(cond, compileOption("assertions"))

template doAssert*(cond: untyped, msg = "") =
  ## Similar to `assert <#assert.t,untyped,string>`_ but is always turned on regardless of `--assertions`.
  runnableExamples:
    doAssert 1 == 1 # generates code even when built with `-d:danger` or `--assertions:off`
  assertImpl(cond, msg, "", true)

template onFailedAssert*(msg, code: untyped): untyped {.dirty.} =
  ## Sets an assertion failure handler that will intercept any assert
  ## statements following `onFailedAssert` in the current scope.
  runnableExamples:
    type MyError = object of CatchableError
      lineinfo: tuple[filename: string, line: int, column: int]
    # block-wide policy to change the failed assert exception type in order to
    # include a lineinfo
    onFailedAssert(msg):
      raise (ref MyError)(msg: msg, lineinfo: instantiationInfo(-2))
    doAssertRaises(MyError): doAssert false
  when not defined(nimHasTemplateRedefinitionPragma):
    {.pragma: redefine.}
  template failedAssertImpl(msgIMPL: string): untyped {.dirty, redefine.} =
    let msg = msgIMPL
    code

template doAssertRaises*(exception: typedesc, code: untyped) =
  ## Raises `AssertionDefect` if specified `code` does not raise `exception`.
  runnableExamples:
    doAssertRaises(ValueError): raise newException(ValueError, "Hello World")
    doAssertRaises(CatchableError): raise newException(ValueError, "Hello World")
    doAssertRaises(AssertionDefect): doAssert false
  var wrong = false
  const begin = "expected raising '" & astToStr(exception) & "', instead"
  const msgEnd = " by: " & astToStr(code)
  template raisedForeign {.gensym.} = raiseAssert(begin & " raised foreign exception" & msgEnd)
  {.push warning[BareExcept]:off.}
  when Exception is exception:
    try:
      if true:
        code
      wrong = true
    except Exception as e: discard
    except: raisedForeign()
  else:
    try:
      if true:
        code
      wrong = true
    except exception:
      discard
    except Exception as e:
      mixin `$` # alternatively, we could define $cstring in this module
      raiseAssert(begin & " raised '" & $e.name & "'" & msgEnd)
    except: raisedForeign()
  {.pop.}
  if wrong:
    raiseAssert(begin & " nothing was raised" & msgEnd)
