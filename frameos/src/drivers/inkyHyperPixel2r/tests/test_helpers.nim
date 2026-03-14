import std/unittest

import ../inkyHyperPixel2r

suite "inkyHyperPixel2r driver helpers":
  teardown:
    execCmdHook = nil

  test "turnOn and turnOff use python scripts":
    var commands: seq[string] = @[]
    execCmdHook = proc(command: string): int {.nimcall.} =
      commands.add(command)
      0

    let driver = Driver(mode: "linux")
    driver.turnOn()
    driver.turnOff()

    check commands == @[
      "cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOn.py",
      "cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOff.py"
    ]
