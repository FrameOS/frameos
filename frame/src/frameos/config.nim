import json
from frameos/types import Config

proc setConfigDefaults*(config: var Config) =
  if config.serverPort == 0: config.serverPort = 8989
  if config.width == 0: config.width = 1920
  if config.height == 0: config.height = 1080
  if config.device == "": config.device = "web_only"
  if config.color == "": config.color = "black"
  if config.interval == 0: config.interval = 300
  if config.metricsInterval == 0: config.metricsInterval = 60
  if config.rotate == 0: config.rotate = 0
  if config.scalingMode == "": config.scalingMode = "cover"
  if config.backgroundColor == "": config.backgroundColor = "white"
  if config.framePort == 0: config.framePort = 8787

proc loadConfig*(filename: string = "frame.json"): Config =
  let data = parseFile(filename)
  result = Config(
    serverHost: data{"server_host"}.getStr(),
    serverPort: data{"server_port"}.getInt(),
    serverApiKey: data{"server_api_key"}.getStr(),
    framePort: data{"frame_port"}.getInt(),
    width: data{"width"}.getInt(),
    height: data{"height"}.getInt(),
    device: data{"device"}.getStr(),
    color: data{"color"}.getStr(),
    interval: data{"interval"}.getInt(),
    metricsInterval: data{"metrics_interval"}.getInt(),
    rotate: data{"rotate"}.getInt(),
    scalingMode: data{"scaling_mode"}.getStr(),
    backgroundColor: data{"background_color"}.getStr(),
    settings: data{"settings"},
  )
  setConfigDefaults(result)
