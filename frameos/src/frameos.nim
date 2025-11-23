import asyncdispatch
import std/os
import std/segfaults
from ./frameos/frameos import startFrameOS

when isMainModule:
  let args = commandLineParams()
  if args.len > 0 and args[0] == "check":
    echo "FrameOS check: passed 🎉"
  else:
    waitFor startFrameOS() # blocks forever
