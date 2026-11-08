## The embedded build's shared table probe and rehash (patched_hashcommon.nim,
## patched_tableimpl.nim), which only frameosEmbedded compiles in. Built with
## those two patched in (tests/patched_tables.nims) and run against a model
## table, so a churn of inserts, deletes and growth has to stay identical.

import std/[hashes, sets, strutils, tables]

when not declared(fosTablesPatched):
  {.error: "built without tests/test_patched_tables.nims: this is testing std/tables".}

type
  Id = distinct int
  Name = distinct string
  Box = ref object
    value: int

proc `==`(a, b: Id): bool {.borrow.}
proc `==`(a, b: Name): bool {.borrow.}
proc hash(a: Id): Hash = hash(int(a))
proc hash(a: Name): Hash = hash(string(a))

var freed = 0
type Tracked = object
  id: int
proc `=destroy`(x: Tracked) =
  if x.id != 0:
    inc freed

proc churn[K](makeKey: proc (i: int): K) =
  var table = initTable[K, int]()
  var model: seq[(int, int)]
  var seed = 12345
  for step in 0 ..< 4000:
    seed = (seed * 1103515245 + 12345) and 0x7fffffff
    let i = seed mod 700
    let key = makeKey(i)
    if seed mod 5 == 0:
      table.del(key)
      for at, entry in model:
        if entry[0] == i:
          model.delete(at)
          break
    else:
      table[key] = step
      var found = false
      for at in 0 ..< model.len:
        if model[at][0] == i:
          model[at][1] = step
          found = true
      if not found:
        model.add((i, step))
    doAssert table.len == model.len
  for entry in model:
    doAssert table.hasKey(makeKey(entry[0]))
    doAssert table[makeKey(entry[0])] == entry[1]
  doAssert not table.hasKey(makeKey(100000))
  doAssert table.getOrDefault(makeKey(100000), -7) == -7

churn[string](proc (i: int): string = "key" & $i)
churn[int](proc (i: int): int = i * 31)
churn[Id](proc (i: int): Id = Id(i))
churn[Name](proc (i: int): Name = Name("n" & $i))
churn[uint16](proc (i: int): uint16 = uint16(i))

# A pointer key, by identity.
block:
  var cells: array[64, int]
  var table: Table[ptr int, int]
  for i in 0 ..< cells.len:
    table[addr cells[i]] = i
  for i in 0 ..< cells.len:
    doAssert table[addr cells[i]] == i

# Growth moves managed values: nothing freed early, nothing leaked.
block:
  var table = initTable[string, Tracked](4)
  for i in 1 .. 500:
    table["k" & $i] = Tracked(id: i)
  doAssert freed == 0, "growth destroyed a live value: " & $freed
  for i in 1 .. 500:
    doAssert table["k" & $i].id == i
  table.clear()
  doAssert freed == 500, "after clear: " & $freed

block:
  var table: Table[string, Box]
  for i in 0 .. 400:
    table[$i] = Box(value: i)
  for i in 0 .. 400:
    doAssert table[$i].value == i

# The other users of the two files.
block:
  var ordered = initOrderedTable[string, int]()
  for i in 0 .. 300:
    ordered["o" & $i] = i
  var at = 0
  for key, value in ordered:
    doAssert key == "o" & $at and value == at
    inc at
  ordered.del("o5")
  doAssert not ordered.hasKey("o5") and ordered["o6"] == 6

block:
  var seen = initHashSet[string]()
  for i in 0 .. 300:
    seen.incl("s" & $i)
  seen.excl("s3")
  doAssert seen.len == 300 and "s4" in seen and "s3" notin seen

block:
  var counts = initCountTable[string]()
  for i in 0 .. 300:
    counts.inc("c" & $(i mod 40))
  doAssert counts["c1"] == 8

try:
  discard initTable[string, int]()["missing"]
  doAssert false
except KeyError as error:
  doAssert "missing" in error.msg

echo "ok"
