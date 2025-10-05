import json, jester, pixie, hashes, locks
import lib/burrito

type
  # Parsed config.json
  FrameConfig* = ref object
    name*: string
    mode*: string
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
    deviceConfig*: DeviceConfig
    metricsInterval*: float
    rotate*: int
    flip*: string
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
    agent*: AgentConfig
    palette*: PaletteConfig

  # Part of FrameConfig
  GPIOButton* = ref object
    pin*: int
    label*: string

  # Part of FrameConfig
  ControlCode* = ref object
    enabled*: bool
    position*: string
    size*: float
    padding*: int
    offsetX*: int
    offsetY*: int
    qrCodeColor*: Color
    backgroundColor*: Color

  # Part of FrameConfig
  NetworkConfig* = ref object
    networkCheck*: bool
    networkCheckTimeoutSeconds*: float
    networkCheckUrl*: string
    wifiHotspot*: string
    wifiHotspotSsid*: string
    wifiHotspotPassword*: string
    wifiHotspotTimeoutSeconds*: float

  # Part of FrameConfig
  AgentConfig* = ref object
    agentEnabled*: bool
    agentRunCommands*: bool
    agentSharedSecret*: string

  # Part of FrameConfig
  PaletteConfig* = ref object
    colors*: seq[(int, int, int)]

  # Part of FrameConfig
  FrameSchedule* = ref object
    events*: seq[ScheduledEvent]

  # Part of FrameConfig/FrameSchedule
  ScheduledEvent* = ref object
    id*: string
    minute*: int  # must be set 0-59
    hour*: int    # must be set 0-23
    weekday*: int # 0 for every day, 1-7 mon-sun, 8 for every weekday, 9 for every weekend
    event*: string
    payload*: JsonNode

  # Part of FrameConfig
  DeviceConfig* = ref object
    vcom*: float # used for the 10.3" display

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

  FieldKind* = enum
    fkString, fkText, fkFloat, fkInteger, fkBoolean, fkColor, fkJson, fkImage, fkNode, fkScene, fkNone

  ## A compact tagged union for interpreter values.
  Value* = object
    case kind*: FieldKind
    of fkString, fkText:
      s*: string    ## same storage, different semantics via kind
    of fkFloat:
      f*: float64
    of fkInteger:
      i*: int64
    of fkBoolean:
      b*: bool
    of fkColor:
      col*: Color
    of fkJson:
      j*: JsonNode  ## std/json node (ref object)
    of fkImage:
      img*: Image   ## pixie image (ref object)
    of fkNode:
      nId*: NodeId  ## custom node type (ref object)
    of fkScene:
      sId*: SceneId ## custom scene type (ref object)
    of fkNone:
      discard

  # Runtime state while running the scene (for compiled frames)
  FrameScene* = ref object of RootObj
    id*: SceneId
    isRendering*: bool
    frameConfig*: FrameConfig
    logger*: Logger
    state*: JsonNode
    refreshInterval*: float
    backgroundColor*: Color
    execNode*: proc(nodeId: NodeId, context: ExecutionContext)
    getDataNode*: proc(nodeId: NodeId, context: ExecutionContext): Value
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

  AppExport* = ref object of RootObj
    init*: proc (params: Table[string, Value]): AppRoot
    run*: proc (self: AppRoot, context: ExecutionContext): void
    get*: proc (self: AppRoot, key: string): Value

  # Exported data/functions for compiled scenes
  ExportedScene* = ref object of RootObj
    publicStateFields*: seq[StateField]
    persistedStateKeys*: seq[string]
    runEvent*: proc (self: FrameScene, context: ExecutionContext): void
    render*: proc (self: FrameScene, context: ExecutionContext): Image
    init*: proc (sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene

  # Exported data/functions for interpreted scenes, adds some local state that's normally compiled into the scene
  ExportedInterpretedScene* = ref object of ExportedScene
    backgroundColor*: Color
    refreshInterval*: float
    nodes*: seq[DiagramNode]
    edges*: seq[DiagramEdge]
    # TODO: add private state fields

  # Imported node from scenes.json
  DiagramNode* = ref object of RootObj
    id*: NodeId
    data*: JsonNode
    nodeType*: string

  # Imported edge from scenes.json
  DiagramEdge* = ref object of RootObj
    id*: NodeId
    source*: NodeId
    sourceHandle*: string
    target*: NodeId
    targetHandle*: string
    data*: JsonNode
    edgeType*: string

  # Imported settings from scenes.json
  FrameSceneSettings* = ref object
    backgroundColor*: Color
    refreshInterval*: float

  # Imported scene from scenes.json
  FrameSceneInput* = ref object of RootObj
    id*: SceneId
    name*: string
    nodes*: seq[DiagramNode]
    edges*: seq[DiagramEdge]
    fields*: seq[StateField]
    settings*: FrameSceneSettings

  # Runtime state while running the scene (for interpreted frames), adds cached nodes/edges
  InterpretedFrameScene* = ref object of FrameScene
    nodes*: Table[NodeId, DiagramNode]
    edges*: seq[DiagramEdge]
    nextNodeIds*: Table[NodeId, NodeId] # mapping from current node id to next node id for quick lookup
    eventListeners*: Table[string, seq[NodeId]] # mapping from event name to list of node ids that listen to that event
    appsByNodeId*: Table[NodeId, AppRoot] # mapping from node id to instantiated app for quick lookup
    appInputsForNodeId*: Table[NodeId, Table[string, NodeId]] # mapping from node id to app input name to connected node id
    appInlineInputsForNodeId*: Table[NodeId, Table[string, string]]            # mapping from node id to app input name to inline code
    codeInputsForNodeId*: Table[NodeId, Table[string, NodeId]] # mapping from code node id to code arg name to connected node id
    codeInlineInputsForNodeId*: Table[NodeId, Table[string, string]] # mapping from code node id to code arg name to inline code
    sceneNodes*: Table[NodeId, FrameScene]                                     # cache of instantiated child scenes
    sceneExportByNodeId*: Table[NodeId, ExportedScene]                         # exported metadata for cached child scenes
    publicStateFields*: seq[StateField]
    js*: QuickJS
    jsReady*: bool
    jsFuncNameByNode*: Table[NodeId, string]                                   # code-node -> function name
    codeInlineFuncNameByNodeArg*: Table[NodeId, Table[string, string]]         # code-node arg -> function name
    appInlineFuncNameByNodeArg*: Table[NodeId, Table[string, string]]          # app/scene field inline -> function name
    cacheValues*: Table[NodeId, Value]
    cacheTimes*: Table[NodeId, float]
    cacheKeys*: Table[NodeId, JsonNode]

  # Context passed around during execution of a node/event in a scene
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

  # State field definitions. Used in interpreted scenes, and to show the right form to the user
  StateField* = ref object
    name*: string
    label*: string
    fieldType*: string
    value*: string
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
    idle, connecting, connected, timeout, error

  HotspotStatus* = enum
    disabled, enabled, starting, stopping, error

  Network* = ref object
    status*: NetworkStatus
    hotspotStatus*: HotspotStatus
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
