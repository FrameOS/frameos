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
    let sceneId = "test/persist-refresh".SceneId
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
    let sceneId = "test/persist-defaults".SceneId
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
    let sceneId = "test/persist-prune".SceneId
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

  test "getFirstSceneId falls back when the last scene is gone":
    let missing = "does-not-exist".SceneId
    writeFile(sceneFile, $(%*{"sceneId": missing.string}))

    let first = getFirstSceneId()
    check first != missing
    check first.string.len > 0

  test "the frame starts where it left off, not on the registry's default":
    # A release binary's registry names its placeholder "default" as the
    # default scene; until 2026.10.18 that came before the last scene shown,
    # so every reboot landed on the placeholder.
    discard updateUploadedScenesFromPayload(%*{"scenes": [{
      "id": "boot-last", "name": "Boot last", "nodes": [], "edges": []}]}, persistPayload = false)
    writeFile(sceneFile, $(%*{"sceneId": "boot-last"}))
    check getFirstSceneId() == "boot-last".SceneId
    # What a runtime before 2026.10.18 wrote names the same scene.
    writeFile(sceneFile, $(%*{"sceneId": "uploaded/boot-last"}))
    check getFirstSceneId() == "boot-last".SceneId

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

  test "an uploaded scene keeps the deployed scene's state, under the one id":
    let sceneId = "shared-album".SceneId
    writeFile(persistedPath(sceneId), $(%*{"index": 7}))
    let deployedBackup = interpretedScenes
    defer:
      interpretedScenes = deployedBackup
      refreshExportedScenes()
      removePersistedState(sceneId)
    interpretedScenes[sceneId] = ExportedInterpretedScene(name: "Deployed album")
    refreshExportedScenes()

    let (main, _) = updateUploadedScenesFromPayload(%*{"scenes": [{
      "id": "shared-album", "name": "Uploaded album", "nodes": [], "edges": []}],
      "source": "cloud"}, persistPayload = false)
    check main == some(sceneId)
    check getSceneDisplayName(sceneId).get() == "Uploaded album"
    check loadPersistedState(sceneId){"index"}.getInt() == 7

    # Replaced by another set, the deployed scene is back, with its state.
    discard updateUploadedScenesFromPayload(%*{"scenes": [{
      "id": "other", "name": "Other", "nodes": [], "edges": []}]}, persistPayload = false)
    check getSceneDisplayName(sceneId).get() == "Deployed album"
    check fileExists(persistedPath(sceneId))

    # A scene the frame no longer holds at all loses its state.
    writeFile(persistedPath("other".SceneId), $(%*{"index": 1}))
    discard updateUploadedScenesFromPayload(%*{"scenes": [{
      "id": "third", "name": "Third", "nodes": [], "edges": []}]}, persistPayload = false)
    check not fileExists(persistedPath("other".SceneId))

  test "a deploy after an upload wins the ids they share":
    let deployedBackup = interpretedScenes
    defer:
      interpretedScenes = deployedBackup
      refreshExportedScenes()
      setDeployedScenesFingerprintForTest("")
    interpretedScenes["shared".SceneId] = ExportedInterpretedScene(name: "Deployed")
    refreshExportedScenes()
    setDeployedScenesFingerprintForTest("before")
    discard updateUploadedScenesFromPayload(%*{"scenes": [
      {"id": "shared", "name": "Preview", "nodes": [], "edges": []},
      {"id": "extra", "name": "Extra", "nodes": [], "edges": []}]}, persistPayload = true)
    check parseJson(readFile(uploadedFile)){"deployedScenes"}.getStr() == "before"
    check getSceneDisplayName("shared".SceneId).get() == "Preview"

    # Read again with the same deployed scenes (a reload, an upgrade's copy):
    # the upload stands.
    applyDeployToUploads()
    check getSceneDisplayName("shared".SceneId).get() == "Preview"

    # A deploy changed them: the deployed copy shows; the rest of the upload
    # stays, and the file says which deploy it now sits on.
    setDeployedScenesFingerprintForTest("after")
    applyDeployToUploads()
    check getSceneDisplayName("shared".SceneId).get() == "Deployed"
    check getSceneDisplayName("extra".SceneId).get() == "Extra"
    let persisted = parseJson(readFile(uploadedFile))
    check persisted{"deployedScenes"}.getStr() == "after"
    check persisted["scenes"].len == 1

    # One that replaces everything uploaded clears the upload.
    interpretedScenes["extra".SceneId] = ExportedInterpretedScene(name: "Deployed extra")
    refreshExportedScenes()
    setDeployedScenesFingerprintForTest("later")
    applyDeployToUploads()
    check getSceneDisplayName("extra".SceneId).get() == "Deployed extra"
    check not fileExists(uploadedFile)
    check not cloudUploadedScenesResident()

  test "an upload an older runtime saved is kept, and gets its deploy noted":
    setDeployedScenesFingerprintForTest("current")
    defer: setDeployedScenesFingerprintForTest("")
    writeFile(uploadedFile, $(%*{"scenes": [
      {"id": "old-upload", "name": "Old upload", "nodes": [], "edges": []}]}))
    applyDeployToUploads()
    check hasExportedScene("old-upload".SceneId)
    check parseJson(readFile(uploadedFile)){"deployedScenes"}.getStr() == "current"
