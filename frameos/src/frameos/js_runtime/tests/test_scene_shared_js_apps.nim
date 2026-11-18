## A scene's JS apps run in the scene's own context, beside its program
## (docs/scene-compiler.md, "JS apps run in the scene's context"): one
## QuickJS a scene, never one an app node. Each app keeps its own modules
## (behind its prefix), its `app` object and its handlers; `globalThis` is
## the scene's. Its own process, so the programs' runtime starts empty.

import std/[json, strutils, tables, unittest]
import pixie
import frameos/interpreter
import frameos/js_runtime/runtime
import frameos/js_runtime/app_runtime
import frameos/js_runtime/burrito
import frameos/types
import frameos/values
import frameos/utils/memory

var logs: seq[JsonNode]

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc jsApp(name, util, app: string): JsonNode =
  %*{"sources": {
    "config.json": """{"name": """ & escapeJson(name) & """, "category": "data",
      "fields": [], "output": [{"name": "text", "type": "text"}]}""",
    "util.ts": util,
    "app.ts": app}}

const CountingApp = """
import { name } from './util'
let n = 0
export function get(app: FrameOSApp): string {
  n++
  globalThis.calls = (globalThis.calls | 0) + 1
  return name + n + ':' + app.nodeId
}
"""

proc started(sceneId: string, nodes: seq[DiagramNode], apps: JsonNode): InterpretedFrameScene =
  var uploaded = getUploadedInterpretedScenes()
  uploaded[sceneId.SceneId] = ExportedInterpretedScene(name: sceneId, backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0, publicStateFields: @[], nodes: nodes, edges: @[], apps: apps)
  setUploadedInterpretedScenes(uploaded)
  let config = FrameConfig(width: 8, height: 6, rotate: 0, scalingMode: "cover", saveAssets: %*false)
  let logger = Logger(enabled: true, log: proc(payload: JsonNode) = logs.add(payload),
    enable: proc() = discard, disable: proc() = discard)
  InterpretedFrameScene(interpreter.init(sceneId.SceneId, config, logger, %*{}))

proc ctx(scene: FrameScene): ExecutionContext =
  ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)

proc text(scene: InterpretedFrameScene, nodeId: int): string =
  scene.getDataNode(nodeId.NodeId, ctx(scene)).asString()

proc runtimeOf(scene: InterpretedFrameScene, nodeId: int): JsAppRuntime =
  DynamicJsApp(scene.appsByNodeId[nodeId.NodeId]).runtime

proc twoApps(sceneId: string, withCode: bool): InterpretedFrameScene =
  var nodes = @[
    node(1, "app", %*{"keyword": "appA", "config": {}}),
    node(2, "app", %*{"keyword": "appB", "config": {}}),
    node(3, "app", %*{"keyword": "broken", "config": {}})]
  if withCode:
    nodes.add node(4, "code", %*{"codeArgs": [], "codeOutputs": [{"name": "out", "type": "integer"}],
      "codeJS": "20 + 3"})
  started(sceneId, nodes, %*{
    "appA": jsApp("A", "export const name = 'A'", CountingApp),
    "appB": jsApp("B", "export const name = 'B'", CountingApp),
    "broken": jsApp("Broken", "export const x = 1", "export function get() {\n  throw new Error('boom')\n}\n")})

proc sharedChecks(scene: InterpretedFrameScene) =
  # Two apps with the same file names, each with its own modules.
  check scene.text(1) == "A1:1"
  check scene.text(2) == "B1:2"
  check scene.text(1) == "A2:1"
  # In the scene's context, beside each other.
  check scene.jsReady
  check scene.jsKind != sjShared
  check scene.runtimeOf(1).js.context == scene.js.context
  check scene.runtimeOf(2).js.context == scene.js.context
  # globalThis is the scene's: both apps counted into one global.
  let global = scene.js.eval("globalThis.calls")
  check global == "3"
  # An error names the app's own file, not its module name in the context.
  logs.setLen(0)
  expect JsAppError:
    discard scene.getDataNode(3.NodeId, ctx(scene))
  var sawLocation = false
  for entry in logs:
    let line = $entry
    check "#" & $3 & "/" notin line
    if "app.ts:2" in line:
      sawLocation = true
  check sawLocation

suite "a scene's JS apps share its context":
  test "where there is room: the scene's runtime, its code node beside them":
    let scene = twoApps("tests/shared-apps", withCode = true)
    check scene.jsKind == sjRuntime
    sharedChecks(scene)
    check scene.getDataNode(4.NodeId, ctx(scene)).asInt() == 23

    # The context going takes every app with it; each comes back on demand,
    # its module evaluated again.
    cleanupSceneJs(scene)
    check not scene.runtimeOf(1).ready
    check not scene.runtimeOf(2).ready
    check scene.text(1) == "A1:1"
    check scene.text(2) == "B1:2"
    check scene.getDataNode(4.NodeId, ctx(scene)).asInt() == 23

    # One app released alone leaves the others and the context.
    releaseJsAppRuntime(scene.appsByNodeId[1.NodeId])
    check not scene.runtimeOf(1).ready
    check scene.runtimeOf(2).ready
    check scene.text(2) == "B2:2"
    check scene.text(1) == "A1:1"

    # An idle scene's apps are released as one: its whole context.
    check releaseIdleJsAppRuntimes()
    check not scene.jsReady
    check not scene.runtimeOf(2).ready
    check scene.text(2) == "B1:2"
    forgetSceneGraph(scene)

  test "a scene of JS apps alone gets a context of its own":
    let scene = twoApps("tests/shared-apps-no-code", withCode = false)
    check not scene.jsReady # nothing until it runs
    sharedChecks(scene)
    check scene.jsKind == sjRuntime
    forgetSceneGraph(scene)

  test "on an 8 MB board: a realm in the programs' runtime":
    deviceMemoryBytesOverride = 8 * 1024 * 1024 - 64 * 1024
    defer: deviceMemoryBytesOverride = 0
    let first = twoApps("tests/shared-apps-realm-1", withCode = false)
    let second = twoApps("tests/shared-apps-realm-2", withCode = true)
    sharedChecks(first)
    sharedChecks(second)
    check first.jsKind == sjRealm
    check second.jsKind == sjRealm
    check first.js.runtime == second.js.runtime
    check first.js.context != second.js.context
    # The other scene's apps are untouched by one closing.
    cleanupSceneJs(first)
    check not first.runtimeOf(1).ready
    check second.runtimeOf(1).ready
    check second.text(1) == "A3:1"
    check first.text(1) == "A1:1"
    forgetSceneGraph(first)
    forgetSceneGraph(second)
