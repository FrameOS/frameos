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
    log*: proc(payload: JsonNode)
    enabled*: bool
    enable*: proc()
    disable*: proc()

  MetricsLogger* = ref object
    frameConfig*: FrameConfig
    logger*: Logger

  FrameScene* = ref object of RootObj
    isRendering*: bool
    frameConfig*: FrameConfig
    logger*: Logger
    state*: JsonNode
    execNode*: proc(nodeId: string, context: var ExecutionContext)
    dispatchEvent*: proc(event: string, payload: JsonNode)

  ExecutionContext* = ref object
    scene*: FrameScene
    image*: Image
    event*: string
    payload*: JsonNode
    parent*: ExecutionContext
    loopIndex*: int
    loopKey*: string

  RunnerControl* = ref object
    logger*: Logger
    frameConfig*: FrameConfig
    sendEvent*: proc (event: string, data: JsonNode)
    start*: proc()

  Server* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    jester*: Jester
    runner*: RunnerControl
    url*: string

  FrameOSDriver* = ref object of RootObj
    name*: string

  FrameOS* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    metricsLogger*: MetricsLogger
    server*: Server
    runner*: RunnerControl
