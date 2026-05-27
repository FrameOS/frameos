import asyncdispatch
import std/os
import std/segfaults
import std/strutils
from ./frameos/frameos import startFrameOS, describeFatalStartupError
from ./frameos/setup import setupFrameOS

const frameosVersion {.strdefine.}: string = "unknown"

proc compiledFrameOSVersion(): string =
  result = frameosVersion.strip()
  if result.len == 0:
    result = "unknown"

proc printHelp() =
  echo "FrameOS version: " & compiledFrameOSVersion()
  echo ""
  echo "Available commands:"
  echo "  start   Start FrameOS (default)"
  echo "  check   Verify the binary can start"
  echo "  setup   Run device setup for this build"
  echo "  help    Show this help"

when isMainModule:
  try:
    let args = commandLineParams()
    if args.len > 0 and args[0] == "check":
      echo "FrameOS check: passed 🎉"
    elif args.len > 0 and args[0] in ["help", "--help", "-h"]:
      printHelp()
    elif args.len > 0 and args[0] == "setup":
      if args.len > 1:
        raise newException(ValueError, "FrameOS setup does not accept driver names; it uses this build's generated driver registry")
      let setupResult = setupFrameOS()
      if setupResult.rebootRequired:
        quit(2)
      quit(0)
    elif args.len == 0 or args[0] == "start" or args[0].startsWith("--"):
      waitFor startFrameOS() # blocks forever
    else:
      printHelp()
      raise newException(ValueError, "Unknown FrameOS command: " & args[0])
  except CatchableError as e:
    let fatalError = describeFatalStartupError(e)
    stderr.writeLine(fatalError.message)
    if fatalError.showStackTrace:
      stderr.writeLine(e.getStackTrace())
    quit(1)
