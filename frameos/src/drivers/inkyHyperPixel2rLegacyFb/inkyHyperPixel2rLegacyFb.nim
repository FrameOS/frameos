import pixie
import frameos/driver_context
import frameos/device_setup
import frameos/utils/process

import drivers/frameBuffer/frameBuffer as frameBuffer

const TURN_ON_OFF_TIMEOUT_MS = 60 * 1000

type Driver* = ref object of frameBuffer.Driver
  mode*: string

type ExecCmdProc* = proc(command: string): int {.nimcall.}

var execCmdHook*: ExecCmdProc

proc runCommand(command: string): int =
  if not execCmdHook.isNil:
    return execCmdHook(command)
  runShellWithParentStreams(command, timeoutMs = TURN_ON_OFF_TIMEOUT_MS).exitCode

proc init*(frameOS: DriverContext): Driver =
  let fbDriver = frameBuffer.init(frameOS)
  result = Driver(
    name: "inkyHyperPixel2rLegacyFb",
    screenInfo: fbDriver.screenInfo,
    logger: fbDriver.logger,
    mode: frameOS.frameConfig.mode,
  )

proc setup*(frameOS: DriverContext = nil): SetupResult =
  discard frameOS
  setupPythonVendor("inkyHyperPixel2r")
  result = setupOk()

proc render*(self: Driver, image: Image) =
  frameBuffer.render(self, image)

proc turnOn*(self: Driver) =
  discard runCommand("cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOn.py")

proc turnOff*(self: Driver) =
  discard runCommand("cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOff.py")
