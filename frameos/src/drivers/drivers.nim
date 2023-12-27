import pixie
import inky/inky as inkyDriver

from frameos/types import FrameOS

proc init*(frameOS: FrameOS) =
  inkyDriver.init(frameOS)

proc render*(frameOS: FrameOS, image: Image) =
  inkyDriver.render(frameOS, image)
