import std/[os, osproc, strutils, times, unittest]

import ../process

proc spawnEchoLoop() {.thread.} =
  for i in 0 ..< 5:
    let (output, exitCode) = runShellCapture("echo hi", timeoutMs = 10_000)
    doAssert exitCode == 0
    doAssert output.contains("hi")

suite "external process helpers":
  test "runProcessPiped drains stderr while capturing stdout":
    let script = """
import sys
sys.stderr.write("e" * 200000)
sys.stderr.flush()
data = sys.stdin.buffer.read()
sys.stdout.buffer.write(b"ok:" + data)
sys.stdout.flush()
"""
    let result = runProcessPiped(
      "python3",
      @["-c", script],
      input = "payload",
      timeoutMs = 5000,
      maxOutputBytes = 1024,
      maxErrorBytes = 64
    )

    check result.exitCode == 0
    check not result.timedOut
    check not result.outputExceeded
    check result.output == "ok:payload"
    check result.errorOutput.len == 64

  test "runProcessPiped times out a stuck child":
    let result = runProcessPiped(
      "python3",
      @["-c", "import time; time.sleep(10)"],
      timeoutMs = 200,
      maxOutputBytes = 1024
    )

    check result.exitCode == -1
    check result.timedOut

  test "runProcessPiped bounds stdout":
    let result = runProcessPiped(
      "python3",
      @["-c", "import sys; sys.stdout.write('x' * 2048); sys.stdout.flush()"],
      timeoutMs = 5000,
      maxOutputBytes = 128
    )

    check result.exitCode == -1
    check result.outputExceeded

  test "the defaults bound time and output without being asked":
    # "Wait forever, buffer unbounded" is no longer what a caller gets by
    # leaving the arguments off: the runtime hosts render and event loops on
    # the thread that spawns most children.
    check DefaultProcessTimeoutMs > 0
    check DefaultProcessTimeoutMs <= 5 * 60_000
    check DefaultProcessMaxOutputBytes > 0
    let flood = runProcessPiped(
      "python3",
      @["-c", "import sys; sys.stdout.write('x' * (" & $DefaultProcessMaxOutputBytes & " + 4096)); sys.stdout.flush()"]
    )
    check flood.outputExceeded
    check flood.exitCode == -1
    check flood.output.len <= DefaultProcessMaxOutputBytes
    let (captured, _) = runShellCapture("python3 -c \"import sys; sys.stdout.write('y' * (" &
      $DefaultProcessMaxOutputBytes & " + 4096))\"")
    check captured.len <= DefaultProcessMaxOutputBytes + 65536

  test "runShellCapture captures stdout and appends stderr":
    let (output, exitCode) = runShellCapture("echo out; echo err 1>&2; exit 3", timeoutMs = 5000)
    check exitCode == 3
    check output.contains("out")
    check output.contains("err")

  test "runShellWithParentStreams times out a stuck command":
    let result = runShellWithParentStreams("sleep 10", timeoutMs = 300)
    check result.timedOut
    check result.exitCode == -1

  test "runShellWithParentStreams returns the exit code":
    check runShellWithParentStreams("exit 7", timeoutMs = 5000).exitCode == 7
    check runShellWithParentStreams("true", timeoutMs = 5000).exitCode == 0

  test "writeInputDrainingOutput survives a chatty child":
    # The child floods stdout before reading stdin: a blind blocking write
    # into its stdin would deadlock on the full stdout pipe.
    let script = """
import sys
sys.stdout.write("chatter\n" * 20000)
sys.stdout.flush()
data = sys.stdin.buffer.read()
sys.stdout.write("got:%d\n" % len(data))
sys.stdout.flush()
"""
    var p = startProcessSerialized("python3", args = @["-c", script],
                                   options = {poUsePath, poStdErrToStdOut})
    var reader = initProcessOutputReader(p)
    var input = newSeq[uint8](1024 * 1024)
    let writeResult = p.writeInputDrainingOutput(input, reader, timeoutMs = 10_000)
    check writeResult.inputWritten
    check not writeResult.timedOut

    var sawByteCount = false
    var chatterLines = 0
    let deadline = epochTime() + 10.0
    while epochTime() < deadline:
      for line in reader.readAvailableLines():
        if line == "got:" & $input.len:
          sawByteCount = true
        elif line == "chatter":
          inc chatterLines
      if not p.running() and reader.eof:
        break
      sleep(20)
    for line in reader.readAvailableLines():
      if line == "got:" & $input.len:
        sawByteCount = true
    check sawByteCount
    check chatterLines == 20000
    p.stopProcess()
    p.close()

  test "ProcessOutputReader drops overlong lines instead of buffering them":
    # A child that never ends its line must not grow the reader's buffer
    # without bound; the runaway line is dropped whole, the next one survives.
    let script = """
import sys
sys.stdout.write("x" * 3000000)
sys.stdout.flush()
sys.stdout.write("\nsecond\nthird")
sys.stdout.flush()
"""
    var p = startProcessSerialized("python3", args = @["-c", script],
                                   options = {poUsePath, poStdErrToStdOut})
    var reader = initProcessOutputReader(p, maxLineBytes = 64 * 1024)
    var lines: seq[string] = @[]
    let deadline = epochTime() + 10.0
    while epochTime() < deadline:
      lines.add(reader.readAvailableLines())
      check reader.bufferedBytes() <= 64 * 1024 + 65536
      if not p.running() and reader.eof:
        break
      sleep(10)
    lines.add(reader.readAvailableLines())
    check lines == @["second", "third"]
    check reader.overlongLines == 1
    p.close()

  test "writeInputDrainingOutput times out when the child stops reading":
    var p = startProcessSerialized("python3", args = @["-c", "import time; time.sleep(10)"],
                                   options = {poUsePath, poStdErrToStdOut})
    var reader = initProcessOutputReader(p)
    var input = newSeq[uint8](1024 * 1024)
    let writeResult = p.writeInputDrainingOutput(input, reader, timeoutMs = 300)
    check writeResult.timedOut
    check not writeResult.inputWritten
    p.stopProcess()
    p.close()

  test "concurrent spawns complete under the spawn lock":
    var threads: array[4, Thread[void]]
    for t in threads.mitems:
      createThread(t, spawnEchoLoop)
    for t in threads.mitems:
      joinThread(t)
