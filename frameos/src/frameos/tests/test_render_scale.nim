import std/[json, tables, unittest]

import frameos/interpreter
import frameos/render_scale
import frameos/types

proc scenesFrom(json: string): Table[SceneId, ExportedInterpretedScene] =
  buildInterpretedScenes(parseInterpretedSceneInputs(json))

proc initScene(id: string, config: FrameConfig): InterpretedFrameScene =
  let logger = Logger(frameConfig: config, enabled: false, log: proc(payload: JsonNode) = discard)
  InterpretedFrameScene(init(id.SceneId, config, logger, %*{}))

suite "render scale":
  test "automatic: 1, and 2 on a 4K or larger screen on HDMI":
    check autoRenderScale(800, 480, "waveshare.EPD_3in97") == 1.0
    check autoRenderScale(1200, 1600, "waveshare.EPD_13in3e") == 1.0
    check autoRenderScale(1920, 1080, "framebuffer") == 1.0
    check autoRenderScale(2560, 1440, "framebuffer") == 1.0
    check autoRenderScale(3840, 2160, "framebuffer") == 2.0
    check autoRenderScale(2160, 3840, "framebuffer") == 2.0 # hung in portrait
    check autoRenderScale(7680, 4320, "framebuffer") == 2.0
    check autoRenderScale(3840, 2160, "web_only") == 1.0
    check autoRenderScale(0, 0, "framebuffer") == 1.0

  test "a frame's own scale, else the automatic one":
    check frameRenderScale(FrameConfig(width: 1200, height: 1600)) == 1.0
    check frameRenderScale(FrameConfig(width: 3840, height: 2160, device: "framebuffer")) == 2.0
    check frameRenderScale(FrameConfig(width: 3840, height: 2160, device: "framebuffer", renderScale: 1.0)) == 1.0
    check frameRenderScale(FrameConfig(width: 1200, height: 1600, renderScale: 2.0)) == 2.0
    check frameRenderScale(FrameConfig(width: 800, height: 480, renderScale: 1.5)) == 1.5
    check frameRenderScale(FrameConfig(width: 800, height: 480, renderScale: 9.0)) == 1.0 # out of range: automatic
    check frameRenderScale(nil) == 1.0

  test "values from forms":
    check parseRenderScale(%2) == 2.0
    check parseRenderScale(%1.5) == 1.5
    check parseRenderScale(%" 1.25 ") == 1.25
    check parseRenderScale(%0) == 0.0
    check parseRenderScale(%5) == 0.0
    check parseRenderScale(%"big") == 0.0
    check parseRenderScale(newJNull()) == 0.0
    check parseRenderScale(nil) == 0.0

  test "the scene's role field, else its setting, else the frame's":
    let config = FrameConfig(width: 3840, height: 2160, device: "framebuffer")
    let scene = FrameScene(frameConfig: config, state: %*{})
    check effectiveRenderScale(scene, config) == 2.0
    scene.renderScaleSetting = 1.0
    check effectiveRenderScale(scene, config) == 1.0
    scene.renderScaleKey = "scale"
    check effectiveRenderScale(scene, config) == 1.0 # the field holds nothing yet
    scene.state["scale"] = %"3"
    check effectiveRenderScale(scene, config) == 3.0
    scene.state["scale"] = %"none"
    check effectiveRenderScale(scene, config) == 1.0
    check effectiveRenderScale(nil, config) == 2.0

  test "the role field is found by role, not by name":
    let fields = @[
      StateField(name: "scale", fieldType: "float"),
      StateField(name: "zoom", fieldType: "select", role: RenderScaleRole),
    ]
    check renderScaleFieldKey(fields) == "zoom"
    check renderScaleFieldKey(@[StateField(name: "renderScale", fieldType: "float")]) == ""

  test "lengths as a scaled app sees them":
    check scaledLength(1200, 2.0) == 600
    check scaledLength(1404, 2.25) == 624
    check scaledLength(1, 4.0) == 1
    check scaledLength(800, 1.0) == 800

  test "a scene's settings.renderScale and role field come through the interpreter":
    let exports = scenesFrom("""[
      {"id": "tests/scale-setting", "name": "a", "settings": {"execution": "interpreted", "renderScale": 1.5},
       "nodes": [], "edges": [], "fields": []},
      {"id": "tests/scale-field", "name": "b", "settings": {"execution": "interpreted"},
       "nodes": [], "edges": [],
       "fields": [{"name": "zoom", "type": "float", "value": "3", "access": "public", "role": "renderScale"}]},
      {"id": "tests/scale-none", "name": "c", "settings": {"execution": "interpreted", "renderScale": 9},
       "nodes": [], "edges": [], "fields": []}
    ]""")
    check exports["tests/scale-setting".SceneId].renderScaleSetting == 1.5
    check exports["tests/scale-field".SceneId].renderScaleKey == "zoom"
    check exports["tests/scale-none".SceneId].renderScaleSetting == 9.0 # kept; ignored where read
    setUploadedInterpretedScenes(exports)
    let config = FrameConfig(width: 3840, height: 2160, device: "framebuffer")
    check effectiveRenderScale(initScene("tests/scale-setting", config), config) == 1.5
    check effectiveRenderScale(initScene("tests/scale-none", config), config) == 2.0
    let field = initScene("tests/scale-field", config)
    check effectiveRenderScale(field, config) == 3.0 # the field's default is in the state
    var context = ExecutionContext(scene: field, event: "setSceneState",
      payload: %*{"state": {"zoom": "1.25"}}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    runEvent(field, context)
    check effectiveRenderScale(field, config) == 1.25
