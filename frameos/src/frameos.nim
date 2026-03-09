import asyncdispatch
import std/os
import std/segfaults
from ./frameos/frameos import startFrameOS

when isMainModule:
  try:
    let args = commandLineParams()
    if args.len > 0 and args[0] == "check":
      echo "FrameOS check: passed 🎉"
    else:
      waitFor startFrameOS() # blocks forever
  except CatchableError as e:
    stderr.writeLine("FrameOS fatal: " & e.msg)
    stderr.writeLine(e.getStackTrace())
    quit(1)
