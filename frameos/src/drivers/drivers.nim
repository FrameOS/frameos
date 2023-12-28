import pixie
# import inky/inky as inkyDriver
import framebuffer/framebuffer as framebufferDriver

from frameos/types import FrameOS

proc init*(frameOS: FrameOS) =
  # inkyDriver.init(frameOS)
  framebufferDriver.init(frameOS)

proc render*(frameOS: FrameOS, image: Image) =
  # inkyDriver.render(frameOS, image)
  framebufferDriver.render(frameOS, image)
