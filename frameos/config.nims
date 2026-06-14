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
