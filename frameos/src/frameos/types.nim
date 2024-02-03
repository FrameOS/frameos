import json, jester, pixie
import std/locks

type
  FrameConfig* = ref object
    serverHost*: string
    serverPort*: int
    serverApiKey*: string
    frameHost*: string
    framePort*: int
    width*: int
    height*: int
    device*: string
    interval*: float
    metricsInterval*: float
    rotate*: int
    scalingMode*: string
    backgroundColor*: Color
    settings*: JsonNode
    debug*: bool

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

  NodeId* = distinct int

  FrameScene* = ref object of RootObj
    isRendering*: bool
    frameConfig*: FrameConfig
    logger*: Logger
    state*: JsonNode
    execNode*: proc(nodeId: NodeId, context: var ExecutionContext)
    dispatchEvent*: proc(event: string, payload: JsonNode)

  ExecutionContext* = ref object
    scene*: FrameScene
    image*: Image
    event*: string
    payload*: JsonNode
    parent*: ExecutionContext
    loopIndex*: int
    loopKey*: string

  StateField* = ref object
    name*: string
    label*: string
    fieldType*: string
    options*: seq[string]
    placeholder*: string
    required*: bool
    secret*: bool

  RunnerControl* = ref object
    logger*: Logger
    frameConfig*: FrameConfig
    sendEvent*: proc (event: string, data: JsonNode)
    start*: proc()

  Server* = ref object
    frameConfig*: FrameConfig
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


proc `==`*(x, y: NodeId): bool = x.int == y.int
proc `==`*(x: int, y: NodeId): bool = x == y.int
proc `==`*(x: NodeId, y: int): bool = x.int == y
proc `$`*(x: NodeId): string = $(x.int)
proc `%`*(x: NodeId): JsonNode = %(x.int)
