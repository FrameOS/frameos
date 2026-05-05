import asyncdispatch
import std/os
import std/segfaults
from ./frameos/frameos import startFrameOS, describeFatalStartupError
from ./frameos/setup import setupFrameOS

when isMainModule:
  try:
    let args = commandLineParams()
    if args.len > 0 and args[0] == "check":
      echo "FrameOS check: passed 🎉"
    elif args.len > 0 and args[0] == "setup":
      if args.len > 1:
        raise newException(ValueError, "FrameOS setup does not accept driver names; it uses this build's generated driver registry")
      let setupResult = setupFrameOS()
      if setupResult.rebootRequired:
        quit(2)
    else:
      waitFor startFrameOS() # blocks forever
  except CatchableError as e:
    let fatalError = describeFatalStartupError(e)
    stderr.writeLine(fatalError.message)
    if fatalError.showStackTrace:
      stderr.writeLine(e.getStackTrace())
    quit(1)
