import asyncdispatch
import std/json
import std/os
import std/segfaults
import std/strutils
from ./frameos/frameos import startFrameOS, describeFatalStartupError
from ./frameos/setup import setupFrameOS

proc versionFromJsonFile(path: string): string =
  try:
    if fileExists(path):
      let data = parseFile(path)
      for key in ["frameosVersion", "frameos_version", "frameos"]:
        let version = data{key}.getStr("")
        if version.len > 0:
          return version
  except CatchableError:
    discard
  return ""

proc frameOSVersion(): string =
  for path in [getEnv("FRAMEOS_CONFIG"), "./frame.json", "../versions.json", "versions.json"]:
    if path.len == 0:
      continue
    let version = versionFromJsonFile(path)
    if version.len > 0:
      return version
  return "unknown"

proc printHelp() =
  echo "FrameOS version: " & frameOSVersion()
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
