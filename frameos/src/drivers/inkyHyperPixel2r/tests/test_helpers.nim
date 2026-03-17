import std/unittest

import ../inkyHyperPixel2r
import frameos/types

suite "inkyHyperPixel2r driver helpers":
  teardown:
    execCmdHook = nil

  test "deviceInit returns hyperpixel vendor requirements":
    let spec = deviceInit(FrameConfig(device: "pimoroni.hyperpixel2r"))
    check not spec.isNil
    check spec.ensureAptPackages == @["python3-dev", "python3-pip", "python3-venv"]
    check spec.pythonVendorFolders == @["inkyHyperPixel2r"]

  test "deviceInit ignores other devices":
    check deviceInit(FrameConfig(device: "framebuffer")).isNil

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
