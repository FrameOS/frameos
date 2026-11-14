## The embedded build's seqs (patched_seqs_v2.nim), which only frameosEmbedded
## compiles in. Built with the patch (tests/test_patched_seqs.nims): every
## seq in this binary goes through it, so the model each churn is checked
## against is a fixed array, never a seq.

import std/unittest

when not declared(fosSeqsPatched):
  {.error: "built without tests/test_patched_seqs.nims: this is testing system/seqs_v2".}

type
  Kind = enum kOne = 1, kTwo, kThree
  Small = range[3..9]
  Id = distinct int
  Box = ref object
    value: int
  Plain = object
    a: int
    b: float
  WithDefaults = object
    count: int = 7
    name: string = "seven"
    ratio: float = 0.5
  Base = object of RootObj
    tag: int
  Derived = object of Base
    extra: string
  Odd = object # size 16, alignment 8
    a: int8
    b: int64
  Tiny = object # size 3, alignment 1
    a, b, c: int8

proc `==`(a, b: Id): bool {.borrow.}

var freed = 0
type Tracked = object
  id: int
proc `=destroy`(x: Tracked) =
  if x.id != 0:
    inc freed

proc tag(x: Base): int = x.tag
method describe(x: ref Base): string {.base.} = "base"
method describe(x: ref Derived): string = "derived"

template checkNewSlotsAreDefault(T: typedesc) =
  block:
    var s: seq[T]
    s.setLen(5)
    check s.len == 5
    for x in s:
      check x == default(T)
    # Grown again after a shrink, the old slots must not come back.
    s.setLen(1)
    s.setLen(4)
    for x in s:
      check x == default(T)

suite "patched seqs":
  test "new slots hold each type's default":
    checkNewSlotsAreDefault(int)
    checkNewSlotsAreDefault(uint8)
    checkNewSlotsAreDefault(float)
    checkNewSlotsAreDefault(char)
    checkNewSlotsAreDefault(bool)
    checkNewSlotsAreDefault(string)
    checkNewSlotsAreDefault(seq[int])
    checkNewSlotsAreDefault(Kind)
    checkNewSlotsAreDefault(Small)
    checkNewSlotsAreDefault(Id)
    checkNewSlotsAreDefault(Box)
    checkNewSlotsAreDefault(Plain)
    checkNewSlotsAreDefault(WithDefaults)
    checkNewSlotsAreDefault((string, int))
    # Nim 2.2's default for an enum or a range is zero, even outside it.
    var kinds: seq[Kind]
    kinds.setLen(3)
    check ord(kinds[2]) == ord(default(Kind))
    var withDefaults: seq[WithDefaults]
    withDefaults.add(WithDefaults(count: 1, name: "one"))
    withDefaults.setLen(3)
    check withDefaults[0].count == 1 and withDefaults[0].name == "one"
    check withDefaults[2].count == 7 and withDefaults[2].name == "seven" and withDefaults[2].ratio == 0.5

  test "objects with a type header keep it":
    var bases: seq[Base]
    bases.setLen(3)
    bases.add(Base(tag: 4))
    check bases[3].tag == 4
    check bases[0].tag == 0
    var refs: seq[ref Base]
    for i in 0 ..< 40:
      let d = new Derived
      d.extra = $i
      refs.add(d)
      refs.add(new Base)
    check refs[0].describe == "derived"
    check refs[1].describe == "base"
    check (ref Derived)(refs[78]).extra == "39"

  test "adds across growth, at every size and alignment":
    var odd: seq[Odd]
    var tiny: seq[Tiny]
    var bytes: seq[uint8]
    var strings: seq[string]
    for i in 0 ..< 1000:
      odd.add(Odd(a: int8(i mod 100), b: int64(i) * 1_000_000_007))
      tiny.add(Tiny(a: int8(i mod 7), b: int8(i mod 11), c: int8(i mod 13)))
      bytes.add(uint8(i and 0xff))
      strings.add("s" & $i)
    for i in 0 ..< 1000:
      check odd[i].a == int8(i mod 100) and odd[i].b == int64(i) * 1_000_000_007
      check tiny[i].a == int8(i mod 7) and tiny[i].b == int8(i mod 11) and tiny[i].c == int8(i mod 13)
      check bytes[i] == uint8(i and 0xff)
      check strings[i] == "s" & $i

  test "a literal seq is copied before it grows":
    const literal = @[1, 2, 3]
    var s = literal
    s.add(4)
    check s == @[1, 2, 3, 4]
    var t = literal
    t.setLen(5)
    check t == @[1, 2, 3, 0, 0]
    var u = literal
    u.grow(5, 9)
    check u == @[1, 2, 3, 9, 9]
    check literal == @[1, 2, 3]

  test "a churn matches a fixed-array model":
    var s: seq[string]
    var model: array[600, string]
    var modelLen = 0
    var seed = 12345
    for step in 0 ..< 20000:
      seed = (seed * 1103515245 + 12345) and 0x7fffffff
      case seed mod 4
      of 0, 1:
        if modelLen < model.len:
          s.add($step)
          model[modelLen] = $step
          inc modelLen
      of 2:
        let n = (seed div 4) mod 600
        s.setLen(n)
        for i in modelLen ..< n:
          model[i] = ""
        modelLen = n
      else:
        let n = (seed div 4) mod (modelLen + 1)
        s.shrink(n)
        modelLen = n
      check s.len == modelLen
      if s.len != modelLen:
        break
      for i in 0 ..< modelLen:
        if s[i] != model[i]:
          check s[i] == model[i]
          break

  test "dropped elements are destroyed once":
    freed = 0
    var s: seq[Tracked]
    for i in 1 .. 50:
      s.add(Tracked(id: i))
    check freed == 0
    s.setLen(20)
    check freed == 30
    s.shrink(5)
    check freed == 45
    s.setLen(10)
    check freed == 45
    for i in 5 ..< 10:
      check s[i].id == 0
    s = @[]
    check freed == 50

  test "nested seqs and setLenUninit":
    var nested: seq[seq[int]]
    nested.setLen(3)
    nested[1].add(5)
    nested.add(@[7, 8])
    check nested == @[newSeq[int](), @[5], newSeq[int](), @[7, 8]]
    var raw: seq[int]
    raw.setLenUninit(4)
    check raw.len == 4
    raw.setLenUninit(2)
    check raw.len == 2
    var fresh = newSeq[string](3)
    check fresh == @["", "", ""]
