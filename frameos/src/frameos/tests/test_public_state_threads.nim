import std/[atomics, json, tables, unittest]
import frameos/types
import frameos/scenes

# The HTTP workers' view of the scene registry (`/image`, `/state`, `/c`, the
# admin API's frame payload) — see publicStateFieldValues in scenes.nim.
#
# getLastPublicState() used to return the runner's own StateField refs, and
# took an owning copy of the ExportedScene to reach them. Four threads doing
# that segfaulted inside a second, every run, when built the way the Pi
# binary is (`-d:useMalloc`; with `MallocScribble=1` on macOS). One thread
# passes on the old code, which is what makes it this class of bug and not a
# logic error.

suite "Public scene state across threads":
  test "four threads read the public state without sharing the runner's refs":
    var target = "".SceneId
    for id, scene in exportedScenes:
      if target.string.len == 0 or scene.publicStateFields.len > 0:
        target = id
      if scene.publicStateFields.len > 0:
        break
    require target.string.len > 0
    if exportedScenes[target].publicStateFields.len == 0:
      exportedScenes[target].publicStateFields = @[
        StateField(name: "a", label: "A", fieldType: "string", value: %"x", showIf: %*[{"field": "b"}]),
        StateField(name: "b", label: "B", fieldType: "select", value: %"y",
          options: @[StateFieldOption(value: "y", label: "Yes")]),
      ]
      refreshExportedScenes()
    setLastPublicSceneId(target)
    let expectedFields = exportedScenes[target].publicStateFields.len

    var bad: Atomic[int]
    var expected: Atomic[int]
    expected.store(expectedFields)
    proc worker(args: tuple[bad, expected: ptr Atomic[int]]) {.thread.} =
      {.cast(gcsafe).}:
        let wanted = args.expected[].load
        for i in 0 ..< 100_000:
          let (sceneId, state, fields, _) = getLastPublicState()
          if fields.len != wanted or fields[0].name.len == 0 or sceneId.string.len == 0 or state == nil:
            discard args.bad[].fetchAdd(1)
          let (plainId, _, _) = getLastPublicSceneState()
          if plainId != sceneId:
            discard args.bad[].fetchAdd(1)
          # Allocation churn: a freed node's chunk has to be reused for a
          # premature free to show.
          let junk = parseJson("""{"a":[1,2,3],"b":{"c":"dddddddddddddddd"}}""")
          if junk{"a"}.len != 3:
            discard args.bad[].fetchAdd(1000)
    var threads: array[4, Thread[tuple[bad, expected: ptr Atomic[int]]]]
    for t in threads.mitems: createThread(t, worker, (addr bad, addr expected))
    joinThreads(threads)
    check bad.load == 0

    # The copies are the caller's own: changing one changes nothing else.
    let (_, _, mine, _) = getLastPublicState()
    mine[0].name = "changed"
    let (_, _, again, _) = getLastPublicState()
    check again[0].name != "changed"
    check exportedScenes[target].publicStateFields[0].name != "changed"

    # What a scene reload does next: the runner drops the old table. With a
    # scene still sitting in a worker's cycle roots this is where it crashed.
    refreshExportedScenes()
    GC_fullCollect()

  test "the snapshot follows a republished scene table":
    var target = "".SceneId
    for id, scene in exportedScenes:
      if scene.publicStateFields.len > 0:
        target = id
        break
    require target.string.len > 0
    setLastPublicSceneId(target)
    let original = exportedScenes[target].publicStateFields
    exportedScenes[target].publicStateFields = @[StateField(name: "only", fieldType: "string")]
    refreshExportedScenes()
    let (_, _, fields, _) = getLastPublicState()
    check fields.len == 1
    check fields[0].name == "only"
    check fields[0].value.isNil
    exportedScenes[target].publicStateFields = original
    refreshExportedScenes()
    check publicStateFieldsCopy(target).len == original.len
