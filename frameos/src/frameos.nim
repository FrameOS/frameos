import asyncdispatch
import std/os
import std/segfaults
from ./frameos/frameos import startFrameOS, describeFatalStartupError
from ./frameos/device_init import runInitCommand, initUsage

when isMainModule:
  try:
    let args = commandLineParams()
    if args.len > 0 and args[0] == "check":
      echo "FrameOS check: passed 🎉"
    elif args.len > 0 and args[0] == "init":
      runInitCommand(args[1 .. ^1])
    elif args.len > 0 and (args[0] == "--help" or args[0] == "-h"):
      echo "Usage: frameos [check|init]"
      echo initUsage()
    else:
      waitFor startFrameOS() # blocks forever
  except CatchableError as e:
    let fatalError = describeFatalStartupError(e)
    stderr.writeLine(fatalError.message)
    if fatalError.showStackTrace:
      stderr.writeLine(e.getStackTrace())
    quit(1)
