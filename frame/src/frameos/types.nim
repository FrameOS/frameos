import httpclient, json, jester

type
  Config* = ref object
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

type
  Logger* = ref object
    config*: Config
    client*: HttpClient
    url*: string

type
  Server* = ref object
    config*: Config
    logger*: Logger
    jester*: Jester
    url*: string

type
  FrameOS* = ref object
    config*: Config
    logger*: Logger
    server*: Server
