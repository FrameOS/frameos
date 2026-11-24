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
# hardware bench, 2026-11-24). The exports are acyclic now, so no thread ever
# keeps them as candidates. Here a fresh thread (no candidates of its own: on
# the old types its list is nil) does the runner's part.

proc makeCandidate(scene: ExportedScene) {.noinline.} =
  ## Takes a reference and gives it back while the registry still holds one:
  ## on a cyclic type, that makes the object a cycle candidate of THIS thread.
  var held = scene
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
    )
  updateUploadedScenes(uploaded)
  for id in uploaded.keys:
    makeCandidate(findExportedScene(id).get())

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
