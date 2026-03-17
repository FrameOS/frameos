import pixie, osproc
import frameos/types

import drivers/frameBuffer/frameBuffer as frameBuffer

type Driver* = ref object of frameBuffer.Driver
  mode*: string

type ExecCmdProc* = proc(command: string): int {.nimcall.}

var execCmdHook*: ExecCmdProc

proc runCommand(command: string): int =
  if not execCmdHook.isNil:
    return execCmdHook(command)
  execCmd(command)

proc deviceInit*(frameConfig: FrameConfig): DriverInitSpec =
  if frameConfig.isNil or frameConfig.device != "pimoroni.hyperpixel2r":
    return nil

  DriverInitSpec(
    ensureAptPackages: @["python3-dev", "python3-pip", "python3-venv"],
    pythonVendorFolders: @["inkyHyperPixel2r"],
    spiMode: dismUnchanged,
  )

proc init*(frameOS: FrameOS): Driver =
  let fbDriver = frameBuffer.init(frameOS)
  result = Driver(
    screenInfo: fbDriver.screenInfo,
    logger: fbDriver.logger,
    mode: frameOS.frameConfig.mode,
  )

proc render*(self: Driver, image: Image) =
  frameBuffer.render(self, image)

proc turnOn*(self: Driver) =
  discard runCommand("cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOn.py")

proc turnOff*(self: Driver) =
  discard runCommand("cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOff.py")
