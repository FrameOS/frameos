import asyncdispatch
import std/os
import std/options
import std/segfaults
import std/strutils
import std/times
from ./frameos/boot_guard import clearBootCrashCount, updateBootGuardFailureDetails, BOOT_GUARD_FALLBACK_SCENE_ID
from ./frameos/frameos import startFrameOS, describeFatalStartupError, fatalStartupRetryAction,
  loadFatalErrorBehavior, renderFatalStartupError
from ./frameos/setup import setupFrameOS, setupFrameOSDrivers, scheduleSetupRebootIfRequired,
  startFrameOSSystemdServices, writeSetupReleasePayload
from ./frameos/upgrade import runFrameOSUpgrade, parseFrameOSUpgradeOptions
from ./frameos/version import compiledFrameOSVersion

proc printHelp() =
  echo "FrameOS version: " & compiledFrameOSVersion()
  echo ""
  echo "Available commands:"
  echo "  start   Start FrameOS (default)"
  echo "  check   Verify the binary can start"
  echo "  setup   Run device setup for this build"
  echo "         --with-setup=/boot/frameos-setup.json[.gz] to install from first-boot setup JSON"
  echo "         --reboot-if-required to let setup reboot after changes that require it"
  echo "  driver-setup"
  echo "          Run display driver setup for the current frame.json"
  echo "          --reboot-if-required to let setup reboot after changes that require it"
  echo "  upgrade Upgrade this installed frame to the latest GitHub release"
  echo "          --dry-run to validate and print the upgrade plan without changing files"
  echo "  help    Show this help"

when isMainModule:
  try:
    let args = commandLineParams()
    if args.len > 0 and args[0] == "check":
      echo "FrameOS check: passed 🎉"
    elif args.len > 0 and args[0] in ["help", "--help", "-h"]:
      printHelp()
    elif args.len > 0 and args[0] == "setup":
      var setupFromFile = ""
      var activateServices = false
      var rebootIfRequired = false
      var i = 1
      while i < args.len:
        let arg = args[i]
        if arg.startsWith("--with-setup="):
          setupFromFile = arg["--with-setup=".len .. ^1]
          activateServices = true
        elif arg == "--with-setup":
          if i + 1 >= args.len:
            raise newException(ValueError, "FrameOS setup --with-setup requires a path")
          setupFromFile = args[i + 1]
          activateServices = true
          i += 1
        elif arg == "--reboot-if-required":
          rebootIfRequired = true
        else:
          raise newException(ValueError, "FrameOS setup only accepts --with-setup and --reboot-if-required")
        i += 1
      let setupResult = setupFrameOS(setupFromFile)
      if setupFromFile.len > 0:
        writeSetupReleasePayload(setupFromFile)
      if setupResult.rebootRequired:
        if rebootIfRequired:
          discard scheduleSetupRebootIfRequired(setupResult, "FrameOS setup")
          quit(0)
        quit(2)
      if activateServices:
        startFrameOSSystemdServices(setupFromFile)
      quit(0)
    elif args.len > 0 and args[0] == "driver-setup":
      var rebootIfRequired = false
      if args.len > 1:
        for arg in args[1 .. ^1]:
          if arg == "--reboot-if-required":
            rebootIfRequired = true
          else:
            raise newException(ValueError, "FrameOS driver-setup only accepts --reboot-if-required")
      let setupResult = setupFrameOSDrivers()
      if setupResult.rebootRequired:
        if rebootIfRequired:
          discard scheduleSetupRebootIfRequired(setupResult, "FrameOS driver setup")
          quit(0)
        quit(2)
      quit(0)
    elif args.len > 0 and args[0] == "upgrade":
      let upgradeArgs = if args.len > 1: args[1 .. ^1] else: @[]
      quit(runFrameOSUpgrade(parseFrameOSUpgradeOptions(upgradeArgs)))
    elif args.len == 0 or args[0] == "start" or args[0].startsWith("--"):
      var firstFatalFailureAt = 0.0
      while true:
        try:
          waitFor startFrameOS() # blocks forever
          break
        except CatchableError as e:
          let fatalError = describeFatalStartupError(e)
          stderr.writeLine(fatalError.message)
          if fatalError.showStackTrace:
            stderr.writeLine(e.getStackTrace())

          if firstFatalFailureAt <= 0:
            firstFatalFailureAt = epochTime()
          let action = fatalStartupRetryAction(loadFatalErrorBehavior(), firstFatalFailureAt, epochTime())

          if action.quitProcess:
            updateBootGuardFailureDetails(
              some(BOOT_GUARD_FALLBACK_SCENE_ID),
              some("Boot Guard"),
              some(fatalError.message),
            )
            quit(1)

          clearBootCrashCount()
          if action.showError:
            renderFatalStartupError(fatalError)
          stderr.writeLine("FrameOS fatal: retrying in " & $action.retrySeconds.int & " seconds")
          sleep(max(1, action.retrySeconds.int) * 1000)
    else:
      printHelp()
      raise newException(ValueError, "Unknown FrameOS command: " & args[0])
  except CatchableError as e:
    let fatalError = describeFatalStartupError(e)
    stderr.writeLine(fatalError.message)
    if fatalError.showStackTrace:
      stderr.writeLine(e.getStackTrace())
    quit(1)
