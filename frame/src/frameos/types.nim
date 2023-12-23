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
  FrameScene* = ref object of RootObj
    config*: Config

type
  Renderer* = ref object
    config*: Config
    logger*: Logger
    scene*: FrameScene

type
  Server* = ref object
    config*: Config
    logger*: Logger
    jester*: Jester
    renderer*: Renderer
    url*: string

type
  FrameOS* = ref object
    config*: Config
    logger*: Logger
    server*: Server
    renderer*: Renderer
