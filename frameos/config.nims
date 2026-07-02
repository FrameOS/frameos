# begin Nimble config (version 2)
--noNimblePath
when withDir(thisDir(), system.fileExists("nimble.paths")):
  include "nimble.paths"
# end Nimble config

import std/os

let frameosPixiePath = getEnv("FRAMEOS_PIXIE_PATH")
if frameosPixiePath.len > 0:
  let frameosPixieSrc = frameosPixiePath / "src"
  if not dirExists(frameosPixieSrc / "pixie"):
    quit("FRAMEOS_PIXIE_PATH must point to a pixie checkout with src/pixie/", QuitFailure)

  # Nim resolves later paths first, so this must come after nimble.paths.
  switch("path", frameosPixieSrc)

let frameosZippyPath = getEnv("FRAMEOS_ZIPPY_PATH")
if frameosZippyPath.len > 0:
  let frameosZippySrc = frameosZippyPath / "src"
  if not dirExists(frameosZippySrc / "zippy"):
    quit("FRAMEOS_ZIPPY_PATH must point to a zippy checkout with src/zippy/", QuitFailure)
  switch("path", frameosZippySrc)

when defined(frameosEmbedded):
  # On FreeRTOS, Nim's -d:useMalloc allocator returns nil on exhaustion
  # without raising, turning any out-of-memory render into a null-pointer
  # crash and a device reboot. The patched malloc releases an emergency
  # PSRAM reserve (frameos_nim_glue.c) and retries the allocation; the
  # render loop sheds memory and re-arms the reserve afterwards.
  patchFile("stdlib", "malloc", "src/embedded/patched_malloc")
