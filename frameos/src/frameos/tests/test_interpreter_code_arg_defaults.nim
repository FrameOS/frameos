import std/[json, tables, strutils, unittest]
import pixie
import ../interpreter
import ../types
import ../values
import ../../apps/data/beRecycle/app as beRecycleApp

# A code node that merges two data sources ([...cal, ...recycle]) must keep
# rendering when ONE of the sources dies. Before this, a failing producer left
# its arg unset, JS saw `undefined`, and the spread threw -- taking the whole
# calendar down because a third-party recycling API started answering 401.

type LogStore = ref object
  entries: seq[JsonNode]

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 8,
    height: 6,
    rotate: 0,
    scalingMode: "cover",
    debug: true,
    saveAssets: %*false
  )

proc testLogger(config: FrameConfig, store: LogStore): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    store.entries.add(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(
    id: id.NodeId,
    source: source.NodeId,
    sourceHandle: sourceHandle,
    target: target.NodeId,
    targetHandle: targetHandle,
    edgeType: ""
  )

proc ctx(scene: FrameScene, event: string): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: event,
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )

proc eventPayload(store: LogStore, eventName: string): JsonNode =
  for entry in store.entries:
    if entry.kind == JObject and entry{"event"}.getStr() == eventName:
      return entry
  return nil

proc eventCount(store: LogStore, eventName: string): int =
  for entry in store.entries:
    if entry.kind == JObject and entry{"event"}.getStr() == eventName:
      inc result

proc withUploadedScene(sceneId: SceneId, exported: ExportedInterpretedScene,
                       body: proc(store: LogStore, scene: InterpretedFrameScene)) =
  let config = testConfig()
  let store = LogStore(entries: @[])
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  try:
    let scene = init(sceneId, config, testLogger(config, store), %*{})
    body(store, InterpretedFrameScene(scene))
  finally:
    setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
    resetInterpretedScenes()

# --- The real scene's shape ------------------------------------------------
# 20: "cal"     -> a healthy producer of a JSON event array (stands in for
#                  data/icalJson)
# 30: "recycle" -> data/beRecycle, which raises IOError("HTTP 401 ...") when
#                  the third-party secret is rotated
# 40: merge     -> [...cal, ...recycle], args declared "string" even though
#                  both producers emit JSON arrays (exactly as in the wild)
# 50: a node that cannot survive the substituted zero value, used to check the
#     error is attributed back to the arg that failed
# 60: same merge as 40, but with input+duration caching enabled

const calSnippet = """JSON.parse('[{"summary":"Standup"}]')"""

proc calendarScene(): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "calendar with two sources",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 1.0,
    publicStateFields: @[],
    nodes: @[
      node(20, "code", %*{
        "codeArgs": [],
        "codeOutputs": [%*{"name": "events", "type": "json"}],
        "codeJS": calSnippet
      }),
      node(30, "app", %*{
        "keyword": "data/beRecycle",
        "config": {
          "streetName": "Teststraat",
          "number": 1,
          "postalCode": 9000,
          "language": "en"
        }
      }),
      node(40, "code", %*{
        "codeArgs": [
          %*{"name": "cal", "type": "string"},
          %*{"name": "recycle", "type": "string"}
        ],
        "codeOutputs": [%*{"name": "events", "type": "json"}],
        "codeJS": "[...cal, ...recycle]"
      }),
      node(50, "code", %*{
        "codeArgs": [%*{"name": "recycle", "type": "string"}],
        "codeOutputs": [%*{"name": "events", "type": "json"}],
        "codeJS": "recycle.map(function (item) { return item.summary })"
      }),
      node(60, "code", %*{
        "codeArgs": [
          %*{"name": "cal", "type": "string"},
          %*{"name": "recycle", "type": "string"}
        ],
        "codeOutputs": [%*{"name": "events", "type": "json"}],
        "codeJS": "[...cal, ...recycle]",
        "cache": {
          "enabled": true,
          "inputEnabled": true,
          "durationEnabled": true,
          "duration": 600
        }
      })
    ],
    edges: @[
      edge(100, 20, "fieldOutput", 40, "codeField/cal"),
      edge(101, 30, "fieldOutput", 40, "codeField/recycle"),
      edge(102, 30, "fieldOutput", 50, "codeField/recycle"),
      edge(103, 20, "fieldOutput", 60, "codeField/cal"),
      edge(104, 30, "fieldOutput", 60, "codeField/recycle")
    ],
    apps: %*{}
  )

proc inlineArgScene(): ExportedInterpretedScene =
  ## Same merge, but "recycle" arrives from an inline snippet instead of a
  ## connected producer. No app node here, so nothing reaches the network.
  ExportedInterpretedScene(
    name: "calendar with an inline source",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 1.0,
    publicStateFields: @[],
    nodes: @[
      node(20, "code", %*{
        "codeArgs": [],
        "codeOutputs": [%*{"name": "events", "type": "json"}],
        "codeJS": calSnippet
      }),
      node(41, "code", %*{
        "codeArgs": [
          %*{"name": "cal", "type": "string"},
          %*{"name": "recycle", "type": "string"}
        ],
        "codeOutputs": [%*{"name": "events", "type": "json"}],
        "codeJS": "[...cal, ...recycle]"
      })
    ],
    edges: @[
      edge(100, 20, "fieldOutput", 41, "codeField/cal")
    ],
    apps: %*{}
  )

const unauthorized = """HTTP 401 Unauthorized: {"message":"Access denied"}"""

proc failRecycle() =
  beRecycleApp.beRecycleAuthenticateHook = proc(self: beRecycleApp.App) =
    raise newException(IOError, unauthorized)
  beRecycleApp.beRecycleFetchCollectionsHook = nil

proc healRecycle() =
  beRecycleApp.beRecycleAuthenticateHook = proc(self: beRecycleApp.App) =
    discard
  beRecycleApp.beRecycleFetchCollectionsHook =
    proc(self: beRecycleApp.App, fromDate: string, toDate: string): JsonNode =
      %*{"items": [{
        "timestamp": "2026-08-11T08:00:00.000Z",
        "fraction": {"name": {"en": "Paper"}}
      }]}

proc restoreRecycle() =
  beRecycleApp.beRecycleAuthenticateHook = nil
  beRecycleApp.beRecycleFetchCollectionsHook = nil

suite "code node args survive a failing producer":
  test "a failing data source no longer takes down the whole merge":
    failRecycle()
    defer: restoreRecycle()

    let sceneId = "tests/code-arg-defaults/merge".SceneId
    withUploadedScene(sceneId, calendarScene()) do (store: LogStore, scene: InterpretedFrameScene):
      let value = scene.getDataNode(40.NodeId, ctx(scene, "render"))

      # The surviving source still renders
      check value.kind == fkJson
      let events = value.asJson()
      check events.kind == JArray
      check events.len == 1
      check events[0]{"summary"}.getStr() == "Standup"

      # The underlying error is still logged, unweakened -- this log line is how
      # the 401 was found in the first place
      let argError = eventPayload(store, "interpreter:codeArg:error")
      check not argError.isNil
      check argError{"arg"}.getStr() == "recycle"
      check argError{"producer"}.getInt() == 30
      check unauthorized in argError{"error"}.getStr()
      # ...and we record which arg was defaulted, and with what
      check argError{"defaulted"}.getBool()
      check argError{"defaultValue"}.getStr() == ""

      # The code node itself ran cleanly: no `undefined` spread blowup
      check eventPayload(store, "interpreter:jsError").isNil

  test "an unsurvivable default names the producer that actually failed":
    failRecycle()
    defer: restoreRecycle()

    let sceneId = "tests/code-arg-defaults/attribution".SceneId
    withUploadedScene(sceneId, calendarScene()) do (store: LogStore, scene: InterpretedFrameScene):
      discard scene.getDataNode(50.NodeId, ctx(scene, "render"))

      let jsError = eventPayload(store, "interpreter:jsError")
      check not jsError.isNil
      let message = jsError{"message"}.getStr()
      # Still the original JS complaint...
      check "not a function" in message
      # ...plus the real cause
      check "defaulted inputs: recycle failed: " & unauthorized in message
      check jsError{"defaultedArgs"}[0]{"arg"}.getStr() == "recycle"
      check unauthorized in jsError{"defaultedArgs"}[0]{"error"}.getStr()

  test "healthy producers are untouched":
    healRecycle()
    defer: restoreRecycle()

    let sceneId = "tests/code-arg-defaults/healthy".SceneId
    withUploadedScene(sceneId, calendarScene()) do (store: LogStore, scene: InterpretedFrameScene):
      let value = scene.getDataNode(40.NodeId, ctx(scene, "render"))

      check value.kind == fkJson
      let events = value.asJson()
      check events.len == 2
      check events[0]{"summary"}.getStr() == "Standup"
      check events[1]{"summary"}.getStr() == "Trash: Paper"

      check eventCount(store, "interpreter:codeArg:error") == 0
      check eventPayload(store, "interpreter:jsError").isNil

  test "a degraded result is never written to the node cache":
    let sceneId = "tests/code-arg-defaults/cache".SceneId
    withUploadedScene(sceneId, calendarScene()) do (store: LogStore, scene: InterpretedFrameScene):
      defer: restoreRecycle()

      # Pass 1: producer is down. The node still returns the surviving data,
      # but nothing is stored -- the next pass must retry the producer.
      failRecycle()
      check scene.getDataNode(60.NodeId, ctx(scene, "render")).asJson().len == 1
      check not scene.cacheValues.hasKey(60.NodeId)
      check not scene.cacheKeys.hasKey(60.NodeId)

      # Pass 2: producer recovers. Full result, and now it caches.
      healRecycle()
      check scene.getDataNode(60.NodeId, ctx(scene, "render")).asJson().len == 2
      check scene.cacheValues.hasKey(60.NodeId)
      check scene.cacheValues[60.NodeId].asJson().len == 2

      # Pass 3: producer breaks again. The caller gets the degraded value for
      # this pass, but the good cache entry is left intact rather than being
      # overwritten with data-less output.
      failRecycle()
      check scene.getDataNode(60.NodeId, ctx(scene, "render")).asJson().len == 1
      check scene.cacheValues[60.NodeId].asJson().len == 2

      # Pass 4: recovered again -- the untouched key still matches, so the
      # cached good value is served.
      healRecycle()
      check scene.getDataNode(60.NodeId, ctx(scene, "render")).asJson().len == 2

  test "inline code args are defaulted the same way":
    let sceneId = "tests/code-arg-defaults/inline".SceneId
    withUploadedScene(sceneId, inlineArgScene()) do (store: LogStore, scene: InterpretedFrameScene):
      # Wire an inline arg after init so it is never precompiled: evaluating it
      # then raises out of the inline branch, the way a runtime compile failure
      # would.
      scene.codeInlineInputsForNodeId[41.NodeId] = initTable[string, string]()
      scene.codeInlineInputsForNodeId[41.NodeId]["recycle"] = "(() => {"

      let value = scene.getDataNode(41.NodeId, ctx(scene, "render"))
      check value.asJson().len == 1

      let argError = eventPayload(store, "interpreter:codeArg:error:inlineCode")
      check not argError.isNil
      check argError{"arg"}.getStr() == "recycle"
      check argError{"defaulted"}.getBool()
      check eventPayload(store, "interpreter:jsError").isNil

suite "zero values for defaulted args":
  test "string-ish types default to an empty string":
    check zeroValueForCodeArgType("string").asString() == ""
    check zeroValueForCodeArgType("select").asString() == ""
    check zeroValueForCodeArgType("text").kind == fkText
    check zeroValueForCodeArgType("text").asString() == ""

  test "json and unknown types default to an empty array, never null":
    for typeName in ["json", "", "somethingNew"]:
      let zero = zeroValueForCodeArgType(typeName)
      check zero.kind == fkJson
      check zero.asJson().kind == JArray
      check zero.asJson().len == 0

  test "scalar types keep their existing zero values":
    check zeroValueForCodeArgType("integer").asInt() == 0
    check zeroValueForCodeArgType("float").asFloat() == 0.0
    check zeroValueForCodeArgType("boolean").asBool() == false
    check zeroValueForCodeArgType("image").kind == fkNone
