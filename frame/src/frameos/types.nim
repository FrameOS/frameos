import httpclient, json, jester, pixie

type
  FrameConfig* = ref object
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

  Logger* = ref object
    frameConfig*: FrameConfig
    client*: HttpClient
    url*: string

  FrameScene* = ref object of RootObj
    frameOS*: FrameOS
    frameConfig*: FrameConfig
    logger*: Logger

  ExecutionContext* = ref object
    scene*: FrameScene
    image*: Image
    event*: string
    eventPayload*: JsonNode
    parent*: ExecutionContext

  Renderer* = ref object
    frameOS*: FrameOS
    frameConfig*: FrameConfig
    logger*: Logger
    scene*: FrameScene

  Server* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    jester*: Jester
    renderer*: Renderer
    url*: string

  FrameOS* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    server*: Server
    renderer*: Renderer
