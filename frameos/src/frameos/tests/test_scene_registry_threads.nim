import std/[json, options, tables, unittest]
import frameos/types
import frameos/scenes

# The scene registry's exports cross threads by design: the first generation
# is built on the main thread (module init), every reload's on the runner,
# and a reload's retired generation is let go on the runner when the frame
# has drawn twice since (`reclaimRetiredExportedScenes`).
#
# ORC keeps a cyclic ref's cycle candidates per thread, and a candidate
# remembers its place in its thread's list. An export the main thread had
# made a candidate and the runner then destroyed was taken out of the
# RUNNER's list at the main thread's place: a write into whatever the runner
# kept there (or past its end), and a freed object left in the main thread's
# list. A Pi Zero died with SIGSEGV a second or two after its backend's second
# settings push, at the first reclaim of the generation it booted with (the
# hardware bench, 2026-11-24). The exports are acyclic now, and so is the
# graph they hold (DiagramNode, DiagramEdge), so no thread ever keeps them as
# candidates. Here a fresh thread (no candidates of its own: on
# the old types its list is nil) does the runner's part.

proc makeCandidate(scene: ExportedScene) {.noinline.} =
  ## Takes a reference and gives it back while the registry still holds one:
  ## on a cyclic type, that makes the object a cycle candidate of THIS thread.
  var held = scene
  held = nil

proc makeNodeCandidate(node: DiagramNode) {.noinline.} =
  var held = node
  held = nil

proc makeEdgeCandidate(edge: DiagramEdge) {.noinline.} =
  var held = edge
  held = nil

proc mainThreadGeneration() {.noinline.} =
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for index in 0 ..< 8:
    let id = SceneId("tests/registry/scene-" & $index)
    uploaded[id] = ExportedInterpretedScene(
      name: "Scene " & $index,
      publicStateFields: @[StateField(name: "a", label: "A", fieldType: "string", value: %"x")],
      persistedStateKeys: @[],
      apps: %*{},
      nodes: @[DiagramNode(id: NodeId(1), nodeType: "event", data: %*{"keyword": "render"}),
               DiagramNode(id: NodeId(2), nodeType: "app", data: %*{"keyword": "jsxUi"})],
      edges: @[DiagramEdge(id: NodeId(3), source: NodeId(1), target: NodeId(2), sourceHandle: "next",
                           targetHandle: "prev", edgeType: "appNodeEdge", data: %*{})],
    )
  updateUploadedScenes(uploaded)
  for id in uploaded.keys:
    let scene = findExportedScene(id).get()
    makeCandidate(scene)
    # What the export holds goes with it: the graph of a scene the main
    # thread read at boot (155 nodes and edges on a Pi 5) was let go on the
    # runner at the same reclaim, and crashed it the same way after the
    # bench's second desktop push (2026-11-25, the release 2026.11.15).
    let interpreted = ExportedInterpretedScene(scene)
    for node in interpreted.nodes:
      makeNodeCandidate(node)
    for edge in interpreted.edges:
      makeEdgeCandidate(edge)

proc reloadTwiceAndReclaim() {.thread.} =
  {.cast(gcsafe).}:
    # The runner's part: two reloads, then the reclaim after a render. The
    # main thread's generation goes, its exports with it.
    updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())
    updateUploadedScenes(initTable[SceneId, ExportedInterpretedScene]())
    reclaimRetiredExportedScenes(currentExportedScenesGeneration())

suite "Scene registry across threads":
  test "a generation built on one thread is let go on another":
    mainThreadGeneration()
    var thread: Thread[void]
    createThread(thread, reloadTwiceAndReclaim)
    joinThread(thread)
    check not hasExportedScene(SceneId("tests/registry/scene-0"))
    # The main thread's own cycle collection finds nothing it may not touch.
    GC_fullCollect()
    check true

  test "the graph an export holds is never a cycle candidate":
    # The property the crash came from, measured where ORC keeps it: a thread
    # that takes a reference to a node or an edge and gives it back while
    # the export still holds one must not file it in its candidates (this
    # thread's list is `GC_prepareOrc()` long). The main thread filed 155 of
    # a Pi 5's nodes and edges at boot, the runner freed them at its second
    # reload, and the runner's list was written at the main thread's places.
    var holders: seq[ExportedInterpretedScene]
    for index in 0 ..< 4:
      holders.add ExportedInterpretedScene(
        name: "Graph " & $index, apps: %*{},
        nodes: @[DiagramNode(id: NodeId(index), nodeType: "app", data: %*{"keyword": "jsxUi"})],
        edges: @[DiagramEdge(id: NodeId(index + 10), source: NodeId(index), target: NodeId(index),
                             edgeType: "appNodeEdge", data: %*{})],
      )
    var copies: seq[DiagramNode]
    var edgeCopies: seq[DiagramEdge]
    for holder in holders:
      copies.add holder.nodes[0]      # a copy, as a scene's graph is copied
      edgeCopies.add holder.edges[0]  # while a generation is built
    GC_fullCollect()
    let before = GC_prepareOrc()
    for holder in holders:
      makeNodeCandidate(holder.nodes[0])
      makeEdgeCandidate(holder.edges[0])
    copies.setLen(0)
    edgeCopies.setLen(0)
    check GC_prepareOrc() == before
