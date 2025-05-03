import json, jester, pixie, hashes, locks

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
    assetsPath*: string
    saveAssets*: JsonNode
    logToFile*: string
    debug*: bool
    timeZone*: string
    schedule*: FrameSchedule
    gpioButtons*: seq[GPIOButton]
    controlCode*: ControlCode
    network*: NetworkConfig

  GPIOButton* = ref object
    pin*: int
    label*: string

  ControlCode* = ref object
    enabled*: bool
    position*: string
    size*: float
    padding*: int
    offsetX*: int
    offsetY*: int
    qrCodeColor*: Color
    backgroundColor*: Color

  NetworkConfig* = ref object
    networkCheck*: bool
    networkCheckTimeoutSeconds*: float
    networkCheckUrl*: string
    wifiHotspot*: string
    wifiHotspotSsid*: string
    wifiHotspotPassword*: string
    wifiHostpotTimeoutSeconds*: float

  FrameSchedule* = ref object
    events*: seq[ScheduledEvent]

  ScheduledEvent* = ref object
    id*: string
    minute*: int  # must be set 0-59
    hour*: int    # must be set 0-23
    weekday*: int # 0 for every day, 1-7 mon-sun, 8 for every weekday, 9 for every weekend
    event*: string
    payload*: JsonNode

  Logger* = ref object
    frameConfig*: FrameConfig
    lock*: Lock
    thread*: Thread[FrameConfig]
    channel*: Channel[(float, JsonNode)]
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

  FontStyle* = ref object
    typeface*: Typeface
    name*: string
    size*: float
    color*: Color
    underline*: bool
    strikethrough*: bool
    borderColor*: Color
    borderWidth*: int

  AppRoot* = ref object of RootObj
    nodeId*: NodeId
    nodeName*: string # used mainly for logging and saving assets
    scene*: FrameScene
    frameConfig*: FrameConfig

  ExportedScene* = ref object of RootObj
    publicStateFields*: seq[StateField]
    persistedStateKeys*: seq[string]
    runEvent*: proc (self: FrameScene, context: var ExecutionContext): void
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
    controlCodeRender*: AppRoot
    controlCodeData*: AppRoot

  RunnerControl* = ref object
    start*: proc(firstSceneId: Option[SceneId])

  Server* = ref object
    frameConfig*: FrameConfig
    jester*: Jester
    runner*: RunnerControl
    url*: string

  FrameOSDriver* = ref object of RootObj
    name*: string

  Scheduler* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    schedule*: FrameSchedule

  NetworkStatus* = enum
    idle, connecting, connected, hotspot, timeout, error

  Network* = ref object
    status*: NetworkStatus
    hotspotStartedAt*: float

  FrameOS* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    metricsLogger*: MetricsLogger
    server*: Server
    runner*: RunnerControl
    network*: Network

proc `==`*(x, y: NodeId): bool = x.int == y.int
proc `==`*(x: int, y: NodeId): bool = x == y.int
proc `==`*(x: NodeId, y: int): bool = x.int == y
proc `$`*(x: NodeId): string = $(x.int)
proc `%`*(x: NodeId): JsonNode = %(x.int)
proc hash*(x: SceneId): Hash = x.string.hash
proc `==`*(x, y: SceneId): bool = x.string == y.string
proc `$`*(x: SceneId): string = x.string
proc `%`*(x: SceneId): JsonNode = %*(x.string)
