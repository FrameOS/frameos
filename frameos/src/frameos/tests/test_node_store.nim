import std/[json, os, tables]
import pixie
import ../interpreter
import ../types
import ../values
import ../node_store

# The node cache's stale fallback and the node store (frameos/node_store.nim):
# a failed refresh serves the stored value while it is young enough and for
# the same inputs; cached values and `frameos.remember` values outlive the
# scene instance on storage, guarded by what produced them.

const ScratchDir = "tmp/node-store-tests"
removeDir(ScratchDir)
createDir(ScratchDir)
nodeStoreDirOverride = ScratchDir

proc testConfig(): FrameConfig =
  FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false)

var events: seq[JsonNode] = @[]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    events.add(payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, edgeType: "")

proc ctx(scene: FrameScene): ExecutionContext =
  ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0)

proc sources(outputType, code: string): JsonNode =
  %*{
    "config.json": $(%*{
      "name": "Test app",
      "category": "data",
      "fields": [{"name": "city", "type": "string", "value": ""}],
      "output": [{"name": "value", "type": outputType}]
    }),
    "app.ts": code
  }

# A forecast: JSON for the city it is given, failing whenever `fail` is set.
let forecastApp = sources("json", """
export function get(app: FrameOSApp) {
  if (app.state.fail) throw new Error('offline')
  return { city: app.config.city, tick: app.state.tick }
}
""")
let textApp = sources("text", """
export function get(app: FrameOSApp) {
  if (app.state.fail) throw new Error('offline')
  return `tick=${app.state.tick}`
}
""")
proc counterApp(step: int): JsonNode =
  sources("text", "export function get() {\n  const n = (frameos.recall('n') ?? 0) + " & $step &
    "\n  frameos.remember('n', n)\n  return `n=${n}`\n}\n")

let sceneId = "tests/node-store".SceneId

proc cache(stale: bool, duration = 60): JsonNode =
  result = %*{"enabled": true, "inputEnabled": true, "durationEnabled": true,
    "duration": $duration}
  if stale:
    result["staleEnabled"] = %true
    result["staleDuration"] = %"3600"

proc install(forecastDuration = 60, counterStep = 1) =
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = ExportedInterpretedScene(
    name: "Node store test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 1.0,
    publicStateFields: @[
      StateField(name: "tick", fieldType: "integer", value: %*"1"),
      StateField(name: "fail", fieldType: "boolean", value: %*"false"),
      StateField(name: "city", fieldType: "string", value: %*"Brussels")
    ],
    nodes: @[
      node(10, "state", %*{"keyword": "city"}),
      node(1, "app", %*{"keyword": "forecast", "config": {}, "sources": forecastApp,
        "cache": cache(true, forecastDuration)}),
      node(2, "app", %*{"keyword": "plain", "config": {}, "sources": textApp,
        "cache": cache(false)}),
      node(3, "app", %*{"keyword": "counter", "config": {}, "sources": counterApp(counterStep)})
    ],
    edges: @[
      edge(100, 10, "fieldOutput", 1, "fieldInput/city"),
      edge(101, 10, "fieldOutput", 2, "fieldInput/city")
    ],
    apps: %*{}
  )
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

proc fails(scene: FrameScene, nodeId: int): bool =
  try:
    discard scene.getDataNode(nodeId.NodeId, ctx(scene))
    false
  except CatchableError:
    true

proc staleEvents(): int =
  for e in events:
    if e{"event"}.getStr() == "interpreter:cache:stale": inc result

proc lastStaleEvent(): JsonNode =
  for e in events:
    if e{"event"}.getStr() == "interpreter:cache:stale": result = e

let config = testConfig()
let logger = testLogger(config)
install()

block stale_fallback:
  let scene = init(sceneId, config, logger, %*{})
  let interpreted = InterpretedFrameScene(scene)
  doAssert scene.getDataNode(1.NodeId, ctx(scene)).asJson() == %*{"city": "Brussels", "tick": 1}
  doAssert scene.getDataNode(2.NodeId, ctx(scene)).asString() == "tick=1"
  doAssert fileExists(nodeStorePath(sceneId.string, 1)), "a JSON value is kept on storage"

  # The cache expired and the refresh fails: the stored value is served, and
  # logged with its age.
  scene.state["tick"] = %*2
  scene.state["fail"] = %*true
  interpreted.cacheTimes[1.NodeId] -= 120
  interpreted.cacheTimes[2.NodeId] -= 120
  doAssert scene.getDataNode(1.NodeId, ctx(scene)).asJson() == %*{"city": "Brussels", "tick": 1}
  doAssert staleEvents() == 1
  doAssert lastStaleEvent(){"ageSeconds"}.getInt() >= 120
  doAssert lastStaleEvent(){"error"}.getStr() == "offline"
  doAssert lastStaleEvent(){"reason"}.getStr() == "refreshFailed"

  # Without staleEnabled the failure still fails the node.
  doAssert scene.fails(2)

  # Past the window: the failure shows.
  interpreted.cacheTimes[1.NodeId] -= 7200
  doAssert scene.fails(1)

  # A value for other inputs is not a stale value for these.
  interpreted.cacheTimes[1.NodeId] += 7200
  scene.state["city"] = %*"Paris"
  doAssert scene.fails(1)

  # Healthy again: a fresh value replaces it.
  scene.state["fail"] = %*false
  doAssert scene.getDataNode(1.NodeId, ctx(scene)).asJson() == %*{"city": "Paris", "tick": 2}
  scene.state["city"] = %*"Brussels"

block restored_after_restart:
  # A new instance of the scene (a restart, a reload, an ESP32's wake) finds
  # the stored value and serves it as a hit while it is fresh.
  let scene = init(sceneId, config, logger, %*{})
  scene.state["tick"] = %*5
  doAssert scene.getDataNode(1.NodeId, ctx(scene)).asJson() == %*{"city": "Brussels", "tick": 1},
    "the first value for Brussels was stored; the Paris one came within a minute of it"
  var restored = false
  for e in events:
    if e{"event"}.getStr() == "interpreter:cache:restored" and e{"nodeId"}.getInt() == 1:
      restored = true
  doAssert restored

  # And as the stale fallback once it has expired.
  InterpretedFrameScene(scene).cacheTimes[1.NodeId] -= 120
  scene.state["fail"] = %*true
  doAssert scene.getDataNode(1.NodeId, ctx(scene)).asJson() == %*{"city": "Brussels", "tick": 1}
  scene.state["fail"] = %*false

block changed_node_drops_stored_value:
  install(forecastDuration = 90)
  let scene = init(sceneId, config, logger, %*{})
  scene.state["tick"] = %*7
  doAssert scene.getDataNode(1.NodeId, ctx(scene)).asJson() == %*{"city": "Brussels", "tick": 7},
    "a redeployed node with other settings recomputes"

block remembered_values_survive:
  install()
  block:
    let scene = init(sceneId, config, logger, %*{})
    doAssert scene.getDataNode(3.NodeId, ctx(scene)).asString() == "n=1"
    doAssert scene.getDataNode(3.NodeId, ctx(scene)).asString() == "n=2"
  doAssert fileExists(nodeStorePath(sceneId.string, 3, "m"))
  block:
    let scene = init(sceneId, config, logger, %*{})
    doAssert scene.getDataNode(3.NodeId, ctx(scene)).asString() == "n=3"
  # New code starts over.
  install(counterStep = 10)
  block:
    let scene = init(sceneId, config, logger, %*{})
    doAssert scene.getDataNode(3.NodeId, ctx(scene)).asString() == "n=10"

block sweep_removes_other_scenes:
  writeFile(nodeStorePath("tests/gone", 1), "{}")
  writeFile(ScratchDir / "leftover.tmp", "")
  doAssert sweepNodeStore([sceneId.string]) == 2
  doAssert fileExists(nodeStorePath(sceneId.string, 1))
  doAssert not fileExists(nodeStorePath("tests/gone", 1))
  doAssert sweepNodeStore([]) >= 2
  doAssert not fileExists(nodeStorePath(sceneId.string, 1))

block oversized_values_stay_in_memory:
  doAssert writeNodeStoreFile(ScratchDir / "big.json", newString(NodeStoreFileMaxBytes + 1)).len > 0
  doAssert not fileExists(ScratchDir / "big.json")

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
removeDir(ScratchDir)
echo "test_node_store: all assertions passed"
