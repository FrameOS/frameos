import std/[os, streams, strutils, unittest]

import frameos/spool
import ../line_reader

const ScratchDir = "tmp/line-reader-tests"

proc writeFixture(name, contents: string): string =
  createDir(ScratchDir)
  result = ScratchDir / name
  writeFile(result, contents)

proc collect(stream: Stream, options = LineOptions()): seq[string] =
  let reader = newLineReader(stream, options)
  var line = ""
  while reader.nextLine(line):
    result.add(line)

proc lines(body: string, options = LineOptions()): seq[string] =
  collect(newStream(newMemorySpool(body)), options)

suite "LineReader":
  test "both spool tiers read lines identically, across window boundaries":
    var body = ""
    for i in 0 ..< 3000:
      body.add("LINE" & $i & ":" & repeat('x', i mod 37) & "\r\n")
    let path = writeFixture("lines.txt", body)
    let fromMemory = lines(body)
    let fromFile = collect(newStream(newFileSpool(path, body.len, owned = false)))
    check body.len > 3 * LineWindowBytes
    check fromMemory.len == 3000
    check fromMemory == fromFile
    check fromMemory[2999].startsWith("LINE2999:")

  test "a trailing line without a newline is still returned, a trailing newline adds none":
    check lines("a\nb\nc") == @["a", "b", "c"]
    check lines("a\nb\n") == @["a", "b"]
    check lines("").len == 0

  test "CRLF, LF and a bare CR all end a line":
    check lines("a\rb\r\nc\nd\r\re") == @["a", "b", "c", "d", "", "e"]

  test "a CRLF split across a window boundary is one terminator":
    let body = repeat('a', LineWindowBytes - 1) & "\r\nnext"
    let got = lines(body)
    check got.len == 2
    check got[0].len == LineWindowBytes - 1
    check got[1] == "next"

  test "unfold joins continuations and drops their first space or tab":
    check lines("A:one\r\n two\r\n\tthree\r\nB:x\r\n", LineOptions(unfold: true)) == @["A:onetwothree", "B:x"]
    # Without it they are lines of their own.
    check lines("A:one\n two\n") == @["A:one", " two"]

  test "unfold across a window boundary":
    let head = "A:" & repeat('x', LineWindowBytes - 4)
    let got = lines(head & "\r\n tail\r\nB:y", LineOptions(unfold: true))
    check got == @[head & "tail", "B:y"]

  test "only keeps the named prefixes, and their folded lines":
    let body = "UID:1\nATTENDEE:a\n b\n c\nSUMMARY:hi\n there\nX:z\n"
    check lines(body, LineOptions(unfold: true, only: @["UID", "SUMMARY"])) == @["UID:1", "SUMMARY:hithere"]

  test "a dropped line costs no memory however long it is":
    let body = "SKIP:" & repeat('x', 5_000_000) & "\nKEEP:1\n"
    check lines(body, LineOptions(only: @["KEEP"])) == @["KEEP:1"]

  test "a kept line longer than maxLength is cut on a character":
    let cut = lines(repeat("é", 100), LineOptions(maxLength: 21))
    check cut.len == 1
    check cut[0].len == 20
    check cut[0] == repeat("é", 10)
    # The rest of that line, and its folded continuations, are gone with it.
    let folded = lines("A:" & repeat('x', 100) & "\n more\nB:y\n", LineOptions(unfold: true, maxLength: 10))
    check folded == @["A:xxxxxxxx", "B:y"]

  test "trim strips ASCII whitespace off both ends":
    check lines("  a b \t\n\t\n", LineOptions(trim: true)) == @["a b", ""]

  test "nextBlock returns one record's kept lines, without its end line":
    let reader = newLineReader(newStream(newMemorySpool(
      "BEGIN\nA:1\nDROP:x\nB:2\nEND\nBEGIN\nA:3\nEND\nBEGIN\nA:unterminated\n")),
      LineOptions(only: @["A", "B", "END", "BEGIN"]))
    var line, record = ""
    check reader.nextLine(line) and line == "BEGIN"
    check reader.nextBlock("END", record)
    check record == "A:1\nB:2"
    check reader.nextLine(line) and line == "BEGIN"
    check reader.nextBlock("END", record)
    check record == "A:3"
    check reader.nextLine(line) and line == "BEGIN"
    check not reader.nextBlock("END", record) # no end is no record

  test "rewind starts over":
    let reader = newLineReader(newStream(newMemorySpool("a\nb\n")))
    var line = ""
    check reader.nextLine(line) and line == "a"
    reader.rewind()
    check reader.nextLine(line) and line == "a"
    check reader.nextLine(line) and line == "b"
    check not reader.nextLine(line)

removeDir(ScratchDir)
