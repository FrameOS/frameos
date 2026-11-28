## A device plugged in while the driver runs is opened once its node is there
## (evdev.nim's inotify loop asks inputNodeExists).

import std/[os, unittest]
import ../hotplug

suite "evdev hotplug":
  test "a character device's node is there, as every node in /dev/input is one":
    # The trap this guards against: fileExists is false for a device node.
    check not fileExists("/dev/null")
    check inputNodeExists("/dev/null")

  test "a node that is gone is not":
    check not inputNodeExists("/dev/input/event-that-is-not-there")
