import json

type
  Config* = object
    serverHost*: string
    serverPort*: int
    serverApiKey*: string
    framePort*: int
    width*: int
    height*: int
    device*: string
    color*: string
    interval*: int
    metricsInterval*: int
    rotate*: int
    scalingMode*: string
    backgroundColor*: string
    settings*: JsonNode

proc loadConfig(filename: string = "frame.json"): Config =
  let data = parseFile(filename)
  result = Config(
    serverHost: data{"server_host"}.getStr(),
    serverPort: data{"server_port"}.getInt(),
    serverApiKey: data{"server_api_key"}.getStr(),
    framePort: data{"frame_port"}.getInt(8787),
    width: data{"width"}.getInt(1920),
    height: data{"height"}.getInt(1080),
    device: data{"device"}.getStr("web_only"),
    color: data{"color"}.getStr("black"),
    interval: data{"interval"}.getInt(300),
    metricsInterval: data{"metrics_interval"}.getInt(60),
    rotate: data{"rotate"}.getInt(0),
    scalingMode: data{"scaling_mode"}.getStr("cover"),
    backgroundColor: data{"background_color"}.getStr("white"),
    settings: data{"settings"},
  )

export loadConfig, Config
