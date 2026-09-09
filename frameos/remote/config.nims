# begin Nimble config (version 2)
--noNimblePath
when withDir(thisDir(), system.fileExists("nimble.paths")):
  include "nimble.paths"
# end Nimble config

import std/os

# The Remote spawns its `shell` children through the runtime's process
# wrapper (frameos/utils/process.nim) instead of raw osproc, so the runtime
# tree's src/ goes on the path. A repo checkout and bin/cross both keep
# remote/ next to src/; the backend's source deploy copies remote/ alone and
# stages that one module under ../src itself (deploy_remote.py,
# REMOTE_RUNTIME_MODULES). Conditional so `nimble setup` on a bare
# dependency-only copy (the Dockerfile) still works; a real build without it
# fails on the import with a clear "cannot open file".
let frameosRuntimeSrc = thisDir() / ".." / "src"
if dirExists(frameosRuntimeSrc / "frameos" / "utils"):
  switch("path", frameosRuntimeSrc)
