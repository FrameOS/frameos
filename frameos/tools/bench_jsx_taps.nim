## Host benchmark: a JSX scene's taps through the ESP32's host (single_scene_host)
## into three rotating RGB565 "LCD buffers" with the damage records on, the
## render probe on, the way the SenseCAP Indicator renders (embedded_runtime).
##
##   nim c -d:release -d:useMalloc -o:build/bench_jsx_taps tools/bench_jsx_taps.nim
##   build/bench_jsx_taps <scene.json> <rounds> [x,y wire coords ...]
##
## A scene file is one scene object (e2e/scenes/*.json, a repo sample's
## scene.json) or an array of them; the first is shown. Taps default to the
## e2e file's `e2eEvents` pointerDown positions. BENCH_AUTOTAP=n taps n of
## the UI's press regions instead, BENCH_VERBOSE=1 prints every render's
## probe line, and the buffers' checksum at the end is how two builds are
## shown to draw the same pictures.
##
## The split is a laptop's, not a device's: on the SenseCAP Indicator the
## JavaScript and the tree walks are 300 to 500 times slower than here and
## the raster about 80 times (docs/perf-todo.md), so a change is measured on
## a board before it is believed.

import std/[json, monotimes, times, os, strutils, options, tables, algorithm, sequtils]
import pixie
import frameos/interpreter
import frameos/single_scene_host
import frameos/types
import frameos/render_probe
import frameos/events_gen
import frameos/channels
import frameos/utils/svg_frames
from frameos/ui/events import uiPressRects
import pixie/paths
coverageCacheBudget = 256 * 1024

const Size = 480


proc median(xs: seq[float]): float =
  if xs.len == 0: return 0
  var s = xs
  s.sort()
  s[s.len div 2]

let args = commandLineParams()
if args.len < 1:
  quit("usage: bench_jsx_taps <scene.json> [rounds] [x,y ...]")
let raw = parseFile(args[0])
let rounds = if args.len > 1: parseInt(args[1]) else: 20
var scenesJson = if raw.kind == JArray: raw else: %*[raw]
let first = scenesJson[0]
let width = first{"e2eFrame"}{"width"}.getInt(Size)
let height = first{"e2eFrame"}{"height"}.getInt(Size)

var taps: seq[(int, int)]
for i in 2 ..< args.len:
  let parts = args[i].split(',')
  taps.add((parseInt(parts[0]), parseInt(parts[1])))
if taps.len == 0 and first.hasKey("e2eEvents"):
  for e in first["e2eEvents"]:
    if e["event"].getStr() == "pointerDown":
      taps.add((e["payload"]["x"].getInt(), e["payload"]["y"].getInt()))
let autoTaps = parseInt(getEnv("BENCH_AUTOTAP", "0"))
if taps.len == 0 and autoTaps == 0:
  quit("no taps")

replaceInterpretedScenesCache(buildInterpretedScenes(parseInterpretedSceneInputs($scenesJson)))

let config = FrameConfig(width: width, height: height, rotate: 0, scalingMode: "cover", debug: false,
  saveAssets: %*false, assetsPath: getTempDir())
var logger = Logger(frameConfig: config, enabled: true)
logger.log = proc(payload: JsonNode) =
  if getEnv("BENCH_LOG") == "1": echo "LOG ", $payload
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

let host = SingleSceneHost(frameConfig: config, logger: logger, keepJsRuntimes: true)
host.requestSelect = proc (sceneId: string): bool = true
host.start()
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    host.queue(origin, event, payload, scene)
if getEnv("BENCH_WINDOWED") == "1":
  host.setWindowed(true)
let shown = getEnv("BENCH_SCENE", first["id"].getStr())
host.makeCurrent(shown.SceneId)

# Three panel buffers in turn, as the SenseCAP's LCD_FBS.
var canvases: array[3, Image]
var buffers: array[3, seq[uint8]]
for i in 0 ..< 3:
  buffers[i] = newSeq[uint8](width * height * 2)
  canvases[i] = newImage565Over(width, height, buffers[i][0].addr)
  canvases[i].ditherStores = true
panelBufferGeneration = proc(buffer: pointer): int64 {.nimcall, raises: [].} = 0
var nextCanvas = 0

type Pass = object
  label: string
  totalMs: float
  collectMs: float
  phases: Table[string, float]

var passes: seq[Pass]

proc renderPass(label: string): Pass =
  let canvas = canvases[nextCanvas]
  nextCanvas = (nextCanvas + 1) mod 3
  beginPanelFrame(canvas.bufferPointer, 0)
  probeOn = true
  let cacheStart = probeBegin()
  discard host.ensureScene()
  let context = ExecutionContext(scene: host.scene, event: "render", payload: %*{}, image: canvas,
    hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  let t0 = getMonoTime()
  probe(phScene):
    discard host.renderScene(context)
  let t1 = getMonoTime()
  endPanelFrame()
  GC_fullCollect()
  let t2 = getMonoTime()
  result.label = label
  result.totalMs = (t1 - t0).inNanoseconds.float / 1e6
  result.collectMs = (t2 - t1).inNanoseconds.float / 1e6
  for phase in RenderPhase:
    let ns = probeNs(phase)
    if ns > 0:
      result.phases[$phase] = ns.float / 1e6
  if getEnv("BENCH_VERBOSE") == "1":
    echo label, " ", formatFloat(result.totalMs, ffDecimal, 2), " ms [", probeLine(cacheStart), "]"

proc send(event: string, x, y: int, buttons: int): float =
  let t0 = getMonoTime()
  discard host.send(eoDriver, event, %*{"x": x, "y": y, "pointerId": 1, "pointerType": "touch",
    "button": 0, "buttons": buttons})
  (getMonoTime() - t0).inNanoseconds.float / 1e6

# Cold first render, then two more so every buffer holds a frame.
passes.add renderPass("cold")
for i in 0 ..< 3:
  passes.add renderPass("warm")

if autoTaps > 0:
  var rects: seq[array[4, float32]]
  for sid in getEnv("BENCH_RECTS_SCENE", shown).split(','):
    uiPressRects(sid, rects)
  echo "press rects: ", rects.len
  # small rects only (buttons, not scroll areas): skip anything over a quarter of the panel
  var picks: seq[array[4, float32]]
  for r in rects:
    if (r[2] - r[0]) * (r[3] - r[1]) < float32(width * height) / 4:
      picks.add r
  let skipFirst = parseInt(getEnv("BENCH_AUTOTAP_SKIP", "0"))
  let stride = max(1, (picks.len - skipFirst) div autoTaps)
  var i = skipFirst
  while i < picks.len and taps.len < autoTaps:
    let r = picks[i]
    let cx = (r[0] + r[2]) / 2
    let cy = (r[1] + r[3]) / 2
    taps.add((int(cx * 32767 / width.float32), int(cy * 32767 / height.float32)))
    echo "tap at ", int(cx), ",", int(cy)
    i += stride

var
  pressSend, upSend: seq[float]
  pressPasses, tapPasses: seq[Pass]
for round in 0 ..< rounds:
  for (x, y) in taps:
    pressSend.add send("pointerDown", x, y, 1)
    if host.takeRenderRequested():
      pressPasses.add renderPass("press")
    upSend.add send("pointerUp", x, y, 0)
    if host.takeRenderRequested():
      tapPasses.add renderPass("tap")
    # the extra render a handler's dispatch asked for, if any
    while host.takeRenderRequested():
      tapPasses.add renderPass("tap+")

proc report(name: string, ps: seq[Pass], skip = 0) =
  if ps.len <= skip:
    echo name, ": none"
    return
  let ps = ps[skip .. ^1]
  var keys: seq[string]
  for p in ps:
    for k in p.phases.keys:
      if k notin keys: keys.add k
  var line = name & " n=" & $ps.len & " total " & formatFloat(median(ps.mapIt(it.totalMs)), ffDecimal, 2) &
    " collect " & formatFloat(median(ps.mapIt(it.collectMs)), ffDecimal, 2)
  for phase in RenderPhase:
    let k = $phase
    if k in keys:
      line.add " " & k & " " & formatFloat(median(ps.mapIt(it.phases.getOrDefault(k, 0))), ffDecimal, 3)
  echo line

echo "scene ", first["id"].getStr(), " ", width, "x", height, " taps ", taps.len, " rounds ", rounds
report("cold", passes[0 .. 0])
report("warm", passes[1 .. 3])
report("press", pressPasses, skip = taps.len)
report("tap", tapPasses, skip = taps.len)
var sum: uint64 = 1469598103934665603'u64
for b in buffers:
  for v in b:
    sum = (sum xor v.uint64) * 1099511628211'u64
echo "buffers checksum ", sum
echo "send pointerDown ", formatFloat(median(pressSend), ffDecimal, 2), " pointerUp(+handler) ",
  formatFloat(median(upSend), ffDecimal, 2)
