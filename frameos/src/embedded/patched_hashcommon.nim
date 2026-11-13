# The embedded build's copy of Nim 2.2's std/private hashcommon (config.nims,
# patchFile, frameosEmbedded only). The one change is the probe loop: instead
# of one per table type, tables keyed by a string or a machine word call the
# single loop in fos_table_probe.nim. See docs/esp32-image-size.md.
# A distinct string or int key must compare like its base type (the loop does
# not call the key's `==`); frameos/ids.nim's two do.
when (NimMajor, NimMinor) != (2, 2):
  {.error: "re-derive src/embedded/patched_hashcommon.nim from this Nim's lib/pure/collections/hashcommon.nim".}

#
#
#            Nim's Runtime Library
#        (c) Copyright 2019 Andreas Rumpf
#
#    See the file "copying.txt", included in this
#    distribution, for details about the copyright.
#

# An `include` file which contains common code for
# hash sets and tables.

when defined(nimPreviewSlimSystem):
  import std/assertions

import std / outparams
import std / typetraits
from ./fos_table_probe import fosTableProbeString, fosTableProbeWord,
  fosTableMustRehash, layoutOf

const
  growthFactor = 2

# hcode for real keys cannot be zero.  hcode==0 signifies an empty slot.  These
# two procs retain clarity of that encoding without the space cost of an enum.
proc isEmpty(hcode: Hash): bool {.inline.} =
  result = hcode == 0

proc isFilled(hcode: Hash): bool {.inline.} =
  result = hcode != 0

proc nextTry(h, maxHash: Hash): Hash {.inline.} =
  result = (h + 1) and maxHash

proc mustRehash[T](t: T): bool {.inline, raises: [].} =
  # If this is changed, make sure to synchronize it with `slotsNeeded` below
  fosTableMustRehash(t.dataLen, t.counter)

proc slotsNeeded(count: Natural): int {.inline.} =
  # Make sure to synchronize with `mustRehash` above
  result = nextPowerOfTwo(count div 2 + count + 4)

template rawGetKnownHCImpl() {.dirty.} =
  if t.dataLen == 0:
    return -1
  var h: Hash = hc and maxHash(t) # start with real hash value
  while isFilled(t.data[h].hcode):
    # Compare hc THEN key with boolean short circuit. This makes the common case
    # zero ==key's for missing (e.g.inserts) and exactly one ==key for present.
    # It does slow down succeeding lookups by one extra Hash cmp&and..usually
    # just a few clock cycles, generally worth it for any non-integer-like A.
    if t.data[h].hcode == hc and t.data[h].key == key:
      return h
    h = nextTry(h, maxHash(t))
  result = -1 - h # < 0 => MISSING; insert idx = -1 - result

template fosKeyOffset(t: typed): int =
  # hcode, then (in an OrderedTable) next, then the key.
  cast[int](unsafeAddr t.data[0].key) - cast[int](unsafeAddr t.data[0])

template fosIsWordKey(A: typedesc): bool =
  distinctBase(A, true) is (SomeInteger | ptr | pointer) and sizeof(A) == sizeof(uint)

template fosProbeOr(generic: untyped) {.dirty.} =
  # Bounds are off from here to the end of the file: every index is masked.
  when nimvm:
    block:
      generic
  else:
    when distinctBase(A, true) is string:
      if t.dataLen == 0:
        return -1
      result = fosTableProbeString(unsafeAddr t.data[0], maxHash(t),
        layoutOf(sizeof(t.data[0]), fosKeyOffset(t)), string(key), hc)
    elif fosIsWordKey(A):
      if t.dataLen == 0:
        return -1
      result = fosTableProbeWord(unsafeAddr t.data[0], maxHash(t),
        layoutOf(sizeof(t.data[0]), fosKeyOffset(t)), cast[uint](key), hc)
    else:
      block:
        generic

{.push boundChecks: off.}

proc rawGetKnownHC[X, A](t: X, key: A, hc: Hash): int {.inline, raises: [].} =
  fosProbeOr:
    rawGetKnownHCImpl()

template genHashImpl(key, hc: typed) =
  hc = hash(key)
  if hc == 0: # This almost never taken branch should be very predictable.
    when sizeof(int) < 4:
      hc = 31415 # Value doesn't matter; Any non-zero favorite is fine <= 16-bit.
    else:
      hc = 314159265 # Value doesn't matter; Any non-zero favorite is fine.

template genHash(key: typed): Hash =
  var res: Hash
  genHashImpl(key, res)
  res

template rawGetImpl() {.dirty.} =
  genHashImpl(key, hc)
  fosProbeOr:
    rawGetKnownHCImpl()

proc rawGet[X, A](t: X, key: A, hc: var Hash): int {.inline, outParamsAt: [3], raises: [].} =
  rawGetImpl()

{.pop.}
