# Patched copy of Nim's lib/system/mm/malloc.nim (from the pinned Nim
# release; see frameos/config.nims patchFile). On FreeRTOS/ESP32 the stock
# allocator returns nil on exhaustion without raising, so any failed
# allocation becomes a null-pointer write and a Guru Meditation reboot.
# This copy releases a C-side emergency PSRAM reserve
# (frameos_nim_glue.c) and retries the failed allocation; the render loop
# notices the reserve was consumed, sheds memory and re-arms it. Only when
# even the retry fails does raiseOutOfMem (log + quit) run as the last
# resort.

proc fosNimReleaseEmergencyReserve(): bool {.
  importc: "fos_nim_release_emergency_reserve", cdecl.}
proc fosNimFatalOom(size: csize_t) {.
  importc: "fos_nim_fatal_oom", cdecl.}


{.push stackTrace: off.}

proc allocImpl(size: Natural): pointer =
  result = c_malloc(size.csize_t)
  if result == nil and fosNimReleaseEmergencyReserve():
    result = c_malloc(size.csize_t)
  if result == nil:
    fosNimFatalOom(size.csize_t) # longjmps out of the render when guarded
    raiseOutOfMem()

proc alloc0Impl(size: Natural): pointer =
  result = c_calloc(size.csize_t, 1)
  if result == nil and fosNimReleaseEmergencyReserve():
    result = c_calloc(size.csize_t, 1)
  if result == nil:
    fosNimFatalOom(size.csize_t) # longjmps out of the render when guarded
    raiseOutOfMem()

proc reallocImpl(p: pointer, newSize: Natural): pointer =
  result = c_realloc(p, newSize.csize_t)
  if result == nil and fosNimReleaseEmergencyReserve():
    result = c_realloc(p, newSize.csize_t)
  if result == nil:
    fosNimFatalOom(newSize.csize_t) # longjmps out of the render when guarded
    raiseOutOfMem()

proc realloc0Impl(p: pointer, oldsize, newSize: Natural): pointer =
  result = realloc(p, newSize.csize_t)
  if newSize > oldSize:
    zeroMem(cast[pointer](cast[uint](result) + uint(oldSize)), newSize - oldSize)

proc deallocImpl(p: pointer) =
  c_free(p)


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
