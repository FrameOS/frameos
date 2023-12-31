import pixie, osproc

from frameos/types import FrameOS, Logger, FrameOSDriver

import drivers/frameBuffer/frameBuffer as frameBuffer

type Driver* = frameBuffer.Driver

proc init*(frameOS: FrameOS): Driver =
  result = frameBuffer.init(frameOS)

proc render*(self: Driver, image: Image) =
  frameBuffer.render(self, image)

proc turnOn*(self: Driver) =
  discard execCmd("cd ./vendor/inkyHyperPixel2r && ./env/bin/python3 turnOn.py")

proc turnOff*(self: Driver) =
  discard execCmd("cd ./vendor/inkyHyperPixel2r && ./env/bin/python3 turnOff.py")
