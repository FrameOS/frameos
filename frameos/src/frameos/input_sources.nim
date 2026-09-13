## What can drive this frame from the room it stands in, published by the host
## once the drivers are up so the status screen can name the sources without
## importing the driver layer.
##
## The scene that prints this (`system/index`) is compiled for the wasm
## preview and the ESP32 too, where `drivers/drivers` does not exist, so the
## dependency has to point this way: the host registers, the scene reads.

import std/locks

var inputSourcesLock: Lock
initLock(inputSourcesLock)
var inputSources: seq[string] = @[]

proc noteInputSource*(name: string) {.gcsafe.} =
  ## Register a driver that can deliver input events. Idempotent, so a
  ## re-init after a config reload does not double up the list.
  {.cast(gcsafe).}:
    withLock inputSourcesLock:
      if name.len > 0 and name notin inputSources:
        inputSources.add(name)

proc inputSourceNames*(): seq[string] {.gcsafe.} =
  ## A copy, never the shared seq: callers read this from the render thread.
  {.cast(gcsafe).}:
    withLock inputSourcesLock:
      result = inputSources

proc resetInputSourcesForTest*() =
  withLock inputSourcesLock:
    inputSources = @[]
