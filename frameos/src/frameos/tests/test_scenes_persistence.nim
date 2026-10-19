import std/[json, options, os, tables, unittest]

import ../interpreter
import ../scenes
import ../types

type FileBackup = object
  exists: bool
  content: string

proc backupFile(path: string): FileBackup =
  if fileExists(path):
    FileBackup(exists: true, content: readFile(path))
  else:
    FileBackup(exists: false, content: "")

proc restoreFile(path: string, backup: FileBackup) =
  if backup.exists:
    writeFile(path, backup.content)
  elif fileExists(path):
    removeFile(path)

proc persistedPath(sceneId: SceneId): string =
  "state/scene-" & sanitizePathString(sceneId.string) & ".json"

suite "scene persistence helpers":
  let sceneFile = "state/scene.json"
  let uploadedFile = "state/uploaded.json"
  let sceneFileBackup = backupFile(sceneFile)
  let uploadedFileBackup = backupFile(uploadedFile)

  setup:
    if not dirExists("state"):
      createDir("state")

  teardown:
    restoreFile(sceneFile, sceneFileBackup)
    restoreFile(uploadedFile, uploadedFileBackup)

  test "setPersistedStateFromPayload merges and writes state":
    let sceneId = "test/persist-merge".SceneId
    let path = persistedPath(sceneId)
    if fileExists(path):
      removeFile(path)

    setPersistedStateFromPayload(sceneId, %*{"count": 1, "name": "alpha"})
    setPersistedStateFromPayload(sceneId, %*{"enabled": true})

    check fileExists(path)
    let persisted = loadPersistedState(sceneId)
    check persisted["count"].getInt() == 1
    check persisted["name"].getStr() == "alpha"
    check persisted["enabled"].getBool()

  test "interpreted scenes persist only fields marked for disk":
    let sceneInputs = parseInterpretedSceneInputs($(%*[
      {
        "id": "test/persist-flags",
        "name": "Persistence flags",
        "nodes": [],
        "edges": [],
        "fields": [
          {"name": "diskField", "type": "string", "persist": "disk"},
          {"name": "memoryField", "type": "string", "persist": "memory"},
          {"name": "defaultField", "type": "string"}
        ],
        "settings": {"backgroundColor": "#000000", "refreshInterval": 300.0}
      }
    ]))
    let interpreted = buildInterpretedScenes(sceneInputs)
    let exported = interpreted["test/persist-flags".SceneId]

    # ...plus the implicit refresh interval, which only reaches the disk once
    # it is customized (next test)
    check exported.persistedStateKeys == @["diskField", "refreshInterval"]

  test "an implicit refresh interval persists only once it leaves the scene's default":
    let sceneId = "uploaded/persist-refresh".SceneId
    let path = persistedPath(sceneId)
    let uploadedBackupTable = uploadedScenes
    try:
      if fileExists(path):
        removeFile(path)
      updateUploadedScenes(buildInterpretedScenes(parseInterpretedSceneInputs($(%*[{
        "id": sceneId.string, "name": "Persist refresh", "nodes": [], "edges": [], "fields": [],
        "settings": {"backgroundColor": "#000000", "refreshInterval": 900.0}
      }]))))

      # On the default: nothing to remember, so a later edit of the scene's
      # settings.refreshInterval is not shadowed by a stale file
      let scene = FrameScene(id: sceneId, state: %*{"refreshInterval": 900.0})
      scene.updateLastPersistedState()
      check not fileExists(path)

      scene.state["refreshInterval"] = %60
      scene.updateLastPersistedState()
      check loadPersistedState(sceneId){"refreshInterval"}.getInt() == 60

      # Back on the default: the file goes away again
      scene.state["refreshInterval"] = %"900"
      scene.updateLastPersistedState()
      check not fileExists(path)
    finally:
      updateUploadedScenes(uploadedBackupTable)
      removePersistedState(sceneId)

  test "a declared field persists only once it leaves the scene's default":
    # The Immich/Google Photos sample scenes: `seconds` (persist: disk, 300)
    # and `albumId` (persist: disk, "") were written to disk on the first
    # render while still at their defaults, so "set 10 s in the editor, Save +
    # Deploy" changed nothing on a frame that had rendered the scene once:
    # init seeds from the file before the field defaults.
    let sceneId = "uploaded/persist-defaults".SceneId
    let path = persistedPath(sceneId)
    let uploadedBackupTable = uploadedScenes
    try:
      if fileExists(path):
        removeFile(path)
      updateUploadedScenes(buildInterpretedScenes(parseInterpretedSceneInputs($(%*[{
        "id": sceneId.string, "name": "Persist defaults", "nodes": [], "edges": [],
        "fields": [
          {"name": "mode", "type": "select", "value": "random", "options": ["random", "album"],
           "persist": "disk", "access": "public"},
          {"name": "albumId", "type": "string", "value": "", "persist": "disk", "access": "public"},
          {"name": "seconds", "type": "integer", "value": 300, "role": "refreshInterval",
           "persist": "disk", "access": "public"},
          {"name": "token", "type": "string", "value": "abc", "persist": "disk", "access": "private"},
        ],
        "settings": {"backgroundColor": "#000000", "refreshInterval": 300.0}
      }]))))

      # Everything as seeded: nothing to remember
      let scene = FrameScene(id: sceneId, state: %*{"mode": "random", "albumId": "", "seconds": 300, "token": "abc"})
      scene.updateLastPersistedState()
      check not fileExists(path)

      # A control form moved the album and the interval (numbers arrive as
      # strings); the private field is still on its default
      scene.state["mode"] = %"album"
      scene.state["albumId"] = %"album-1"
      scene.state["seconds"] = %"10"
      scene.updateLastPersistedState()
      let persisted = loadPersistedState(sceneId)
      check persisted == %*{"mode": "album", "albumId": "album-1", "seconds": "10"}

      # Back on the defaults: the file goes away, the next init seeds whatever
      # the editor ships next
      scene.state["mode"] = %"random"
      scene.state["albumId"] = %""
      scene.state["seconds"] = %300
      scene.updateLastPersistedState()
      check not fileExists(path)
    finally:
      updateUploadedScenes(uploadedBackupTable)
      removePersistedState(sceneId)

  test "updateLastPersistedState removes stale keys when fields stop persisting":
    let sceneId = "uploaded/persist-prune".SceneId
    let path = persistedPath(sceneId)
    let uploadedBackupTable = uploadedScenes
    try:
      if fileExists(path):
        removeFile(path)
      writeFile(path, $(%*{"stale": "old"}))
      discard loadPersistedState(sceneId)

      var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
      uploadedOnly[sceneId] = ExportedInterpretedScene(
        name: "Persist Prune",
        publicStateFields: @[],
        persistedStateKeys: @[],
      )
      updateUploadedScenes(uploadedOnly)

      let scene = FrameScene(id: sceneId, state: %*{"stale": "new"})
      scene.updateLastPersistedState()

      check not fileExists(path)
    finally:
      updateUploadedScenes(uploadedBackupTable)
      removePersistedState(sceneId)

  test "load functions safely handle missing and invalid files":
    let missingSceneId = "test/persist-missing".SceneId
    let missingPath = persistedPath(missingSceneId)
    if fileExists(missingPath):
      removeFile(missingPath)

    check loadPersistedState(missingSceneId).kind == JObject
    check loadPersistedState(missingSceneId).len == 0

    writeFile(missingPath, "{invalid json")
    check loadPersistedState(missingSceneId).len == 0

    if fileExists(sceneFile):
      removeFile(sceneFile)
    check loadLastScene().isNone()

    writeFile(sceneFile, "not-json")
    check loadLastScene().isNone()

    writeFile(sceneFile, $(%*{"sceneId": "system/index"}))
    check loadLastScene().isSome()

  test "getFirstSceneId falls back when persisted uploaded scene is missing":
    let missingUploaded = "uploaded/does-not-exist".SceneId
    writeFile(sceneFile, $(%*{"sceneId": missingUploaded.string}))

    let first = getFirstSceneId()
    check first != missingUploaded
    check first.string.len > 0

  test "uploaded payloads record their runtime origin":
    # hub_client stamps source=cloud on the set_scenes verb; a local admin
    # upload carries no source. The stamp keys the post-demotion LAN deny.
    let scenes = %*[{
      "id": "origin-test", "name": "Origin",
      "nodes": [{"id": "1", "type": "app", "data": {"keyword": "data/clock"}}],
      "edges": [],
    }]
    var hookFired = 0
    uploadedScenesChangedHook = proc() {.gcsafe.} = inc hookFired
    defer: uploadedScenesChangedHook = nil

    let (cloudMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes, "source": "cloud"}, persistPayload = true)
    check cloudMain.isSome
    check cloudUploadedScenesResident()
    check hookFired == 1
    # The stamp survives in the persisted payload (what a reboot rehydrates).
    check parseJson(readFile(uploadedFile)){"source"}.getStr("") == "cloud"

    let (localMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes}, persistPayload = false)
    check localMain.isSome
    check not cloudUploadedScenesResident()
    check hookFired == 2

  test "a store stamp on a scene arms nothing; the source does":
    # Until 2026.10.16 a scene stamped with a store id armed the LAN deny on
    # any frame. The deny keys on who installed the payload now (the cloud),
    # never on a stamp in the scene's own JSON.
    let storeScenes = %*[{
      "id": "store-test", "name": "Store scene",
      "origin": {"href": "https://scenes.frameos.net/s/x", "storeSceneId": "11111111-2222-3333-4444-555555555555"},
      "nodes": [], "edges": [],
    }]
    let (storeMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": storeScenes}, persistPayload = false)
    check storeMain.isSome
    check not cloudUploadedScenesResident()

  test "cloud-origin payloads are re-checked for refused apps at load time":
    # The verb dispatcher refuses these at transport time; the load-time
    # re-check covers payloads edited on disk or persisted before a keyword
    # joined the list. Local payloads with the same app still load.
    let scenes = %*[{
      "id": "refused-test", "name": "Refused",
      "nodes": [{"id": "1", "type": "app",
                 "data": {"keyword": "data/chromiumScreenshot"}}],
      "edges": [],
    }]
    let (cloudMain, cloudIds) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes, "source": "cloud"}, persistPayload = false)
    check cloudMain.isNone
    check cloudIds.len == 0
    check not cloudUploadedScenesResident()

    let (localMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes}, persistPayload = false)
    check localMain.isSome

  test "a provider's first push of a scene the frame already ran carries its state":
    # The frame ran "album" on its own; the owner imported it into the cloud,
    # which pushes it back as uploaded/album (`scenes_get`, cloud-frames.md).
    # The provider's copy starts where the frame's copy was, not at defaults.
    let diskId = "carry-album".SceneId
    let uploadedId = "uploaded/carry-album".SceneId
    for sceneId in [diskId, uploadedId]:
      if fileExists(persistedPath(sceneId)):
        removeFile(persistedPath(sceneId))
    writeFile(persistedPath(diskId), $(%*{"index": 7, "albumId": "abc"}))
    defer:
      removePersistedState(uploadedId)
      if fileExists(persistedPath(diskId)):
        removeFile(persistedPath(diskId))
    let scenes = %*[{
      "id": "carry-album", "name": "Album",
      "fields": [{"name": "index", "type": "integer", "persist": "disk"}],
      "nodes": [], "edges": [],
    }]
    # Forget any earlier uploaded set, so carry-album is new to this one.
    discard updateUploadedScenesFromPayload(%*{"scenes": [{
      "id": "carry-other", "name": "Other", "nodes": [], "edges": []}]}, persistPayload = false)

    discard updateUploadedScenesFromPayload(
      %*{"scenes": scenes, "source": "cloud"}, persistPayload = true)
    let carried = loadPersistedState(uploadedId)
    check carried{"index"}.getInt() == 7
    check carried{"albumId"}.getStr() == "abc"
    # The frame's own copy keeps its file.
    check parseJson(readFile(persistedPath(diskId))){"index"}.getInt() == 7

    # A later push of the same set never copies again: the provider's copy
    # has its own state now, defaults included.
    removePersistedState(uploadedId)
    discard updateUploadedScenesFromPayload(
      %*{"scenes": scenes, "source": "cloud"}, persistPayload = true)
    check not fileExists(persistedPath(uploadedId))

  test "local uploads and boot replays do not carry a disk scene's state":
    let diskId = "carry-local".SceneId
    let uploadedId = "uploaded/carry-local".SceneId
    for sceneId in [diskId, uploadedId]:
      if fileExists(persistedPath(sceneId)):
        removeFile(persistedPath(sceneId))
    writeFile(persistedPath(diskId), $(%*{"index": 3}))
    defer:
      removePersistedState(uploadedId)
      if fileExists(persistedPath(diskId)):
        removeFile(persistedPath(diskId))
    let scenes = %*[{"id": "carry-local", "name": "Local", "nodes": [], "edges": []}]
    discard updateUploadedScenesFromPayload(%*{"scenes": [{
      "id": "carry-other", "name": "Other", "nodes": [], "edges": []}]}, persistPayload = false)

    # A local admin upload (no source) and a reboot's replay of a cloud set
    # (persistPayload = false) are not a provider installing the scene.
    discard updateUploadedScenesFromPayload(%*{"scenes": scenes}, persistPayload = true)
    check not fileExists(persistedPath(uploadedId))
    discard updateUploadedScenesFromPayload(%*{"scenes": [{
      "id": "carry-other", "name": "Other", "nodes": [], "edges": []}]}, persistPayload = false)
    discard updateUploadedScenesFromPayload(
      %*{"scenes": scenes, "source": "cloud"}, persistPayload = false)
    check not fileExists(persistedPath(uploadedId))
