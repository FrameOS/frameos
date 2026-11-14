import std/[json, sequtils, strutils, tables, unittest]
import pixie

import frameos/js_runtime/runtime
import frameos/interpreter
import frameos/scene_compiler
import frameos/types
import frameos/values
import lib/tz

type LogStore = ref object
  entries: seq[JsonNode]

proc testLogger(store: LogStore): Logger =
  Logger(
    enabled: true,
    log: proc(payload: JsonNode) = store.entries.add(payload),
    enable: proc() = discard,
    disable: proc() = discard
  )

proc testContext(scene: FrameScene): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: "."
  )

proc codeNode(id: int, code: string, outputType = ""): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: "code", data: %*{"codeArgs": [],
    "codeOutputs": (if outputType.len > 0: %*[{"name": "out", "type": outputType}] else: %*[]),
    "codeJS": code})

proc codeScene(nodes: seq[DiagramNode], config: FrameConfig, store: LogStore): InterpretedFrameScene =
  ## A scene of code nodes, started: what a snippet runs in.
  let sceneId = "tests/js-runtime".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = ExportedInterpretedScene(name: "code", backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0, publicStateFields: @[], nodes: nodes, edges: @[], apps: %*{})
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  InterpretedFrameScene(interpreter.init(sceneId, config, testLogger(store), %*{}))

proc codeValue(code: string, outputType = ""): Value =
  let store = LogStore()
  let scene = codeScene(@[codeNode(1, code, outputType)], FrameConfig(width: 4, height: 3), store)
  result = scene.getDataNode(1.NodeId, testContext(scene))
  cleanupSceneJs(scene)

suite "js runtime helper seams":
  test "toJsIdent sanitizes invalid identifiers":
    check toJsIdent("") == "_"
    check toJsIdent("alpha_1") == "alpha_1"
    check toJsIdent("1 bad-name") == "___bad_name"
    check toJsIdent("$ok") == "$ok"

  test "a code node's undefined is nothing, or its declared type's zero":
    check codeValue("undefined").kind == fkNone
    let undefinedAsInt = codeValue("undefined", "integer")
    check undefinedAsInt.kind == fkInteger
    check undefinedAsInt.asInt() == 0

  test "a code node's result keeps its kind":
    let s = codeValue("'x'")
    check s.kind == fkString
    check s.asString() == "x"

    let nInt = codeValue("7")
    check nInt.kind == fkInteger
    check nInt.asInt() == 7

    let nFloat = codeValue("1.5")
    check nFloat.kind == fkFloat
    check abs(nFloat.asFloat() - 1.5) < 0.0001

    let b = codeValue("true")
    check b.kind == fkBoolean
    check b.asBool()

    let j = codeValue("[1, 2]")
    check j.kind == fkJson
    check j.asJson().len == 2

  test "a bigint keeps an in-range integer":
    let inRange = codeValue("9223372036854775807n")
    check inRange.kind == fkInteger
    check inRange.asInt() == 9223372036854775807'i64

  test "the declared output type wins over the result's kind":
    let coerced = codeValue("'12'", "integer")
    check coerced.kind == fkInteger
    check coerced.asInt() == 12

  test "code runs typescript and jsx through quickjs":
    let value = codeValue(
      "(({count}: {count: number}) => <result total={count + 1}>{count}</result>)({ count: 2 })")
    check value.kind == fkJson
    let jsonValue = value.asJson()
    check jsonValue["type"].getStr() == "result"
    check jsonValue["props"]["total"].getInt() == 3
    check jsonValue["props"]["children"].getInt() == 2

  test "runtime errors are put back on the snippet's own lines":
    let store = LogStore()
    let scene = codeScene(@[codeNode(2,
      "(() => {\n  const count: number = 1\n  throw new Error(\"mapped boom\")\n})()")],
      FrameConfig(width: 4, height: 3), store)
    let value = scene.getDataNode(2.NodeId, testContext(scene))
    check value.kind == fkNone
    let errorLogs = store.entries.filterIt(it{"event"}.getStr() == "interpreter:jsError")
    check errorLogs.len == 1
    check "mapped boom" in errorLogs[0]{"message"}.getStr()
    check "<frameos:code:2>:3:" in errorLogs[0]{"stack"}.getStr()
    cleanupSceneJs(scene)

  test "format renders in the scene's configured time zone":
    # A Word clock scene asks `format(now(), "{hour}")`. It must answer in
    # the frame's zone on every platform — the ESP32 has no /etc/localtime,
    # so the old detectSystemTimeZone() fallback rendered UTC there.
    initTimeZone()
    let store = LogStore()
    let scene = codeScene(@[
      # 2026-08-30T08:00:00Z; Brussels is on CEST (UTC+2).
      codeNode(3, "format(1788076800, \"{hour/2}:{minute/2}\")", "string"),
      # 2026-01-15T08:00:00Z; CET (UTC+1) — the DST fold must follow the date.
      codeNode(4, "format(1768464000, \"{hour/2}:{minute/2}\")", "string")],
      FrameConfig(width: 4, height: 3, timeZone: "Europe/Brussels"), store)
    check scene.getDataNode(3.NodeId, testContext(scene)).asString() == "10:00"
    check scene.getDataNode(4.NodeId, testContext(scene)).asString() == "09:00"

    # The ESP32 pushes a changed zone into the same frameConfig every render
    # pass; the running QuickJS context must pick it up without a rebuild.
    scene.frameConfig.timeZone = "America/New_York"
    check scene.getDataNode(3.NodeId, testContext(scene)).asString() == "04:00"

    # A zone chrono has no data for renders as UTC rather than failing the
    # node (an ESP32 whose tz slice has not arrived yet).
    scene.frameConfig.timeZone = "Mars/Olympus_Mons"
    check scene.getDataNode(3.NodeId, testContext(scene)).asString() == "08:00"
    cleanupSceneJs(scene)

  test "format falls back to setJsTimeZone when the frame names no zone":
    initTimeZone()
    setJsTimeZone("Asia/Tokyo")
    check codeValue("format(1788076800, \"{hour/2}:{minute/2}\")").asString() == "17:00"
    setJsTimeZone("")

  test "cleanupSceneJs closes the quickjs runtime":
    var scene = InterpretedFrameScene(id: "tests/js-runtime".SceneId)
    ensureSceneJs(scene)
    check scene.jsReady
    check scene.js.context != nil

    cleanupSceneJs(scene)

    check scene.jsReady == false
    check scene.js.context == nil
    check scene.js.runtime == nil
