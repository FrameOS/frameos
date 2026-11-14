# The embedded build's copy of Nim 2.2's lib/system/seqs_v2.nim (config.nims,
# patchFile, frameosEmbedded only). Nim copies `add`, `setLen` and `shrink`
# into the image once per element type, each with its own capacity check,
# its own call to grow the block and its overflow checks: 338 copies, 29 KB
# of the ESP32 firmware (2026-11-14). Here the growing is one proc for every
# type (fosSeqGrow, fosSeqSlot), and what is left per type is the store:
# `add` moves its value into the slot it is given, `setLen` zeroes the new
# slots when a zeroed element is that type's default (fosZeroIsDefault) and
# writes `default(T)` into each one otherwise, and `shrink` resets what it
# drops. Same results, element by element. tests/test_patched_seqs.nim.
when NimMajor != 2 or NimMinor != 2: # no tuple `==` in system this early
  {.error: "re-derive src/embedded/patched_seqs_v2.nim from this Nim's lib/system/seqs_v2.nim".}

#
#
#            Nim's Runtime Library
#        (c) Copyright 2017 Nim contributors
#
#    See the file "copying.txt", included in this
#    distribution, for details about the copyright.
#


# import std/typetraits
# strs already imported allocateds for us.


# Some optimizations here may be not to empty-seq-initialize some symbols, then StrictNotNil complains.
{.push warning[StrictNotNil]: off.}  # See https://github.com/nim-lang/Nim/issues/21401


## Default seq implementation used by Nim's core.
type
  NimSeqPayloadBase = object
    cap: int

  NimSeqPayload[T] = object
    cap: int
    data: UncheckedArray[T]

  NimSeqV2*[T] = object # \
    # if you change this implementation, also change seqs_v2_reimpl.nim!
    len: int
    p: ptr NimSeqPayload[T]

  NimRawSeq = object
    len: int
    p: pointer

const nimSeqVersion {.core.} = 2

# XXX make code memory safe for overflows in '*'

proc newSeqPayload(cap, elemSize, elemAlign: int): pointer {.compilerRtl, raises: [].} =
  # we have to use type erasure here as Nim does not support generic
  # compilerProcs. Oh well, this will all be inlined anyway.
  if cap > 0:
    var p = cast[ptr NimSeqPayloadBase](alignedAlloc0(align(sizeof(NimSeqPayloadBase), elemAlign) + cap * elemSize, elemAlign))
    p.cap = cap
    result = p
  else:
    result = nil

proc newSeqPayloadUninit(cap, elemSize, elemAlign: int): pointer {.compilerRtl, raises: [].} =
  # Used in `newSeqOfCap()`.
  if cap > 0:
    var p = cast[ptr NimSeqPayloadBase](alignedAlloc(align(sizeof(NimSeqPayloadBase), elemAlign) + cap * elemSize, elemAlign))
    p.cap = cap
    result = p
  else:
    result = nil

template `+!`(p: pointer, s: int): pointer =
  cast[pointer](cast[int](p) +% s)

template `-!`(p: pointer, s: int): pointer =
  cast[pointer](cast[int](p) -% s)

proc prepareSeqAdd(len: int; p: pointer; addlen, elemSize, elemAlign: int): pointer {.
    noSideEffect, tags: [], raises: [], compilerRtl.} =
  {.noSideEffect.}:
    let headerSize = align(sizeof(NimSeqPayloadBase), elemAlign)
    if addlen <= 0:
      result = p
    elif p == nil:
      result = newSeqPayload(len+addlen, elemSize, elemAlign)
    else:
      # Note: this means we cannot support things that have internal pointers as
      # they get reallocated here. This needs to be documented clearly.
      var p = cast[ptr NimSeqPayloadBase](p)
      let oldCap = p.cap and not strlitFlag
      let newCap = max(resize(oldCap), len+addlen)
      var q: ptr NimSeqPayloadBase
      if (p.cap and strlitFlag) == strlitFlag:
        q = cast[ptr NimSeqPayloadBase](alignedAlloc(headerSize + elemSize * newCap, elemAlign))
        copyMem(q +! headerSize, p +! headerSize, len * elemSize)
      else:
        let oldSize = headerSize + elemSize * oldCap
        let newSize = headerSize + elemSize * newCap
        q = cast[ptr NimSeqPayloadBase](alignedRealloc(p, oldSize, newSize, elemAlign))

      zeroMem(q +! headerSize +! len * elemSize, addlen * elemSize)
      q.cap = newCap
      result = q

proc zeroNewElements(len: int; q: pointer; addlen, elemSize, elemAlign: int) {.
    noSideEffect, tags: [], raises: [], compilerRtl.} =
  {.noSideEffect.}:
    let headerSize = align(sizeof(NimSeqPayloadBase), elemAlign)
    zeroMem(q +! headerSize +! len * elemSize, addlen * elemSize)

proc prepareSeqAddUninit(len: int; p: pointer; addlen, elemSize, elemAlign: int): pointer {.
    noSideEffect, tags: [], raises: [], compilerRtl.} =
  {.noSideEffect.}:
    let headerSize = align(sizeof(NimSeqPayloadBase), elemAlign)
    if addlen <= 0:
      result = p
    elif p == nil:
      result = newSeqPayloadUninit(len+addlen, elemSize, elemAlign)
    else:
      # Note: this means we cannot support things that have internal pointers as
      # they get reallocated here. This needs to be documented clearly.
      var p = cast[ptr NimSeqPayloadBase](p)
      let oldCap = p.cap and not strlitFlag
      let newCap = max(resize(oldCap), len+addlen)
      if (p.cap and strlitFlag) == strlitFlag:
        var q = cast[ptr NimSeqPayloadBase](alignedAlloc(headerSize + elemSize * newCap, elemAlign))
        copyMem(q +! headerSize, p +! headerSize, len * elemSize)
        q.cap = newCap
        result = q
      else:
        let oldSize = headerSize + elemSize * oldCap
        let newSize = headerSize + elemSize * newCap
        var q = cast[ptr NimSeqPayloadBase](alignedRealloc(p, oldSize, newSize, elemAlign))
        q.cap = newCap
        result = q

const fosSeqsPatched* = true ## what tests/test_patched_seqs.nim checks it was built against

# The indices below are in range by construction and the sizes those of
# blocks that exist: no bounds or overflow checks.
{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc fosSeqGrow(s: pointer; newLen, elemSize, elemAlign: int; zero: bool) {.
    noSideEffect, tags: [], raises: [].} =
  ## Grows the seq at `s`, of any element type, to `newLen` (more than it
  ## holds): the stock `setLen`'s capacity check and `prepareSeqAddUninit`.
  ## The new slots are zeroed when `zero`, left as they are otherwise.
  {.noSideEffect.}:
    let xu = cast[ptr NimRawSeq](s)
    let oldLen = xu.len
    if xu.p == nil or (cast[ptr NimSeqPayloadBase](xu.p).cap and not strlitFlag) < newLen:
      xu.p = prepareSeqAddUninit(oldLen, xu.p, newLen - oldLen, elemSize, elemAlign)
    if zero:
      zeroNewElements(oldLen, xu.p, newLen - oldLen, elemSize, elemAlign)
    xu.len = newLen

proc fosSeqSlot(s: pointer; elemSize, elemAlign: int): pointer {.
    noSideEffect, tags: [], raises: [].} =
  ## One slot more at the end of the seq at `s`, as the stock `add` makes
  ## it: the slot's address, its bytes left as they are.
  let oldLen = cast[ptr NimRawSeq](s).len
  fosSeqGrow(s, oldLen + 1, elemSize, elemAlign, false)
  result = cast[ptr NimRawSeq](s).p +! (align(sizeof(NimSeqPayloadBase), elemAlign) + oldLen * elemSize)

proc fosZeroIsDefault(T: typedesc): bool {.compileTime.} =
  ## Whether a slot of zero bytes is `default(T)`. True only for types whose
  ## default cannot be anything else: never an object or a tuple (field
  ## defaults, a type header). Nim 2.2 gives an enum or a range zero too,
  ## even one that starts above it; the `ord` asks, in case that changes.
  when T is (ref | ptr | pointer | cstring | string | seq | SomeFloat):
    true
  elif T is (SomeInteger | char | bool | enum):
    ord(default(T)) == 0
  else:
    false

proc shrink*[T](x: var seq[T]; newLen: Natural) {.tags: [], raises: [].} =
  when nimvm:
    {.cast(tags: []).}:
      setLen(x, newLen)
  else:
    #sysAssert newLen <= x.len, "invalid newLen parameter for 'shrink'"
    when not supportsCopyMem(T):
      for i in countdown(x.len - 1, newLen):
        reset x[i]
    # XXX This is wrong for const seqs that were moved into 'x'!
    {.noSideEffect.}:
      cast[ptr NimSeqV2[T]](addr x).len = newLen

proc grow*[T](x: var seq[T]; newLen: Natural; value: T) {.nodestroy.} =
  let oldLen = x.len
  #sysAssert newLen >= x.len, "invalid newLen parameter for 'grow'"
  if newLen <= oldLen: return
  fosSeqGrow(addr x, newLen, sizeof(T), alignof(T), false)
  var xu = cast[ptr NimSeqV2[T]](addr x)
  for i in oldLen .. newLen-1:
    when (NimMajor, NimMinor, NimPatch) >= (2, 3, 1):
      xu.p.data[i] = `=dup`(value)
    else:
      wasMoved(xu.p.data[i])
      `=copy`(xu.p.data[i], value)

proc add*[T](x: var seq[T]; y: sink T) {.magic: "AppendSeqElem", noSideEffect, nodestroy.} =
  ## Generic proc for adding a data item `y` to a container `x`.
  ##
  ## For containers that have an order, `add` means *append*. New generic
  ## containers should also call their adding proc `add` for consistency.
  ## Generic code becomes much easier to write if the Nim naming scheme is
  ## respected.
  {.cast(noSideEffect).}:
    # .nodestroy means this assignment is compiled into a copyMem(). This is
    # fine as we know by construction that in the new slot there is nothing
    # to destroy. We also save the `wasMoved + destroy` pair for the sink
    # parameter.
    cast[ptr T](fosSeqSlot(addr x, sizeof(T), alignof(T)))[] = y

proc setLen[T](s: var seq[T], newlen: Natural) {.nodestroy.} =
  {.noSideEffect.}:
    if newlen < s.len:
      shrink(s, newlen)
    elif newlen > s.len:
      when fosZeroIsDefault(T):
        fosSeqGrow(addr s, newlen, sizeof(T), alignof(T), true)
      else:
        let oldLen = s.len
        fosSeqGrow(addr s, newlen, sizeof(T), alignof(T), false)
        var xu = cast[ptr NimSeqV2[T]](addr s)
        for i in oldLen..<newlen:
          xu.p.data[i] = default(T)

{.pop.}

proc newSeq[T](s: var seq[T], len: Natural) =
  shrink(s, 0)
  setLen(s, len)

proc sameSeqPayload(x: pointer, y: pointer): bool {.compilerRtl, inl.} =
  result = cast[ptr NimRawSeq](x)[].p == cast[ptr NimRawSeq](y)[].p


func capacity*[T](self: seq[T]): int {.inline.} =
  ## Returns the current capacity of the seq.
  # See https://github.com/nim-lang/RFCs/issues/460
  runnableExamples:
    var lst = newSeqOfCap[string](cap = 42)
    lst.add "Nim"
    assert lst.capacity == 42

  let sek = cast[ptr NimSeqV2[T]](unsafeAddr self)
  result = if sek.p != nil: sek.p.cap and not strlitFlag else: 0

func setLenUninit*[T](s: var seq[T], newlen: Natural) {.nodestroy.} =
  ## Sets the length of seq `s` to `newlen`. `T` may be any sequence type.
  ## New slots will not be initialized.
  ##
  ## If the current length is greater than the new length,
  ## `s` will be truncated.
  ##   ```nim
  ##   var x = @[10, 20]
  ##   x.setLenUninit(5)
  ##   x[4] = 50
  ##   assert x[4] == 50
  ##   x.setLenUninit(1)
  ##   assert x == @[10]
  ##   ```
  {.noSideEffect.}:
    if newlen < s.len:
      shrink(s, newlen)
    elif newlen > s.len:
      fosSeqGrow(addr s, newlen, sizeof(T), alignof(T), false)

{.pop.}  # See https://github.com/nim-lang/Nim/issues/21401
