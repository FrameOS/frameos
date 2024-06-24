import json, jester, pixie, hashes, strformat
import std/locks

type
  FrameConfig* = ref object
    name*: string
    serverHost*: string
    serverPort*: int
    serverApiKey*: string
    frameHost*: string
    framePort*: int
    frameAccessKey*: string
    frameAccess*: string
    width*: int
    height*: int
    device*: string
    metricsInterval*: float
    rotate*: int
    scalingMode*: string
    settings*: JsonNode
    logToFile*: string
    debug*: bool

  Logger* = ref object
    frameConfig*: FrameConfig
    lock*: Lock
    thread*: Thread[FrameConfig]
    channel*: Channel[JsonNode]
    log*: proc (payload: JsonNode)
    enabled*: bool
    enable*: proc ()
    disable*: proc ()

  MetricsLogger* = ref object
    frameConfig*: FrameConfig
    logger*: Logger

  NodeId* = distinct int
  SceneId* = distinct string

  FrameScene* = ref object of RootObj
    id*: SceneId
    isRendering*: bool
    frameConfig*: FrameConfig
    logger*: Logger
    state*: JsonNode
    refreshInterval*: float
    backgroundColor*: Color
    execNode*: proc(nodeId: NodeId, context: var ExecutionContext)
    lastPublicStateUpdate*: float
    lastPersistedStateUpdate*: float

  AppRoot* = ref object of RootObj
    nodeId*: NodeId
    nodeName*: string # used mainly for logging
    scene*: FrameScene
    frameConfig*: FrameConfig

  ExportedScene* = ref object of RootObj
    publicStateFields*: seq[StateField]
    persistedStateKeys*: seq[string]
    runEvent*: proc (context: var ExecutionContext): void
    render*: proc (self: FrameScene, context: var ExecutionContext): Image
    init*: proc (sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene

  ExecutionContext* = ref object
    scene*: FrameScene
    image*: Image
    hasImage*: bool
    event*: string
    payload*: JsonNode
    parent*: ExecutionContext
    loopIndex*: int
    loopKey*: string
    nextSleep*: float

  StateField* = ref object
    name*: string
    label*: string
    fieldType*: string
    options*: seq[string]
    placeholder*: string
    required*: bool
    secret*: bool

  RunnerThread* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    scenes*: Table[SceneId, FrameScene]
    currentSceneId*: SceneId
    lastRenderAt*: float
    sleepFuture*: Option[Future[void]]
    isRendering*: bool = false
    triggerRenderNext*: bool = false

  RunnerControl* = ref object
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
proc hash*(x: SceneId): Hash = x.string.hash
proc `==`*(x, y: SceneId): bool = x.string == y.string
proc `$`*(x: SceneId): string = x.string
proc `%`*(x: SceneId): JsonNode = %*(x.string)

proc renderWidth*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.height else: config.width

proc renderHeight*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.width else: config.height

proc appName(self: AppRoot): string =
  if self.nodeName == "": $self.nodeId else: $self.nodeId & ":" & self.nodeName

proc log*(self: AppRoot, message: string) =
  self.scene.logger.log(%*{
    "event": &"log:{appName(self)}",
    "message": message
  })

proc log*(self: AppRoot, message: JsonNode) =
  if message.kind == JObject:
    # Note: this modifies the original object!
    message["event"] = %*("log:" & appName(self) & (if message.hasKey("event"): ":" & message["event"].getStr() else: ""))
    self.scene.logger.log(message)
  else:
    self.log($message)

proc logError*(self: AppRoot, message: string) =
  self.scene.logger.log(%*{
    "event": &"error:{appName(self)}",
    "error": message
  })
