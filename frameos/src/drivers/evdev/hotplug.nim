## What the evdev driver's hotplug asks of the file system, kept apart from
## libevdev so it is testable on a machine without it.

import std/posix

proc inputNodeExists*(path: string): bool =
  ## Whether a device node is there, whatever kind of file it is. Not
  ## `fileExists`, which is true of regular files alone: every node in
  ## /dev/input is a character device, so with it every keyboard and mouse
  ## plugged in after the runtime started was dropped without a word
  ## (2026-09-26 to 2026-11-28).
  var info: Stat
  stat(path.cstring, info) == 0
