## What a Linux frame is, for the frame page's About card
## (system/sceneSettings, docs/scene-settings.md "About"): read off /proc,
## /sys and /etc on each read of the page, the numbers as they are (bytes as
## bytes, [total, free] for what fills). The page has the words and the
## units; the ESP32's twin is `put_about` in main/fos_frame_settings.c.
##
## Values only, made on the thread that asks (the runner's): nothing here is
## kept between reads.

import std/[cpuinfo, json, os, posix, strutils]
from frameos/utils/system import blocksToBytes, systemHostname

var
  aboutRoot* = ""
    ## Where /proc, /sys and /etc are: "" on a frame, a directory of a test's
    ## files in a test.
  aboutMachineForTest* = ""
    ## uname's machine, for a test.

proc readSmall(path: string): string =
  ## A small file under the root, without its trailing NULs and new lines
  ## (the device tree's strings end in a NUL); "" when it cannot be read.
  try:
    result = readFile(aboutRoot & path).strip(chars = Whitespace + {'\0'})
  except CatchableError:
    discard

proc machine(): string =
  if aboutMachineForTest.len > 0:
    return aboutMachineForTest
  var names: Utsname
  if uname(names) == 0:
    result = $cast[cstring](addr names.machine[0])

proc soc(): string =
  ## A Raspberry Pi's SoC, the device tree's last `brcm,bcm…` ("bcm2711").
  for entry in readSmall("/proc/device-tree/compatible").split('\0'):
    if entry.startsWith("brcm,bcm"):
      result = entry[5 .. ^1]

proc osName(): string =
  ## /etc/os-release's PRETTY_NAME ("Debian GNU/Linux 12 (bookworm)",
  ## "Buildroot 2025.02").
  for line in readSmall("/etc/os-release").splitLines():
    if line.startsWith("PRETTY_NAME="):
      return line[12 .. ^1].strip(chars = {'"', '\''})

proc kilobytes(line: string): int64 =
  ## A /proc/meminfo line's value, "MemTotal:  3884484 kB", in bytes.
  let parts = line.splitWhitespace()
  if parts.len >= 2:
    try:
      result = parseBiggestInt(parts[1]).int64 * 1024
    except ValueError:
      discard

proc diskOf(path: string): tuple[total, free: int64] =
  ## The filesystem `path` is on: its size and what is free for the frame.
  let fd = posix.open(path.cstring, O_RDONLY)
  if fd < 0:
    return
  var stats: StatVfs
  if fstatvfs(fd, stats) == 0:
    result.total = blocksToBytes(stats.f_blocks.int64, stats.f_frsize.int64)
    result.free = blocksToBytes(stats.f_bavail.int64, stats.f_frsize.int64)
  discard posix.close(fd)

proc linuxAboutFacts*(netDevice = "", frameDir = "."): JsonNode =
  ## The facts, each left out where this system does not say: `chip` (uname's
  ## machine), `soc`, `cores`, `mhz`, `board` (the device tree's model),
  ## `system`, `memory` and `storage` ([total, free]), `uptime` (seconds),
  ## `mac` (of `netDevice`, else the first of wlan0, eth0, end0 there is) and
  ## `hostname`. The frame's control plane is the caller's (`server`).
  result = newJObject()
  let arch = machine()
  if arch.len > 0:
    result["chip"] = %arch
  let chip = soc()
  if chip.len > 0:
    result["soc"] = %chip
  result["cores"] = %countProcessors()
  try:
    let khz = parseInt(readSmall("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"))
    if khz > 0:
      result["mhz"] = %(khz div 1000)
  except ValueError:
    discard
  let model = readSmall("/proc/device-tree/model")
  if model.len > 0:
    result["board"] = %model
  let system = osName()
  if system.len > 0:
    result["system"] = %system
  var total, available: int64
  for line in readSmall("/proc/meminfo").splitLines():
    if line.startsWith("MemTotal:"):
      total = kilobytes(line)
    elif line.startsWith("MemAvailable:"):
      available = kilobytes(line)
  if total > 0:
    result["memory"] = %[total, available]
  let disk = diskOf(frameDir)
  if disk.total > 0:
    result["storage"] = %[disk.total, disk.free]
  let up = readSmall("/proc/uptime").split(' ')
  try:
    result["uptime"] = %int64(parseFloat(up[0]))
  except ValueError:
    discard
  for device in [netDevice, "wlan0", "eth0", "end0"]:
    if device.len > 0 and '/' notin device:
      let mac = readSmall("/sys/class/net/" & device & "/address")
      if mac.len > 0 and mac != "00:00:00:00:00:00":
        result["mac"] = %mac
        break
  let name = systemHostname()
  if name.len > 0:
    result["hostname"] = %name
