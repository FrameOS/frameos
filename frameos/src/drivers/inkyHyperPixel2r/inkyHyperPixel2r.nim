import pixie, osproc
import frameos/types

import drivers/frameBuffer/frameBuffer as frameBuffer

type Driver* = ref object of frameBuffer.Driver
  mode*: string

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
  if self.mode == "nixos":
    discard execCmd("inkyHyperPixel2r-turnOn")
  else:
    discard execCmd("cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOn.py")

proc turnOff*(self: Driver) =
  if self.mode == "nixos":
    discard execCmd("inkyHyperPixel2r-turnOff")
  else:
    discard execCmd("cd /srv/frameos/vendor/inkyHyperPixel2r && ./env/bin/python3 turnOff.py")
