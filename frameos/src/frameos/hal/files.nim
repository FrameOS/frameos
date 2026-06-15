## File-storage HAL.
##
## Everything in the runtime that touches the filesystem (frame.json, scene
## state, logs, boot guard, cached assets) goes through this module so the
## embedded (ESP32/FreeRTOS) build can swap the backing store without forking
## the callers. On Linux it's a thin veneer over std/os; the embedded build
## has no general-purpose filesystem — its config lives in NVS and scenes ship
## inside the firmware — so these raise IOError if something reaches them.

when defined(frameosEmbedded):
  proc noFs(path: string): ref IOError =
    newException(IOError, "no filesystem on embedded build: " & path)

  proc readTextFile*(path: string): string = raise noFs(path)
  proc writeTextFile*(path, content: string) = raise noFs(path)
  proc appendTextLine*(path, line: string) = raise noFs(path)
  proc storedFileExists*(path: string): bool = false
  proc removeStoredFile*(path: string) = raise noFs(path)
  proc ensureDir*(path: string) = discard
  proc ensureParentDir*(path: string) = discard
else:
  import std/os

  proc readTextFile*(path: string): string {.inline.} =
    readFile(path)

  proc writeTextFile*(path, content: string) {.inline.} =
    writeFile(path, content)

  proc appendTextLine*(path, line: string) =
    ## Open-append-close per line: a write failure (ENOSPC) must still close
    ## the handle or every failing line leaks an fd.
    let file = open(path, fmAppend)
    try:
      file.write(line & "\n")
    finally:
      file.close()

  proc storedFileExists*(path: string): bool {.inline.} =
    fileExists(path)

  proc removeStoredFile*(path: string) {.inline.} =
    removeFile(path)

  proc ensureDir*(path: string) {.inline.} =
    createDir(path)

  proc ensureParentDir*(path: string) {.inline.} =
    createDir(parentDir(path))
