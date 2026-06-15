## Time HAL: wall clock, monotonic clock, and blocking sleep.
##
## std/times and std/monotimes work on both Linux and ESP-IDF (newlib provides
## clock_gettime; SNTP sets the wall clock on embedded), so the value of this
## module is the seam: callers shouldn't care which platform supplies time,
## and the embedded build can reroute sleep to the RTOS scheduler.

import std/[times, monotimes]

proc epochSeconds*(): float {.inline.} =
  epochTime()

proc monoMillis*(): int64 {.inline.} =
  getMonoTime().ticks div 1_000_000

when defined(frameosEmbedded):
  proc usleep(usecs: uint32): cint {.importc, header: "<unistd.h>".}

  proc sleepMs*(ms: int) =
    ## newlib's usleep on ESP-IDF yields through vTaskDelay.
    if ms > 0:
      discard usleep(uint32(ms) * 1000)
else:
  import std/os

  proc sleepMs*(ms: int) {.inline.} =
    if ms > 0:
      sleep(ms)
