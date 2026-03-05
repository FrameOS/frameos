import std/unittest

import ../inkyHyperPixel2r

suite "inkyHyperPixel2r driver helpers":
  teardown:
    execCmdHook = nil

  test "turnOn and turnOff use nixos helper commands":
    var commands: seq[string] = @[]
    execCmdHook = proc(command: string): int {.nimcall.} =
      commands.add(command)
      0

    let driver = Driver(mode: "nixos")
    driver.turnOn()
    driver.turnOff()

    check commands == @["inkyHyperPixel2r-turnOn", "inkyHyperPixel2r-turnOff"]

  test "turnOn and turnOff use python scripts outside nixos mode":
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
