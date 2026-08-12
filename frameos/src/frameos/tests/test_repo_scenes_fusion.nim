import std/[json, os, sets, strutils, tables]
import pixie
import ../interpreter
import ../js_runtime/app_runtime
import ../planner
import ../types

# An inventory of every image edge in every scene the repo ships, and what the
# planner decided about it.
#
# The point is to keep "do the scenes we actually ship work well in this
# system" a question with a data answer rather than an opinion. Each refusal is
# either a rule doing its job (a cached consumer, a blend that would change the
# pixels) or a gap worth closing generally — and the difference is only visible
# when you can see all of them at once.
#
# Run with FRAMEOS_FUSION_INVENTORY=1 to print the table.

const SamplesDir = "../repo/scenes/samples"

let verbose = getEnv("FRAMEOS_FUSION_INVENTORY") == "1"

proc testConfig(): FrameConfig =
  FrameConfig(
    name: "inventory", mode: "embedded", width: 800, height: 480, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) = discard payload
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

type Row = object
  scene: string
  keyword: string
  refusal: FusionRefusal
  blockedKeyword: string
  tier: string

var rows: seq[Row] = @[]
var scenesSeen = 0

# The same predicate the interpreter passes: a node whose behaviour comes from
# scene JSON is a JS app, and JS apps are natural-size producers.
var plannedScene: InterpretedFrameScene
proc dynamicJsAt(nodeId: NodeId): bool {.gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    plannedScene.appsByNodeId.getOrDefault(nodeId, nil).isDynamicJsApp()

for scenesPath in walkDirRec(SamplesDir):
  if scenesPath.splitPath().tail != "scenes.json":
    continue
  let templateName = scenesPath.parentDir().splitPath().tail
  var inputs: seq[FrameSceneInput]
  try:
    inputs = parseInterpretedSceneInputs(readFile(scenesPath))
  except CatchableError:
    continue
  if inputs.len == 0:
    continue

  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for id, exported in buildInterpretedScenes(inputs):
    uploaded[id] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  for sceneInput in inputs:
    let config = testConfig()
    var scene: InterpretedFrameScene
    try:
      scene = InterpretedFrameScene(init(sceneInput.id, config, testLogger(config), %*{}))
    except CatchableError:
      continue
    scenesSeen += 1
    let label = templateName & "/" & sceneInput.name

    var diagnoses: seq[EdgeDiagnosis] = @[]
    plannedScene = scene
    scene.planImageFusion(dynamicJsAt, addr diagnoses)
    for d in diagnoses:
      var tier = "-"
      if scene.imageFusionPlans.hasKey(d.nodeId):
        let plan = scene.imageFusionPlans[d.nodeId]
        tier = (if plan.tier == iftLiveCanvas: "liveCanvas" else: "ownedScratch")
        if plan.ownedForCache: tier &= "(cache)"
      rows.add(Row(scene: label, keyword: d.keyword, refusal: d.refusal,
                   blockedKeyword: d.blockedKeyword, tier: tier))

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

var byRefusal = initTable[string, int]()
var blockedBy = initTable[string, int]()
for row in rows:
  byRefusal.mgetOrPut($row.refusal, 0) += 1
  if row.refusal == frChainOpaque and row.blockedKeyword.len > 0:
    blockedBy.mgetOrPut(row.blockedKeyword, 0) += 1

if verbose:
  echo "\n", "scene".alignLeft(44), "consumer".alignLeft(14), "tier".alignLeft(20), "why"
  echo repeat('-', 120)
  for row in rows:
    let why =
      if row.refusal == frFused: ""
      elif row.blockedKeyword.len > 0: $row.refusal & " (" & row.blockedKeyword & ")"
      else: $row.refusal
    echo row.scene.alignLeft(44), row.keyword.alignLeft(14), row.tier.alignLeft(20), why
  echo ""
  for reason, count in byRefusal:
    echo count, "\t", reason
  if blockedBy.len > 0:
    echo "\nchains blocked at:"
    for keyword, count in blockedBy:
      echo "  ", count, "\t", keyword

echo "test_repo_scenes_fusion: ", scenesSeen, " scenes, ", rows.len,
  " image edges, ", byRefusal.getOrDefault($frFused, 0), " fused"

doAssert scenesSeen > 10, "expected the repo sample scenes to load"
doAssert rows.len > 0, "no image edges found — did render/image lose its capability?"

# A refusal that nobody can explain is a bug. These are the ones the design
# says are correct; anything else appearing here means either a new rule was
# added without being written down, or a scene shape regressed.
const explainedRefusals = [
  frFused,           # nothing to explain
  frConsumerCached,  # a cached render cannot own the canvas it draws onto
  frChainOpaque,     # JS apps, code nodes, child scenes, split cells
  frFieldSet,        # inputImage set: the node composites onto something else
  frFitUnsupported,  # a placement no producer in the chain accepts
  frNoCommonFit,     # producer and consumer agree on no fit
  frStaticFieldWired, # offsets/blend wired to something unresolvable
  frInputUnwired,    # nothing feeds the image input
]
for row in rows:
  doAssert row.refusal in explainedRefusals,
    row.scene & " / " & row.keyword & ": unexplained refusal " & $row.refusal
