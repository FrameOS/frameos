## Compiles the two JS preludes and the scene programs' kit
## (scene_compiler.ProgramKit) to QuickJS bytecode and writes them as
## src/assets/prelude_bytecode.nim, for the firmware image to load instead of
## compiling ~10 KB of JavaScript at every interpreter start and scene program
## (~102 ms of a SenseCAP Indicator frame for 6.4 KB of it,
## docs/realtime-rendering.md; ~10x less from bytecode on the host,
## docs/perf-todo.md, docs/scene-compiler.md).
##
##   nim c -r tools/prelude_bytecode.nim        # from frameos/
##
## embedded/esp32/build_nim.sh runs it before the embedded build and passes
## -d:frameosPreludeBytecode. The bytecode is tied to the exact QuickJS the
## device runs: the tool records quickjs/VERSION and a hash of each prelude's
## source, and the consumers refuse a stale module at compile time. It is
## never anything but the firmware's own: QuickJS checks one version byte on
## load and verifies nothing else, so bytecode from outside the signed image
## would be code the frame runs unchecked.

import std/[os, strutils]
import frameos/js_runtime/burrito
import frameos/js_runtime/prelude_checksum
import frameos/js_runtime/app_runtime
import frameos/js_runtime/runtime
from frameos/scene_compiler import ProgramKit

const
  FrameosDir = currentSourcePath().parentDir.parentDir
  OutPath = FrameosDir / "src" / "assets" / "prelude_bytecode.nim"

proc compileGlobal(js: QuickJS, code, filename: string): string =
  ## `code` as a global script, compiled only, serialized with no debug info
  ## (JS_SetStripInfo JS_STRIP_DEBUG: 7.1 KB for the app prelude against
  ## 9.1 KB with line numbers; an error inside the prelude names its function
  ## and no line, which is what the firmware's logs can carry anyway).
  let compiled = JS_Eval(js.context, code.cstring, code.len.csize_t, filename.cstring,
                         (JS_EVAL_TYPE_GLOBAL or JS_EVAL_FLAG_COMPILE_ONLY).cint)
  if JS_IsException(compiled) != 0:
    let exception = JS_GetException(js.context)
    defer: JS_FreeValue(js.context, exception)
    raise newException(JSException, filename & ": " & toNimString(js.context, exception))
  var size: csize_t
  let buf = JS_WriteObject(js.context, addr size, compiled, JS_WRITE_OBJ_BYTECODE.cint)
  JS_FreeValue(js.context, compiled)
  if buf.isNil:
    raise newException(JSException, filename & ": JS_WriteObject failed")
  result = newString(size)
  if size > 0:
    copyMem(addr result[0], buf, size)
  {.emit: """js_free(`js`->context, `buf`);""".}

type BytecodeWalk = object
  data, name: string
  pos: int

proc fail(w: BytecodeWalk, msg: string) =
  raise newException(ValueError, w.name & ": " & msg & " at byte " & $w.pos)

proc u8(w: var BytecodeWalk): int =
  if w.pos >= w.data.len: w.fail("the bytecode ends early")
  result = ord(w.data[w.pos])
  inc w.pos

proc leb(w: var BytecodeWalk): int =
  var shift = 0
  while true:
    let b = w.u8()
    result = result or ((b and 0x7f) shl shift)
    if b < 0x80: break
    shift += 7

proc skip(w: var BytecodeWalk, n: int) =
  if n < 0 or w.pos + n > w.data.len: w.fail("the bytecode ends early")
  w.pos += n

proc str(w: var BytecodeWalk) =
  let v = w.leb()
  w.skip((v shr 1) shl (v and 1))

proc value(w: var BytecodeWalk) =
  ## One value of JS_WriteObjectRec (quickjs.c, BC_VERSION 5).
  let tag = w.u8()
  case tag
  of 1 .. 4: discard                 # null, undefined, false, true
  of 5: discard w.leb()              # int32 (sleb128)
  of 6: w.skip(8)                    # float64
  of 7: w.str()                      # string
  of 9, 11:                          # array, template object (and its raw)
    for i in 0 ..< w.leb(): w.value()
    if tag == 11: w.value()
  of 10: w.skip(w.leb())             # BigInt, its two's complement bytes
  of 12:                             # function bytecode
    let flags = w.u8() or (w.u8() shl 8)
    discard w.u8()                   # js_mode
    discard w.leb()                  # name
    var counts: array[8, int]
    for c in counts.mitems: c = w.leb()
    let (closureVars, cpool, codeLen) = (counts[5], counts[6], counts[7])
    for i in 0 ..< w.leb():          # locals: name, scope_next, var_ref_idx, flags
      discard w.leb(); discard w.leb(); discard w.leb(); w.skip(1)
    for i in 0 ..< closureVars:      # name, var_idx, flags (u16)
      discard w.leb(); discard w.leb(); w.skip(2)
    w.skip(codeLen)
    if (flags and (1 shl 10)) != 0:  # has_debug: filename, pc2line, source
      discard w.leb(); w.skip(w.leb()); w.skip(w.leb())
    for i in 0 ..< cpool: w.value()
  else:
    w.fail("tag " & $tag & ", which the firmware's JS_ReadObject refuses " &
      "(embedded/esp32/components/frameos_quickjs/CMakeLists.txt reads what a compiled script holds)")

proc checkFirmwareReads(bytes, name: string) =
  ## The ESP32's QuickJS reads only what a compiled script holds: a
  ## function's bytecode and its pooled constants (the guard the firmware's
  ## copy of quickjs.c gets in components/frameos_quickjs/CMakeLists.txt).
  ## Every blob is walked here, so a QuickJS that one day pools something
  ## else fails this build, not a frame's first scene.
  var w = BytecodeWalk(data: bytes, name: name)
  if w.u8() != 5:
    w.fail("bytecode version " & $ord(bytes[0]) & ": the walk here and the firmware's guard read version 5")
  for i in 0 ..< w.leb(): w.str()   # the atom table
  w.value()
  if w.pos != bytes.len: w.fail("bytes after the script")

proc nimStringLiteral(bytes: string): string =
  ## A Nim string literal of raw bytes, one \xHH per byte: no escaping rules
  ## to get wrong, and Nim reads it back byte for byte.
  result = newStringOfCap(bytes.len * 4 + 2)
  result.add '"'
  for c in bytes:
    result.add "\\x"
    result.add toHex(ord(c), 2)
  result.add '"'

proc main() =
  let version = readFile(FrameosDir / "quickjs" / "VERSION").strip()
  let js = newQuickJS()
  JS_SetStripInfo(js.runtime, JS_STRIP_DEBUG)
  let
    appBytes = js.compileGlobal(appJsPrelude, "frameos-app-prelude.js")
    sceneBytes = js.compileGlobal(sceneContextJsPrelude, "frameos-scene-prelude.js")
    kitBytes = js.compileGlobal(ProgramKit, "<frameos:kit>")
  checkFirmwareReads(appBytes, "frameos-app-prelude.js")
  checkFirmwareReads(sceneBytes, "frameos-scene-prelude.js")
  checkFirmwareReads(kitBytes, "<frameos:kit>")
  var text = """# Generated by tools/prelude_bytecode.nim: the JS preludes of
# js_runtime/app_runtime.nim (appJsPrelude) and js_runtime/runtime.nim
# (sceneContextJsPrelude), and scene_compiler.nim's ProgramKit, as QuickJS
# bytecode. Do not edit; rerun the tool
# (embedded/esp32/build_nim.sh does). Loaded only by a build that defines
# frameosPreludeBytecode, which checks the version and the source checksums
# below against what it compiles.

const preludeBytecodeQuickjsVersion* = """ & "\"" & version & "\"" & "\n"
  text.add "const appPreludeSourceChecksum* = " & $preludeChecksum(appJsPrelude) & "'u32\n"
  text.add "const appPreludeBytecode* = " & nimStringLiteral(appBytes) & "\n"
  text.add "const scenePreludeSourceChecksum* = " & $preludeChecksum(sceneContextJsPrelude) & "'u32\n"
  text.add "const scenePreludeBytecode* = " & nimStringLiteral(sceneBytes) & "\n"
  text.add "const programKitSourceChecksum* = " & $preludeChecksum(ProgramKit) & "'u32\n"
  text.add "const programKitBytecode* = " & nimStringLiteral(kitBytes) & "\n"
  createDir(OutPath.parentDir)
  writeFile(OutPath, text)
  echo "prelude bytecode: app ", appJsPrelude.len, " B of source -> ", appBytes.len,
    " B; scene ", sceneContextJsPrelude.len, " B -> ", sceneBytes.len, " B; program kit ",
    ProgramKit.len, " B -> ", kitBytes.len, " B; QuickJS ", version,
    " -> ", OutPath

main()
