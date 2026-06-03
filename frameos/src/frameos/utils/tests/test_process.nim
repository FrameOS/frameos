import std/unittest

import ../process

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
