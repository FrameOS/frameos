## A loaded scene keeps none of its apps' files (docs/esp32-memory.md, "What
## a loaded scene keeps"): parsed from a scenes.json on disk, an upload's
## state/uploaded.json, or the host's text of the scene (an ESP32's slot, the
## browser preview's payload), its `apps` carry no `sources`; an interpreter
## reads them when it starts, compiles them and lets them go, and reads them
## again when it starts again.

import std/[json, os, strutils, tables, unittest]
import pixie
import ../interpreter
import ../types
import ../js_runtime/app_runtime

const
  Dir = currentSourcePath().parentDir() / ".." / ".." / ".." / "build" / "test-scene-files"
  CardApp = """
import { color } from './lib/color'
export function get(app) {
  const W = app.frame.width
  const H = app.frame.height
  return frameos.svg('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + color + '"/></svg>', { width: W, height: H })
}
"""

proc colorLib(color: string): string = "export const color = '" & color & "'\n"

proc cardScene(id, color: string): JsonNode =
  let config = %*{"name": "card", "category": "data", "output": [{"name": "image", "type": "image"}], "fields": []}
  %*{"id": id, "name": "Card " & id,
    "settings": {"execution": "interpreted", "refreshInterval": 60, "backgroundColor": "#000000"},
    "fields": [], "apps": {"card": {"name": "card", "category": "data", "version": "1.0.0",
      "sources": {"app.ts": CardApp, "lib/color.ts": colorLib(color), "config.json": $config}}},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "card", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}

let config = FrameConfig(name: "files", width: 16, height: 8, rotate: 0, scalingMode: "cover",
  debug: false, settings: %*{}, saveAssets: %*false, assetsPath: Dir / "assets")
var problems: seq[string]
var logger = Logger(frameConfig: config, enabled: true)
logger.log = proc(payload: JsonNode) =
  if payload{"event"}.getStr().contains("error"):
    problems.add($payload)
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

proc show(scenes: Table[SceneId, ExportedInterpretedScene], id: string): tuple[color: ColorRGBX, runtime: JsAppRuntime] =
  setUploadedInterpretedScenes(scenes)
  resetInterpretedScenes()
  let scene = init(id.SceneId, config, logger, %*{})
  let canvas = newImage(16, 8)
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: canvas,
    hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  discard render(scene, context)
  let app = InterpretedFrameScene(scene).appsByNodeId[2.NodeId]
  (canvas[8, 4], DynamicJsApp(app).runtime)

const Red = rgbx(255, 0, 0, 255)
const Blue = rgbx(0, 0, 255, 255)

removeDir(Dir)
createDir(Dir)

proc checkKeepsNone(scenes: Table[SceneId, ExportedInterpretedScene], id: string) =
  let exported = scenes[id.SceneId]
  check exported.files.kind != sfResident
  check not exported.apps["card"].hasKey("sources")
  check exported.apps.hasKey("card")
  let (color, runtime) = show(scenes, id)
  check color == Red
  check problems.len == 0
  # Compiled and let go.
  check runtime.ready
  check runtime.source == ""
  check runtime.sources.isNil

proc rerenderReadsAgain(scenes: Table[SceneId, ExportedInterpretedScene], id: string, rewrite: proc ()) =
  ## The interpreter goes (a teardown after a render), the JSON changes where
  ## it lives, and the next start reads it again.
  discard settleIdleJsAppRuntimes(keep = false)
  rewrite()
  let (color, runtime) = show(scenes, id)
  check color == Blue
  check runtime.source == ""

suite "a loaded scene keeps none of its apps' files":
  test "read from a scenes.json on disk":
    let path = Dir / "scenes.json"
    writeFile(path, $(%*[cardScene("json", "#ff0000")]))
    let scenes = parseInterpretedScenes(readFile(path), SceneFiles(kind: sfJson, path: path))
    checkKeepsNone(scenes, "json")
    rerenderReadsAgain(scenes, "json", proc () = writeFile(path, $(%*[cardScene("json", "#0000ff")])))

  test "read from an upload's state/uploaded.json shape":
    let path = Dir / "uploaded.json"
    writeFile(path, $(%*{"scenes": [cardScene("other", "#00ff00"), cardScene("up", "#ff0000")], "sceneId": "up"}))
    let scenes = buildInterpretedScenes(parseInterpretedSceneInputs($(%*[cardScene("up", "#ff0000")]),
      SceneFiles(kind: sfJson, path: path)))
    checkKeepsNone(scenes, "up")

  test "read from the host's text of the scene, as an ESP32's slot":
    var slot = $cardScene("slot", "#ff0000")
    var reads = 0
    sceneFileReader = proc (sceneId: SceneId): string =
      inc reads
      {.cast(gcsafe).}: slot
    let scenes = buildInterpretedScenes(parseInterpretedSceneInput(slot, SceneFiles(kind: sfHost)))
    checkKeepsNone(scenes, "slot")
    # One read, for the one app the scene names; the built-in render/image none.
    check reads == 1
    rerenderReadsAgain(scenes, "slot", proc () = slot = $cardScene("slot", "#0000ff"))
    sceneFileReader = nil

  test "a scene with nowhere to read them again keeps them, as before":
    let scenes = parseInterpretedScenes($(%*[cardScene("resident", "#ff0000")]))
    check scenes["resident".SceneId].files.kind == sfResident
    check scenes["resident".SceneId].apps["card"].hasKey("sources")
    let (color, runtime) = show(scenes, "resident")
    check color == Red
    check runtime.source == ""

  test "an app's files out of a scene JSON, without building the rest":
    let text = $(%*[cardScene("a", "#ff0000"), cardScene("b", "#0000ff")])
    check appSourcesInJson(text, "b", "card")["lib/color.ts"].getStr().contains("#0000ff")
    check appSourcesInJson(text, "a", "card")["lib/color.ts"].getStr().contains("#ff0000")
    check appSourcesInJson(text, "c", "card").isNil
    check appSourcesInJson(text, "a", "other").isNil
    check appSourcesInJson($(%*{"scenes": [cardScene("u", "#ff0000")]}), "u", "card")["app.ts"].getStr() == CardApp
    check appSourcesInJson($cardScene("one", "#ff0000"), "one", "card").hasKey("config.json")
