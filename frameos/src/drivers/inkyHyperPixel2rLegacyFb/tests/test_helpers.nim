import std/unittest

import ../inkyHyperPixel2rLegacyFb

suite "inkyHyperPixel2r legacy framebuffer driver helpers":
  teardown:
    backlightHook = nil

  test "turnOn and turnOff drive the backlight GPIO in-process, no Python":
    # The vendored RPi.GPIO scripts are gone: a Buildroot image has no
    # python3, and the driver's setup step used to fail on it before the
    # panel ever rendered.
    var levels: seq[bool] = @[]
    backlightHook = proc(on: bool): int =
      levels.add(on)
      0

    let driver = Driver()
    driver.turnOn()
    driver.turnOff()
    driver.turnOn()

    check levels == @[true, false, true]

  test "setup installs nothing":
    let result = setup()
    check not result.rebootRequired
