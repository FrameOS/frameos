import pixie
import scenes/default as defaultScene

from frameos/config import Config

proc render*(config: Config): Image =
  let scene = defaultScene.init(config)
  result = scene.render()
