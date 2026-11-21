## A scene keeps none of its apps' files (docs/scene-packages.md): parsed
## from a scenes.json on disk, a scene package (a ZIP on disk or in memory, a
## folder) or the host's file of the scene (an ESP32's slot), its `apps`
## carry no `sources`; an interpreter reads them when it starts, compiles
## them and lets them go, and reads them again when it starts again.

import std/[json, os, strutils, tables, unittest]
import pixie
import ../interpreter
import ../scene_package
import ../types
import ../js_runtime/app_runtime
import ../utils/zip_entry

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
      "sources": {"app.ts": CardApp, "lib/color.ts": colorLib(color), "config.json": $config,
        "app.test.ts": "test('never on a frame', () => {})\n"}}},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "card", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}

proc le16(n: int): string = $char(n and 0xFF) & $char((n shr 8) and 0xFF)
proc le32(n: int): string = le16(n and 0xFFFF) & le16((n shr 16) and 0xFFFF)

proc storedZip(files: openArray[(string, string)]): string =
  var central = ""
  for (name, data) in files:
    let offset = result.len
    result.add le32(0x04034b50) & le16(20) & le16(0) & le16(0) & le16(0) & le16(0) & le32(0) &
      le32(data.len) & le32(data.len) & le16(name.len) & le16(0) & name & data
    central.add le32(0x02014b50) & le16(20) & le16(20) & le16(0) & le16(0) & le16(0) & le16(0) &
      le32(0) & le32(data.len) & le32(data.len) & le16(name.len) & le16(0) & le16(0) & le16(0) &
      le16(0) & le32(0) & le32(offset) & name
  let at = result.len
  result.add central & le32(0x06054b50) & le16(0) & le16(0) & le16(files.len) & le16(files.len) &
    le32(central.len) & le32(at) & le16(0)

proc packageFiles(scene: JsonNode, folder = ""): seq[(string, string)] =
  ## The scene as a package lays it out (what the planes write).
  let prefix = if folder.len > 0: folder & "/" else: ""
  var sceneJson = scene.copy()
  for keyword, app in sceneJson["apps"].pairs:
    app.delete("sources")
  result.add (prefix & SceneFile, $sceneJson)
  for keyword, app in scene["apps"].pairs:
    for file, text in app["sources"].pairs:
      if not file.contains(".test."):
        result.add (prefix & "apps/" & keyword & "/" & file, text.getStr())

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
  check exported.apps["card"]["name"].getStr() == "card"
  let (color, runtime) = show(scenes, id)
  check color == Red
  check problems.len == 0
  # Compiled and let go.
  check runtime.ready
  check runtime.source == ""
  check runtime.sources.isNil

proc rerenderReadsAgain(scenes: Table[SceneId, ExportedInterpretedScene], id: string, rewrite: proc ()) =
  ## The interpreter goes (a teardown after a render), the files change on
  ## disk, and the next start reads them again.
  discard settleIdleJsAppRuntimes(keep = false)
  rewrite()
  forgetZipDirectory()
  let (color, runtime) = show(scenes, id)
  check color == Blue
  check runtime.source == ""

suite "a scene keeps none of its apps' files":
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

  test "read from a set package on disk, a ZIP and a folder":
    let zipPath = Dir / "scenes.zip"
    let files = @[(TemplateFile, $(%*{"scenes": ["./Card"]}))] & packageFiles(cardScene("zip", "#ff0000"), "Card")
    writeFile(zipPath, storedZip(files))
    var f: File
    check f.open(zipPath)
    let inputs = parsePackagedSceneInputs(zipPackage(zip_entry.fileSource(f), zipPath), zipPath)
    f.close()
    check inputs.len == 1
    check inputs[0].files.kind == sfPackage and inputs[0].files.folder == "Card"
    let scenes = buildInterpretedScenes(inputs)
    checkKeepsNone(scenes, "zip")
    rerenderReadsAgain(scenes, "zip", proc () =
      writeFile(zipPath, storedZip(@[(TemplateFile, $(%*{"scenes": ["./Card"]}))] &
        packageFiles(cardScene("zip", "#0000ff"), "Card"))))

    let folder = Dir / "folder"
    for (path, text) in files:
      createDir(parentDir(folder / path))
      writeFile(folder / path, text)
    let fromFolder = buildInterpretedScenes(parsePackagedSceneInputs(ScenePackage(folder: folder), folder))
    checkKeepsNone(fromFolder, "zip")

  test "read from the host's file of the scene: a package or JSON, as an ESP32's slot":
    var slot = storedZip(packageFiles(cardScene("slot", "#ff0000")))
    var reads = 0
    sceneFileReader = proc (sceneId: SceneId): string =
      inc reads
      {.cast(gcsafe).}: slot
    let scenes = buildInterpretedScenes(parseInterpretedSceneInput(slot, SceneFiles(kind: sfHost)))
    checkKeepsNone(scenes, "slot")
    check reads == 1
    rerenderReadsAgain(scenes, "slot", proc () = slot = storedZip(packageFiles(cardScene("slot", "#0000ff"))))
    # A slot holding the scene's JSON, as every board has today.
    slot = $cardScene("slot", "#ff0000")
    let fromJson = buildInterpretedScenes(parseInterpretedSceneInput(slot, SceneFiles(kind: sfHost)))
    checkKeepsNone(fromJson, "slot")
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
