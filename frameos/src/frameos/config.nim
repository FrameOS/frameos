import json, pixie, os
import frameos/types

proc setConfigDefaults*(config: var FrameConfig) =
  if config.serverPort == 0: config.serverPort = 8989
  if config.width == 0: config.width = 1920
  if config.height == 0: config.height = 1080
  if config.device == "": config.device = "web_only"
  if config.interval == 0: config.interval = 300
  if config.metricsInterval == 0: config.metricsInterval = 60
  if config.rotate == 0: config.rotate = 0
  if config.scalingMode == "": config.scalingMode = "cover"
  if config.framePort == 0: config.framePort = 8787

proc loadConfig*(filename: string = "frame.json"): FrameConfig =
  let data = parseFile(filename)
  result = FrameConfig(
    serverHost: data{"serverHost"}.getStr(),
    serverPort: data{"serverPort"}.getInt(),
    serverApiKey: data{"serverApiKey"}.getStr(),
    framePort: data{"framePort"}.getInt(),
    width: data{"width"}.getInt(),
    height: data{"height"}.getInt(),
    device: data{"device"}.getStr(),
    backgroundColor: parseHtmlColor(if data{"backgroundColor"}.getStr() !=
        "": data{"backgroundColor"}.getStr() else: "black"),
    interval: data{"interval"}.getFloat(),
    metricsInterval: data{"metricsInterval"}.getFloat(),
    rotate: data{"rotate"}.getInt(),
    scalingMode: data{"scalingMode"}.getStr(),
    settings: data{"settings"},
    verbose: commandLineParams().contains("--verbose")
  )
  setConfigDefaults(result)
