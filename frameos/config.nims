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

when defined(frameosWasm):
  # The browser preview can simulate a device's memory ceiling, which means
  # allocations have to be counted and refusable. See
  # tools/wasm/fos_wasm_mem.c and src/wasm/patched_malloc.nim.
  patchFile("stdlib", "malloc", "src/wasm/patched_malloc")
elif defined(frameosEmbedded):
  # On FreeRTOS, Nim's -d:useMalloc allocator returns nil on exhaustion
  # without raising, turning any out-of-memory render into a null-pointer
  # crash and a device reboot. The patched malloc releases an emergency
  # PSRAM reserve (frameos_nim_glue.c) and retries the allocation; the
  # render loop sheds memory and re-arms the reserve afterwards.
  patchFile("stdlib", "malloc", "src/embedded/patched_malloc")

  # crunchy and zippy each build their own 8 KB slicing-by-8 CRC-32 table, and
  # the ROM has the same CRC-32. Point crunchy's at zippy's, and zippy's at
  # the ROM's.
  patchFile("crunchy", "crc32", "src/embedded/patched_crc32")
  patchFile("zippy", "crc", "src/embedded/patched_zippy_crc")

  # chroma's 148 CSS color names are a 256-slot compile-time Table, 9.1 KB;
  # the same names packed into one string are about 2 KB.
  patchFile("chroma", "names", "src/embedded/patched_chroma_names")

when defined(testing):
  # Test binaries (testament passes -d:testing) are built without C
  # optimisation. nim.cfg's -d:release means -O3, and for a test that pulls
  # in the server or the interpreter the C compile is ~30 s of CPU at -O3
  # against ~12 s at -O0, next to a 6 s Nim frontend — on a four-core CI
  # runner compiling four tests at once that was most of a cold shard. The
  # tests themselves run a little slower (the pixel-heavy ones go from
  # tens of milliseconds to under a second), the checks are the same (this
  # is still -d:release, not -d:danger), and the warm nimcache is unaffected.
  switch("opt", "none")
