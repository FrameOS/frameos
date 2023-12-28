import json, jester, pixie
import std/locks

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
    interval*: float
    metricsInterval*: float
    rotate*: int
    scalingMode*: string
    backgroundColor*: string
    settings*: JsonNode

  Logger* = ref object
    frameConfig*: FrameConfig
    lock*: Lock
    thread*: Thread[FrameConfig]
    channel*: Channel[JsonNode]
    # client*: HttpClient
    # url*: string

  FrameScene* = ref object of RootObj
    frameOS*: FrameOS
    frameConfig*: FrameConfig
    logger*: Logger
    state*: JsonNode

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
    lastImage*: Option[Image]
    lastRenderAt*: float
    sleepFuture*: Option[Future[void]]

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
