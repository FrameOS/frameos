## The scene store's host on a Linux frame (docs/scene-store.md): the facts a
## JS app reads with `frameos.store()` and the work it asks with
## `frameos.storeAction()` (frameos/scene_store_hooks.nim; the Scene store
## sample scene is that app). The ESP32's twin is embedded/esp32/main/fos_store.c.
##
## - Browsing is the app's own: it fetch()es the cloud store's listing for
##   frames from `url`, the frame's cloud provider (cloud/link_state.nim: the
##   linked one, else cloud.frameos.net).
## - Install, update and remove are asked of the frame's control plane when
##   it has one (`POST …/panel/scenes`: the cloud it is managed by, else its
##   backend), and so are a cloud frame's preview and discard: the plane holds
##   the scene list, and what it pushes or deploys next is all the frame
##   keeps. A frame with no plane, and a backend's frame for a preview (a
##   backend keeps no preview of a Pi), does it itself: the store's scenes go
##   into the frame's own scenes (server/api.nim persistScenesPayload) and
##   the runtime reloads, as after a save on its admin page.
## - What came from the store is each scene's `origin`, read off the scenes
##   on disk (the deployed set and the uploaded one).
## - Which of them the store has a newer version of is the plane's to say
##   (`updates`, asked again when a read finds the answer five minutes old
##   or from another plane, and after a change); a frame with no plane lists
##   none.
##
## Threads: the hooks run on the runner thread and hand the worker values (a
## job: the action, its arguments and the backend's address as strings); the
## worker reads files and the network and hands back values under
## `factsLock`. No ref crosses.

import std/[json, locks, os, strutils, times, uri]
import frameos/types
import frameos/channels
import frameos/config
import frameos/events_gen
import frameos/frame_settings_lock
import frameos/cloud/link_state
import frameos/server/api
from frameos/scenes import UPLOADED_SCENES_JSON_PATH, shownSceneId
import frameos/scene_store_hooks
import frameos/utils/http_client
from frameos/upgrade import installedFrameOSVersion

const
  ScenesMaxBytes = 8 * 1024 * 1024
  AnswerMaxBytes = 8 * 1024
  FetchTimeoutMs = 15_000
  UpdatesFreshSeconds = 5 * 60.0
  ScanEverySeconds = 30.0

type
  Job = object
    action, store, id, name, origin: string
    show: bool ## an install's: show it once it is on the frame
    updates: bool ## a scan's: ask the plane for its updates too
    backendUrl, backendKey: string ## the frame's backend, when it has one

  Origin = object
    id, store: string
    version: int

  StoreFacts = object
    ## What the worker last found, as values.
    busy, error, done: string
    previewStore, previewId, previewName, previewFrom: string
    origins: seq[Origin]
    standalone: bool
    updates: string ## the plane's `updates` list as JSON text; "" not known
    updatesPlane: string ## the plane they are from
    updatesAsked, scanned: float ## when they were last asked for, the scenes read

var
  factsLock: Lock
  facts = StoreFacts()
  asker = "" ## guarded by factsLock: the scene to redraw on news, while it shows
  jobs: Channel[Job]
  worker: Thread[void]
  workerStarted = false

initLock(factsLock)

proc news() =
  {.cast(gcsafe).}:
    var scene = ""
    withLock factsLock:
      scene = asker # a copy: the string is the worker's own from here
    if scene.len > 0 and shownSceneId().string == scene:
      sendEvent(evRender, newJObject(), eoSystem)

# --------------------------------------------------------------- the network

proc storeBase(): string =
  try: providerUrlFromState(loadCloudLinkState())
  except CatchableError: "https://cloud.frameos.net"

proc get(url: string, maxBytes: int): tuple[body, error: string] =
  ## The body when it is JSON the store answered with, else an error code for
  ## the page. A 404 is a store scene that is gone (as main/fos_store.c reads
  ## it).
  try:
    let response = boundedRequestWithHeaders(url, timeoutMs = FetchTimeoutMs, maxBytes = maxBytes, maxRedirects = 2)
    if response.code == 404: return ("", "invalid_scene")
    if response.code == 429: return ("", "rate_limited")
    if response.code != 200: return ("", "store_unavailable")
    discard parseJson(response.body)
    (response.body, "")
  except CatchableError:
    ("", "store_unavailable")

proc cloudPanel*(route: string): tuple[url, token: string] =
  ## A cloud-managed frame's panel route (`scenes`, `code`) and its token;
  ## ("", "") otherwise. The code editor's host asks the same plane.
  try:
    let state = loadCloudLinkState()
    if isManagedLink(state) and state{"frame_id"}.getStr().len > 0:
      return (providerUrlFromState(state) & "/api/frames/" & state{"frame_id"}.getStr() & "/panel/" & route,
        state{"access_token"}.getStr())
  except CatchableError:
    discard

proc cloudPlane(): tuple[url, token: string] = cloudPanel("scenes")

proc askPlane(url, token, action, sceneId: string, show: bool): tuple[error, status, shown, updates: string] =
  ## `updates`: the answer's list of updates as JSON text, when it has one.
  try:
    let response = boundedRequestWithHeaders(url, httpMethod = "POST",
      body = $(%*{"action": action, "scene_id": sceneId, "show": show}),
      headers = @[("Authorization", "Bearer " & token), ("Content-Type", "application/json")],
      timeoutMs = 30_000, maxBytes = AnswerMaxBytes, maxRedirects = 0)
    var answer: JsonNode
    try: answer = parseJson(response.body)
    except CatchableError: answer = newJObject()
    if response.code != 200:
      var code = answer{"error"}.getStr()
      if code.len == 0:
        # A 404 with no word of the plane's is a plane from before the route.
        code = if response.code == 429: "rate_limited"
               elif response.code == 404: "plane_update_required"
               else: "plane_unavailable"
      return (code, "", "", "")
    let updates = answer{"updates"}
    ("", answer{"status"}.getStr(), answer{"scene_id"}.getStr(),
      if not updates.isNil and updates.kind == JArray: $updates else: "")
  except CatchableError:
    # No answer is the plane's silence, not the store's: a plane that could
    # not reach the store says `store_unavailable` itself.
    ("plane_unavailable", "", "", "")

# ----------------------------------------------------------------- the disk

proc originOf(scene: JsonNode): Origin =
  let origin = scene{"origin"}
  result.id = scene{"id"}.getStr()
  result.store = origin{"storeSceneId"}.getStr()
  try: result.version = parseInt(origin{"version"}.getStr())
  except ValueError: result.version = origin{"version"}.getInt(0)

proc readOrigins(): seq[Origin] =
  ## The scenes on the frame from the store: the uploaded set (what a cloud
  ## pushed) first, then the deployed scenes it does not shadow.
  var seen: seq[string]
  var scenes: seq[JsonNode]
  try:
    let uploaded = parseJson(readFile(UPLOADED_SCENES_JSON_PATH))
    for scene in uploaded{"scenes"}.getElems():
      scenes.add scene
  except CatchableError:
    discard
  for scene in loadScenePayload().getElems():
    scenes.add scene
  for scene in scenes:
    let origin = originOf(scene)
    if origin.id.len > 0 and origin.id notin seen:
      seen.add origin.id
      if origin.store.len > 0:
        result.add origin

proc storeScenes(store: string): tuple[scenes: seq[JsonNode], error: string] =
  let (body, error) = get(storeBase() & "/api/store/scenes/" & encodeUrl(store) & "/scenes.json", ScenesMaxBytes)
  if error.len > 0:
    return (@[], error)
  for scene in parseJson(body).getElems():
    if scene.kind == JObject and scene{"id"}.getStr().len > 0 and
        scene{"origin", "storeSceneId"}.getStr().toLowerAscii() == store.toLowerAscii():
      result.scenes.add scene
  if result.scenes.len == 0:
    result.error = "store_unavailable"

proc saveHere*(scenes: JsonNode, show: string) =
  ## The frame's own scenes, as its admin page saves them, and the runtime
  ## reloads them; then `show`. From the runtime itself (`system`), as the
  ## frame page's reload is: the contract lets no panel ask either.
  persistScenesPayload(scenes)
  sendEvent(evReload, newJObject(), eoSystem)
  if show.len > 0:
    sendEvent(evSetCurrentScene, %*{"sceneId": show}, eoSystem)

proc installHere(store: string, show: bool): tuple[error, first: string] =
  let (scenes, error) = storeScenes(store)
  if error.len > 0:
    return (error, "")
  var ids: seq[string]
  for scene in scenes:
    ids.add scene{"id"}.getStr()
  let saved = newJArray()
  for scene in loadScenePayload().getElems():
    let id = scene{"id"}.getStr()
    if id notin ids:
      saved.add scene
    else:
      # Installed again (an update): the values set on the frame stay.
      for fresh in scenes:
        if fresh{"id"}.getStr() == id and scene{"fields"}.getElems().len > 0 and
            fresh{"fields"}.getElems().len > 0:
          for field in fresh["fields"].getElems():
            for old in scene["fields"].getElems():
              if old{"name"}.getStr() == field{"name"}.getStr() and old{"type"} == field{"type"} and
                  old.hasKey("value"):
                field["value"] = old["value"]
  for scene in scenes:
    # The frame's default stays the owner's (json's `delete` raises on a
    # missing key).
    if scene.hasKey("default"):
      scene.delete("default")
    saved.add scene
  saveHere(saved, if show: ids[0] else: "")
  ("", ids[0])

proc removeHere(store, id, show: string): string =
  let saved = newJArray()
  var removed = 0
  for scene in loadScenePayload().getElems():
    let origin = originOf(scene)
    if (store.len > 0 and origin.store == store) or (store.len == 0 and origin.id == id):
      inc removed
    else:
      saved.add scene
  if removed == 0:
    return "scene_not_assigned"
  if saved.len == 0:
    return "last_scene"
  saveHere(saved, show)

# ----------------------------------------------------------------- the work

proc askUpdates(job: Job) =
  ## The plane's list of the store scenes on this frame it has newer
  ## versions of, kept for the facts. Asked by no one: nothing on the page
  ## changes when it cannot be had.
  let cloud = cloudPlane()
  let url = if cloud.url.len > 0: cloud.url
            elif job.backendUrl.len > 0: job.backendUrl & "/api/panel/scenes"
            else: ""
  if url.len == 0:
    return
  let answer = askPlane(url, if cloud.url.len > 0: cloud.token else: job.backendKey, "updates", "", true)
  withLock factsLock:
    facts.updatesAsked = epochTime()
    if answer.updates.len > 0:
      facts.updates = answer.updates
      facts.updatesPlane = url
  if answer.error.len > 0:
    log(%*{"event": "sceneStore:error", "action": "updates", "error": answer.error})

proc work(job: var Job, error, done: var string) =
  ## The job's work. `error` gets a code for the page, `done` what worked.
  var status, previewId: string
  if job.store.len == 0 and job.id.len > 0:
    # A scene on the frame names its store scene by its id: read off the
    # scenes as they are now (a push may have landed since the last read).
    for origin in readOrigins():
      if origin.id == job.id:
        job.store = origin.store
  case job.action
  of "scan":
    done = ""
    if job.updates:
      askUpdates(job)
  else:
    var previewFrom, previewStore: string
    withLock factsLock:
      previewFrom = facts.previewFrom
      previewStore = facts.previewStore
    let
      cloud = cloudPlane()
      local = job.action in ["preview", "discard"]
    if cloud.url.len > 0:
      let answer = askPlane(cloud.url, cloud.token, job.action,
        if job.action == "discard": previewFrom else: job.store, job.show)
      (error, status, previewId) = (answer.error, answer.status, answer.shown)
    elif job.backendUrl.len > 0 and not local:
      let answer = askPlane(job.backendUrl & "/api/panel/scenes", job.backendKey, job.action, job.store, job.show)
      (error, status, previewId) = (answer.error, answer.status, answer.shown)
    else:
      # This frame's own: a frame with no plane, or a backend's preview.
      case job.action
      of "install", "preview", "update":
        # Shown unless the store asks to stay (`show: false`: an install
        # from the shelf, a layout tried, docs/scene-store.md).
        (error, previewId) = installHere(job.store, job.show and job.action in ["preview", "install"])
      of "remove":
        error = removeHere(job.store, job.id, "")
      of "discard":
        error = removeHere(previewStore, "", previewFrom)
      else: discard
    if status == "up_to_date":
      done = "uptodate"
    if error.len == 0:
      withLock factsLock:
        if job.action == "preview":
          facts.previewStore = job.store
          facts.previewId = previewId
          facts.previewName = job.name
          facts.previewFrom = job.origin
        elif job.action == "discard" or facts.previewStore == job.store:
          facts.previewStore = ""
      # What changed the plane's list: its updates are asked for again.
      if job.action in ["install", "update", "updateAll", "remove"]:
        askUpdates(job)

proc run(job: Job): bool {.gcsafe.} =
  ## True when the app has news: what it asked for is done, or a re-read
  ## found other scenes than it shows (one that found the same draws nothing:
  ## on e-paper a render is a refresh).
  {.cast(gcsafe).}:
    var
      job = job
      error = ""
      done = job.action
      updatesBefore = ""
    withLock factsLock:
      updatesBefore = facts.updates
    try:
      work(job, error, done)
    except Exception as e:
      # Nothing that goes wrong here may end the thread (and with it the
      # runtime): the page says it did not work.
      log(%*{"event": "sceneStore:error", "action": job.action, "error": e.msg})
      error = "failed"
    var origins: seq[Origin]
    try:
      origins = readOrigins()
    except Exception:
      discard
    withLock factsLock:
      result = job.action != "scan" or origins != facts.origins or facts.updates != updatesBefore
      facts.origins = origins
      # A re-read is nobody's: what the page says, and a tap waiting behind
      # it, stay as they are.
      if job.action != "scan":
        facts.busy = ""
        facts.error = error
        facts.done = if error.len > 0: "" else: done

proc workerLoop() {.thread.} =
  while true:
    let job = jobs.recv()
    if run(job):
      news()

proc queue(job: sink Job) =
  if not workerStarted:
    jobs.open()
    createThread(worker, workerLoop)
    workerStarted = true
  jobs.send(job)

# ------------------------------------------------------------------ the hooks

var
  hookConfig {.threadvar.}: FrameConfig
  hookGeneration {.threadvar.}: int

proc runnerConfig*(): FrameConfig =
  {.cast(gcsafe).}:
    let generation = currentFrameConfigGeneration()
    if hookConfig.isNil or generation != hookGeneration:
      try:
        hookConfig = readConfig()
        hookGeneration = generation
      except CatchableError:
        discard
    hookConfig

proc backendOf*(config: FrameConfig): tuple[url, key: string] =
  ## The frame's backend, when it has one (and is not cloud-managed).
  if config != nil and config.serverHost.len > 0 and config.serverApiKey.len > 0 and
      config.serverHost notin ["localhost", "127.0.0.1"]:
    let scheme = normalizeServerScheme(config.serverScheme, config.serverPort)
    return (scheme & "://" & config.serverHost & ":" & $config.serverPort, config.serverApiKey)

proc linuxSceneStoreRead*(scene: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      let config = runnerConfig()
      if config == nil or not framePageOffered(config):
        return ""
      var
        f: StoreFacts
        opened = false
      let
        backend = backendOf(config)
        cloud = cloudPlane().url
        planeUrl = if cloud.len > 0: cloud elif backend.url.len > 0: backend.url & "/api/panel/scenes" else: ""
        now = epochTime()
      var ask = false
      withLock factsLock:
        # Opened by another scene: what came from the store is read again (a
        # push may have changed the scenes since), off this thread, at most
        # every half a minute (the frame page reads it too, and on a desktop
        # both show); and the plane's updates once they are five minutes old
        # or another plane's.
        ask = planeUrl.len > 0 and (facts.updatesPlane != planeUrl or now - facts.updatesAsked > UpdatesFreshSeconds)
        opened = facts.busy.len == 0 and (ask or (asker != scene and now - facts.scanned > ScanEverySeconds))
        if opened:
          facts.scanned = now
          if ask:
            facts.updatesAsked = now
            if facts.updatesPlane != planeUrl:
              facts.updates = ""
              facts.updatesPlane = planeUrl
        asker = scene
        f = facts
      if opened:
        queue(Job(action: "scan", updates: ask, backendUrl: backend.url, backendKey: backend.key))
      let installed = newJArray()
      for origin in f.origins:
        installed.add %*{"id": origin.id, "store": origin.store, "v": origin.version}
      var answer = %*{"url": storeBase(), "version": installedFrameOSVersion(), "busy": f.busy,
        "error": f.error, "done": f.done, "installed": installed, "removeAny": planeUrl.len == 0}
      if planeUrl.len > 0 and f.updatesPlane == planeUrl and f.updates.len > 0:
        try: answer["updates"] = parseJson(f.updates)
        except CatchableError: discard
      answer["preview"] = if f.previewStore.len > 0:
        %*{"store": f.previewStore, "id": f.previewId, "name": f.previewName} else: newJNull()
      result = $answer
    except Exception:
      result = ""

proc linuxSceneStoreAction*(scene, action, argsText: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      var args = newJObject()
      try: args = parseJson(argsText)
      except CatchableError: discard
      if args.kind != JObject:
        args = newJObject()
      var job = Job(action: action, store: args{"store"}.getStr(), id: args{"id"}.getStr(),
        name: args{"name"}.getStr(), origin: scene, show: args{"show"}.getBool(true))
      (job.backendUrl, job.backendKey) = backendOf(runnerConfig())
      withLock factsLock:
        asker = scene
        # One thing at a time: the app says what is running.
        if facts.busy.len > 0:
          return
        if action notin ["preview", "install", "update", "updateAll", "remove", "discard"]:
          return
        facts.busy = job.action
        facts.error = ""
        facts.done = ""
      queue(job)
    except Exception:
      discard

proc installSceneStoreHooks*() =
  ## Once, at startup, before the runner draws anything.
  sceneStoreRead = linuxSceneStoreRead
  sceneStoreAction = linuxSceneStoreAction
