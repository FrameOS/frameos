## The non-generic halves of the embedded build's hash tables
## (patched_hashcommon.nim, patched_tableimpl.nim).
##
## std/tables copies its probe loop and its rehash into the image once per
## `Table[K, V]` pair, and the firmware has 47 pairs. Neither depends on what
## the value is: a slot is `hcode` at offset 0, then the key, then the value,
## and the only thing the loops ask of a slot's type is its size. So the slot
## size and the key's offset become arguments, and each key shape has one loop.

import std/hashes

{.push boundChecks: off, overflowChecks: off, nimcall.}

template slotAt(data: pointer, index, slotSize: int): pointer =
  cast[pointer](cast[uint](data) + cast[uint](index * slotSize))

template hcodeAt(slot: pointer): Hash =
  cast[ptr Hash](slot)[]

template layoutOf*(slotSize, keyOffset: int): int =
  ## A table's slot shape as one word: six words is what a call passes in
  ## registers on the Xtensa, and a string key already takes two of them.
  (slotSize shl 8) or keyOffset

proc fosTableProbeString*(data: pointer, mask, layout: int,
                          key: string, hc: Hash): int {.noinline, raises: [].} =
  ## The slot of `key`, or `-1 - slot` for the empty slot where it would go.
  let slotSize = layout shr 8
  let keyOffset = layout and 0xff
  var h = hc and mask
  while true:
    let slot = slotAt(data, h, slotSize)
    let filled = hcodeAt(slot)
    if filled == 0:
      return -1 - h
    if filled == hc and
        cast[ptr string](cast[uint](slot) + cast[uint](keyOffset))[] == key:
      return h
    h = (h + 1) and mask

proc fosTableProbeWord*(data: pointer, mask, layout: int,
                        key: uint, hc: Hash): int {.noinline, raises: [].} =
  ## The same for a key that is one machine word compared by value.
  let slotSize = layout shr 8
  let keyOffset = layout and 0xff
  var h = hc and mask
  while true:
    let slot = slotAt(data, h, slotSize)
    let filled = hcodeAt(slot)
    if filled == 0:
      return -1 - h
    if filled == hc and
        cast[ptr uint](cast[uint](slot) + cast[uint](keyOffset))[] == key:
      return h
    h = (h + 1) and mask

proc fosTableMustRehash*(dataLen, counter: int): bool {.noinline, raises: [].} =
  ## std/tables' load factor. slotsNeeded in patched_hashcommon.nim is its
  ## other half.
  (dataLen < counter + counter div 2) or (dataLen - counter < 4)

proc fosTableRehash*(old: pointer, oldLen: int, fresh: pointer, freshLen,
                     slotSize: int) {.noinline, raises: [].} =
  ## Moves every filled slot of `old` into the empty `fresh`, then zeroes
  ## `old`: a zeroed slot is what `wasMoved` leaves, so destroying the old seq
  ## afterwards frees its block and nothing else.
  let mask = freshLen - 1
  for i in 0 ..< oldLen:
    let source = slotAt(old, i, slotSize)
    let hc = hcodeAt(source)
    if hc != 0:
      var h = hc and mask
      while hcodeAt(slotAt(fresh, h, slotSize)) != 0:
        h = (h + 1) and mask
      copyMem(slotAt(fresh, h, slotSize), source, slotSize)
  zeroMem(old, oldLen * slotSize)

{.pop.}
