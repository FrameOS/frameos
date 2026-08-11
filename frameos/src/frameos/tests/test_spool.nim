import std/[json, os, strutils, unittest]
import ../spool
import ../types
import ../values

# The byte-side tier ladder (docs/value-pipeline.md, phase 2).
#
# The point of a spool is that a consumer does not have to know which tier it
# got: the same iteration works over an in-memory string and a 4MB file, and
# the file version never holds more than a window. These pin both halves of
# that — that the tiers agree on content, and that the file tier really does
# stay windowed rather than quietly materializing behind the API.

const ScratchDir = "tmp/spool-tests"

proc writeFixture(name, body: string): string =
  createDir(ScratchDir)
  result = ScratchDir / name
  writeFile(result, body)

suite "spool tiers":
  test "an in-memory spool reads back exactly":
    let s = newMemorySpool("hello world")
    check s.len == 11
    check not s.isFileBacked()
    check s.materialize() == "hello world"

  test "a file-backed spool reads back exactly":
    let path = writeFixture("plain.txt", "hello world")
    let s = newFileSpool(path, 11, owned = false)
    check s.isFileBacked()
    check s.len == 11
    check s.materialize() == "hello world"
    removeFile(path)

  test "both tiers iterate lines identically, across window boundaries":
    # Deliberately larger than the window, with lines that straddle it: the
    # partial-line carry is the part that goes wrong if it goes wrong.
    var body = ""
    for i in 0 ..< 500:
      body.add("LINE" & $i & ":" & repeat('x', i mod 37) & "\r\n")
    let path = writeFixture("lines.txt", body)

    var fromMemory: seq[string] = @[]
    for line in newMemorySpool(body).lines():
      fromMemory.add(line)
    var fromFile: seq[string] = @[]
    for line in newFileSpool(path, body.len, owned = false).lines(windowBytes = 64):
      fromFile.add(line)

    check fromMemory.len == 500
    check fromMemory == fromFile
    check fromMemory[0] == "LINE0:"
    check fromMemory[499].startsWith("LINE499:")
    removeFile(path)

  test "a trailing line without a newline is still yielded":
    var lines: seq[string] = @[]
    for line in newMemorySpool("a\nb\nc").lines():
      lines.add(line)
    check lines == @["a", "b", "c"]

  test "windows never exceed the requested size":
    let body = repeat('z', 5000)
    let path = writeFixture("windows.txt", body)
    var biggest = 0
    var total = 0
    for window in newFileSpool(path, body.len, owned = false).windows(windowBytes = 512):
      biggest = max(biggest, window.len)
      total += window.len
    check biggest <= 512
    check total == 5000
    removeFile(path)

  test "materialize refuses rather than attempting an allocation it cannot make":
    let s = newMemorySpool(repeat('q', 2048))
    expect IOError:
      discard s.materialize(maxBytes = 1024)
    # …and says how far over it is, so a scene can show something useful.
    try:
      discard s.materialize(maxBytes = 1024)
    except IOError as e:
      check e.msg.contains("2K")
      check e.msg.contains("1K")

suite "spool writer":
  test "stays in memory below the threshold":
    var w = initSpoolWriter(thresholdBytes = 1024, dir = ScratchDir)
    w.add("small body")
    let s = w.finish()
    check not s.isFileBacked()
    check s.materialize() == "small body"

  test "spills past the threshold and keeps every byte written before it":
    var w = initSpoolWriter(thresholdBytes = 16, dir = ScratchDir)
    w.add("0123456789")      # under
    w.add("abcdefghijklmnop") # crosses
    w.add("TAIL")
    let s = w.finish()
    check s.isFileBacked()
    check s.len == 30
    check s.materialize() == "0123456789abcdefghijklmnopTAIL"
    removeFile(s.path())

  test "an unwritable preferred directory never loses bytes or raises":
    # A frame whose SD card is missing or full must not start failing
    # downloads that used to work. Storage is a preference: the writer tries
    # the preferred directory, falls back (here, to the platform temp dir),
    # and falls all the way back to memory if there is nowhere at all — but
    # the bytes come back either way, which is the only promise callers have.
    const body = "this is comfortably past the threshold"
    var w = initSpoolWriter(thresholdBytes = 8, dir = "/frameos-cannot-write-here")
    w.add(body, "degrade.tmp")
    let s = w.finish()
    check s.materialize() == body
    # And whichever tier it landed on, it reports that tier truthfully.
    check w.spilled() == s.isFileBacked()
    if s.isFileBacked():
      removeFile(s.path())

  test "a threshold of zero never spills":
    var w = initSpoolWriter(thresholdBytes = 0, dir = ScratchDir)
    w.add(repeat('x', 100_000))
    let s = w.finish()
    check not s.isFileBacked()
    check s.len == 100_000

suite "spool values":
  test "asString materializes a spooled value, so old consumers are unchanged":
    let v = VSpool(newMemorySpool("payload"))
    check v.kind == fkSpool
    check v.asString() == "payload"
    check valueToJson(v) == %*"payload"

  test "asSpool works on a plain string too, so consumers need not branch":
    check VString("plain").asSpool().materialize() == "plain"
    check VSpool(newMemorySpool("spooled")).asSpool().materialize() == "spooled"

  test "a file-backed value is sized by what it costs to HOLD, not its length":
    let path = writeFixture("sized.txt", repeat('y', 400_000))
    let v = VSpool(newFileSpool(path, 400_000, owned = false))
    # The whole point of the tier: 400KB of body, one window resident.
    check v.approxByteSize() == DefaultWindowBytes
    check VSpool(newMemorySpool(repeat('y', 4000))).approxByteSize() == 4000
    removeFile(path)

  test "the debug string never dumps the payload":
    let v = VSpool(newMemorySpool(repeat('s', 100_000)))
    check $v == "spool(100000 bytes, memory)"

suite "spool ownership":
  test "an owned spool deletes its file when it goes away":
    let path = writeFixture("owned.txt", "temporary")
    block:
      let s = newFileSpool(path, 9)
      check s.materialize() == "temporary"
    GC_fullCollect()
    check not fileExists(path)

  test "a disowned spool leaves the file alone":
    let path = writeFixture("kept.txt", "permanent")
    block:
      let s = newFileSpool(path, 9)
      s.disown()
    GC_fullCollect()
    check fileExists(path)
    removeFile(path)

removeDir(ScratchDir)
