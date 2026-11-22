import std/[json, tables, unittest]
import pixie

import frameos/interpreter
import frameos/scene_background
import frameos/types

proc scenesFrom(json: string): Table[SceneId, ExportedInterpretedScene] =
  buildInterpretedScenes(parseInterpretedSceneInputs(json))

proc initScene(id: string, config: FrameConfig): InterpretedFrameScene =
  let logger = Logger(frameConfig: config, enabled: false, log: proc(payload: JsonNode) = discard)
  InterpretedFrameScene(init(id.SceneId, config, logger, %*{}))

suite "scene background":
  test "the role field's color, else the setting":
    let scene = FrameScene(state: %*{}, backgroundColor: parseHtmlColor("#000000"))
    check sceneBackgroundColor(scene) == parseHtmlColor("#000000")
    scene.backgroundColorKey = "background"
    check sceneBackgroundColor(scene) == parseHtmlColor("#000000") # the field holds nothing yet
    scene.state["background"] = %"#ffffff"
    check sceneBackgroundColor(scene) == parseHtmlColor("#ffffff")
    scene.state["background"] = %"#f80"
    check sceneBackgroundColor(scene) == parseHtmlColor("#ff8800")
    for notAColor in [%"white", %"#12345", %"#gggggg", %"", %3, newJNull()]:
      scene.state["background"] = notAColor
      check sceneBackgroundColor(scene) == parseHtmlColor("#000000")
    check sceneBackgroundColor(nil) == color(0, 0, 0)

  test "the role field is found by role, not by name":
    let fields = @[
      StateField(name: "backgroundColor", fieldType: "color"),
      StateField(name: "bars", fieldType: "color", role: BackgroundColorRole),
    ]
    check backgroundColorFieldKey(fields) == "bars"
    check backgroundColorFieldKey(@[StateField(name: "backgroundColor", fieldType: "color")]) == ""

  test "a render pays the role field's color, and a control form changes it":
    let exports = scenesFrom("""[
      {"id": "tests/bg-field", "name": "a", "settings": {"execution": "interpreted", "backgroundColor": "#000000"},
       "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}}], "edges": [],
       "fields": [{"name": "bars", "type": "color", "value": "#ffffff", "access": "public", "role": "backgroundColor"}]},
      {"id": "tests/bg-setting", "name": "b", "settings": {"execution": "interpreted", "backgroundColor": "#102030"},
       "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}}], "edges": [], "fields": []}
    ]""")
    check exports["tests/bg-field".SceneId].backgroundColorKey == "bars"
    check exports["tests/bg-setting".SceneId].backgroundColorKey == ""
    setUploadedInterpretedScenes(exports)
    let config = FrameConfig(width: 16, height: 8)

    proc rendered(scene: InterpretedFrameScene): ColorRGBX =
      let image = newImage(16, 8)
      var context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: image,
        hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
      runEvent(scene, context)
      image[3, 3]

    let field = initScene("tests/bg-field", config)
    check rendered(field) == rgbx(255, 255, 255, 255) # the field's default is in the state
    var change = ExecutionContext(scene: field, event: "setSceneState",
      payload: %*{"state": {"bars": "#ff0000"}}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    runEvent(field, change)
    check rendered(field) == rgbx(255, 0, 0, 255)
    check rendered(initScene("tests/bg-setting", config)) == rgbx(16, 32, 48, 255)
