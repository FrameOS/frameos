import pixie, json, osproc

from frameos/types import FrameOS, Logger, FrameOSDriver

import drivers/frameBuffer/frameBuffer as frameBuffer

type Driver* = frameBuffer.Driver

proc init*(frameOS: FrameOS): Driver =
  result = frameBuffer.init(frameOS)

proc render*(self: Driver, image: Image) =
  frameBuffer.render(self, image)

proc turnOn*(self: Driver) =
  discard startProcess(workingDir = "./vendor/inkyHyperPixel2r",
      command = "./env/bin/python3", args = ["turnOn.py"], options = {poStdErrToStdOut})


proc turnOff*(self: Driver) =
  discard startProcess(workingDir = "./vendor/inkyHyperPixel2r",
      command = "./env/bin/python3", args = ["turnOff.py"], options = {poStdErrToStdOut})
