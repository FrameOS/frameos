# Patched copy of Nim's lib/system/mm/malloc.nim (from the pinned Nim
# release; see frameos/config.nims patchFile). The browser preview simulates a
# device's memory ceiling (tools/wasm/fos_wasm_mem.c): allocations are counted
# and, past the ceiling, refused the way heap_caps_malloc refuses on a full
# ESP32.
#
# Nim cannot raise from a failed allocImpl under --exceptions:goto — the
# `raises: []` hook means raiseOutOfMem falls through to quit() — so a refusal
# calls fos_wasm_fatal_oom, which longjmps back to the setjmp guard around
# frameos_wasm_render. Same containment as the firmware's, for the same
# reason.
#
# With no limit set (the default) these are plain malloc/free with a counter.

proc fosWasmMalloc(size: csize_t): pointer {.
  importc: "fos_wasm_malloc", header: "<fos_wasm_mem.h>", cdecl.}
proc fosWasmCalloc(count, size: csize_t): pointer {.
  importc: "fos_wasm_calloc", header: "<fos_wasm_mem.h>", cdecl.}
proc fosWasmRealloc(p: pointer, size: csize_t): pointer {.
  importc: "fos_wasm_realloc", header: "<fos_wasm_mem.h>", cdecl.}
proc fosWasmFree(p: pointer) {.
  importc: "fos_wasm_free", header: "<fos_wasm_mem.h>", cdecl.}
proc fosWasmFatalOom(size: csize_t) {.
  importc: "fos_wasm_fatal_oom", header: "<fos_wasm_mem.h>", cdecl.}

{.push stackTrace: off.}

proc allocImpl(size: Natural): pointer =
  result = fosWasmMalloc(size.csize_t)
  if result == nil:
    fosWasmFatalOom(size.csize_t) # longjmps out of a guarded render
    raiseOutOfMem()

proc alloc0Impl(size: Natural): pointer =
  result = fosWasmCalloc(size.csize_t, 1)
  if result == nil:
    fosWasmFatalOom(size.csize_t)
    raiseOutOfMem()

proc reallocImpl(p: pointer, newSize: Natural): pointer =
  result = fosWasmRealloc(p, newSize.csize_t)
  if result == nil:
    fosWasmFatalOom(newSize.csize_t)
    raiseOutOfMem()

proc realloc0Impl(p: pointer, oldsize, newSize: Natural): pointer =
  result = reallocImpl(p, newSize)
  if newSize > oldSize:
    zeroMem(cast[pointer](cast[uint](result) + uint(oldSize)), newSize - oldSize)

proc deallocImpl(p: pointer) =
  fosWasmFree(p)


# The shared allocators map on the regular ones

proc allocSharedImpl(size: Natural): pointer =
  allocImpl(size)

proc allocShared0Impl(size: Natural): pointer =
  alloc0Impl(size)

proc reallocSharedImpl(p: pointer, newSize: Natural): pointer =
  reallocImpl(p, newSize)

proc reallocShared0Impl(p: pointer, oldsize, newSize: Natural): pointer =
  realloc0Impl(p, oldSize, newSize)

proc deallocSharedImpl(p: pointer) = deallocImpl(p)


# Empty stubs for the GC

proc GC_disable() = discard
proc GC_enable() = discard

when not defined(gcOrc):
  proc GC_fullCollect() = discard
  proc GC_enableMarkAndSweep() = discard
  proc GC_disableMarkAndSweep() = discard

proc GC_setStrategy(strategy: GC_Strategy) = discard

proc getOccupiedMem(): int = discard
proc getFreeMem(): int = discard
proc getTotalMem(): int = discard

proc nimGC_setStackBottom(theStackBottom: pointer) = discard

proc initGC() = discard

proc newObjNoInit(typ: PNimType, size: int): pointer =
  result = alloc(size)

proc growObj(old: pointer, newsize: int): pointer =
  result = realloc(old, newsize)

proc nimGCref(p: pointer) {.compilerproc, inline.} = discard
proc nimGCunref(p: pointer) {.compilerproc, inline.} = discard

when not defined(gcDestructors):
  proc unsureAsgnRef(dest: PPointer, src: pointer) {.compilerproc, inline.} =
    dest[] = src

proc asgnRef(dest: PPointer, src: pointer) {.compilerproc, inline.} =
  dest[] = src
proc asgnRefNoCycle(dest: PPointer, src: pointer) {.compilerproc, inline,
  deprecated: "old compiler compat".} = asgnRef(dest, src)

type
  MemRegion = object

proc alloc(r: var MemRegion, size: int): pointer =
  result = alloc(size)
proc alloc0(r: var MemRegion, size: int): pointer =
  result = alloc0Impl(size)
proc dealloc(r: var MemRegion, p: pointer) = dealloc(p)
proc deallocOsPages(r: var MemRegion) = discard
proc deallocOsPages() = discard

{.pop.}
