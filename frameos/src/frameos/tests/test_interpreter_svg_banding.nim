import std/[json, os, tables, strutils]
import pixie
import ../interpreter
import ../types
import ../utils/memory

# End-to-end check for the banded SVG rasteriser on a real, JS-generated
# scene: the bundled "Weather" graph in stacked mode. It puts a render/split
# with two cells in front of three weatherPanel apps, each of which emits an
# 800x192 / 800x288 SVG with a gradient background — the shape that made an
# 8MB-PSRAM ESP32 run out of memory (see docs in utils/image.nim).
#
# The scene must render the same picture whether the SVGs are rasterised in
# one pass (hosts, RAM-rich frames) or band by band (memory-tight devices).

const SceneFile = "../e2e/scenes/weatherStacked.json"

proc testLogger(): Logger =
  var logger = Logger(enabled: false)
  logger.log = proc(payload: JsonNode) =
    let event = payload{"event"}.getStr()
    doAssert not (event.contains("error") or event.contains("Error")),
      "weatherStacked render logged an error: " & $payload
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  logger

proc renderScene(): Image =
  let raw = readFile(SceneFile).strip()
  # The e2e scene files hold a single scene object; scenes.json holds an array.
  let data = if raw.startsWith("["): raw else: "[" & raw & "]"
  let inputs = parseInterpretedSceneInputs(data)
  doAssert inputs.len == 1
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for id, exported in buildInterpretedScenes(inputs):
    uploaded[id] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  let config = FrameConfig(
    name: "test", mode: "embedded", width: 800, height: 480, rotate: 0,
    scalingMode: "cover", assetsPath: getTempDir(), debug: false,
    settings: %*{}, saveAssets: %*false
  )
  let scene = init(inputs[0].id, config, testLogger(), %*{})
  var context = ExecutionContext(
    scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0
  )
  result = render(scene, context)
  setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

doAssert fileExists(SceneFile), "missing " & SceneFile

# Plenty of memory: pixie rasterises each panel SVG in one pass.
availableRenderBytesOverride = 0
let onePass = renderScene()
doAssert onePass.width == 800 and onePass.height == 480

# The scene really did draw something (a blank frame would compare equal).
var inked = 0
for color in onePass.data:
  if color.r.int + color.g.int + color.b.int > 60:
    inc inked
doAssert inked > 20000, "weatherStacked drew only " & $inked & " bright pixels"

# ESP32-class headroom: the panels come back band by band.
availableRenderBytesOverride = 3 * 1024 * 1024
refreshDecodeBudget()
let banded = renderScene()
doAssert banded.width == 800 and banded.height == 480

var worst = 0
var differing = 0
for i in 0 ..< onePass.data.len:
  let
    p = onePass.data[i]
    q = banded.data[i]
    d = max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)),
            max(abs(p.b.int - q.b.int), abs(p.a.int - q.a.int)))
  if d > 0:
    inc differing
    if d > worst: worst = d

# Only float32 rounding of the band-shifted shape coordinates may move an
# antialiased edge sample; nothing structural may change.
doAssert worst <= 8, "banded weatherStacked differs by " & $worst & " (max channel)"
doAssert differing * 100 <= onePass.data.len,
  "banded weatherStacked differs in " & $differing & " of " &
  $onePass.data.len & " pixels"

availableRenderBytesOverride = 0
refreshDecodeBudget()

echo "test_interpreter_svg_banding: worstDiff=", worst, " differingPixels=",
  differing, "/", onePass.data.len
