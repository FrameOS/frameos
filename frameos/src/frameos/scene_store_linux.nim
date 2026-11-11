## The scene store on a Linux frame's own screen (docs/scene-store-on-frame.md):
## the facts the scene switcher's store pages show (system/sceneSwitcher/
## store.nim) and the work they ask for. The ESP32's twin is
## embedded/esp32/main/fos_store.c.
##
## - Browsing is the cloud store's short listing (/api/store/device/scenes),
##   asked of the frame's cloud provider (cloud/link_state.nim: the linked one,
##   else cloud.frameos.net).
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
##
## Threads: the hooks run on the runner thread and hand the worker values (a
## job: the action, its arguments and the backend's address as strings); the
## worker reads files and the network and hands back values under
## `factsLock`. No ref crosses.

import std/[json, locks, os, strutils, uri]
import frameos/types
import frameos/channels
import frameos/config
import frameos/events_gen
import frameos/frame_settings_lock
import frameos/cloud/link_state
import frameos/server/api
from frameos/scenes import UPLOADED_SCENES_JSON_PATH
import frameos/utils/http_client
from frameos/upgrade import installedFrameOSVersion
import system/sceneSwitcher/scene as sceneSwitcher

const
  ListingMaxBytes = 64 * 1024
  InfoMaxBytes = 8 * 1024
  ScenesMaxBytes = 8 * 1024 * 1024
  AnswerMaxBytes = 8 * 1024
  FetchTimeoutMs = 15_000

type
  Job = object
    action, store, id, name, origin: string
    query, category: string
    page: int
    backendUrl, backendKey: string ## the frame's backend, when it has one

  Origin = object
    id, store: string
    version: int

  StoreFacts = object
    ## What the worker last found, as values.
    busy, error, done: string
    query, category: string
    page: int
    listing, info: string ## the store's answers as they came ("" for none)
    infoId: string
    previewStore, previewId, previewName, previewFrom: string
    origins: seq[Origin]
    standalone: bool

var
  factsLock: Lock
  facts = StoreFacts(page: 1)
  shown = false ## guarded by factsLock: redraw on news only while the switcher shows
  jobs: Channel[Job]
  worker: Thread[void]
  workerStarted = false

initLock(factsLock)

proc news() =
  var open = false
  withLock factsLock:
    open = shown
  if open:
    sendEvent(evRender, newJObject(), eoSystem)

# --------------------------------------------------------------- the network

proc storeBase(): string =
  try: providerUrlFromState(loadCloudLinkState())
  except CatchableError: "https://cloud.frameos.net"

proc get(url: string, maxBytes: int): tuple[body, error: string] =
  ## The body when it is JSON the store answered with, else an error code for
  ## the page.
  try:
    let response = boundedRequestWithHeaders(url, timeoutMs = FetchTimeoutMs, maxBytes = maxBytes, maxRedirects = 2)
    if response.code == 404: return ("", "invalid_scene")
    if response.code == 429: return ("", "rate_limited")
    if response.code != 200: return ("", "store_unavailable")
    discard parseJson(response.body)
    (response.body, "")
  except CatchableError:
    ("", "store_unavailable")

proc cloudPlane(): tuple[url, token: string] =
  ## A cloud-managed frame's panel route and its token; ("", "") otherwise.
  try:
    let state = loadCloudLinkState()
    if isManagedLink(state) and state{"frame_id"}.getStr().len > 0:
      return (providerUrlFromState(state) & "/api/frames/" & state{"frame_id"}.getStr() & "/panel/scenes",
        state{"access_token"}.getStr())
  except CatchableError:
    discard

proc askPlane(url, token, action, sceneId: string): tuple[error, status, shown: string] =
  try:
    let response = boundedRequestWithHeaders(url, httpMethod = "POST",
      body = $(%*{"action": action, "scene_id": sceneId}),
      headers = @[("Authorization", "Bearer " & token), ("Content-Type", "application/json")],
      timeoutMs = 30_000, maxBytes = AnswerMaxBytes, maxRedirects = 0)
    var answer: JsonNode
    try: answer = parseJson(response.body)
    except CatchableError: answer = newJObject()
    if response.code != 200:
      var code = answer{"error"}.getStr()
      if code.len == 0:
        code = if response.code == 429: "rate_limited" else: "store_unavailable"
      return (code, "", "")
    ("", answer{"status"}.getStr(), answer{"scene_id"}.getStr())
  except CatchableError:
    ("store_unavailable", "", "")

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

proc saveHere(scenes: JsonNode, show: string) =
  ## The frame's own scenes, as its admin page saves them, and the runtime
  ## reloads them; then `show`.
  persistScenesPayload(scenes)
  sendEvent(evReload, newJObject(), eoPanel)
  if show.len > 0:
    sendEvent(evSetCurrentScene, %*{"sceneId": show}, eoPanel)

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
        if fresh{"id"}.getStr() == id and not scene{"fields"}.isNil and fresh{"fields"}.kind == JArray:
          for field in fresh["fields"].getElems():
            for old in scene["fields"].getElems():
              if old{"name"}.getStr() == field{"name"}.getStr() and old{"type"} == field{"type"} and
                  old.hasKey("value"):
                field["value"] = old["value"]
  for scene in scenes:
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

proc run(job: Job) {.gcsafe.} =
  {.cast(gcsafe).}:
    var
      error = ""
      done = job.action
      status, previewId: string
    case job.action
    of "browse":
      var url = storeBase() & "/api/store/device/scenes?categories=1&page=" & $job.page & "&version=" &
        encodeUrl(installedFrameOSVersion()) & "&q=" & encodeUrl(job.query) & "&category=" & encodeUrl(job.category)
      let (body, failed) = get(url, ListingMaxBytes)
      error = failed
      done = ""
      if failed.len == 0:
        withLock factsLock:
          facts.listing = body
    of "info":
      let (body, failed) = get(storeBase() & "/api/store/device/scenes/" & encodeUrl(job.store), InfoMaxBytes)
      error = failed
      done = ""
      if failed.len == 0:
        withLock factsLock:
          facts.info = body
    of "scan":
      done = ""
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
          if job.action == "discard": previewFrom else: job.store)
        (error, status, previewId) = answer
      elif job.backendUrl.len > 0 and not local:
        let answer = askPlane(job.backendUrl & "/api/panel/scenes", job.backendKey, job.action, job.store)
        (error, status, previewId) = answer
      else:
        # This frame's own: a frame with no plane, or a backend's preview.
        case job.action
        of "install", "preview", "update":
          (error, previewId) = installHere(job.store, job.action != "update")
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
    let origins = readOrigins()
    withLock factsLock:
      facts.origins = origins
      facts.busy = ""
      facts.error = error
      facts.done = if error.len > 0: "" else: done

proc workerLoop() {.thread.} =
  while true:
    let job = jobs.recv()
    run(job)
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

proc runnerConfig(): FrameConfig =
  {.cast(gcsafe).}:
    let generation = currentFrameConfigGeneration()
    if hookConfig.isNil or generation != hookGeneration:
      try:
        hookConfig = readConfig()
        hookGeneration = generation
      except CatchableError:
        discard
    hookConfig

proc backendOf(config: FrameConfig): tuple[url, key: string] =
  ## The frame's backend, when it has one (and is not cloud-managed).
  if config != nil and config.serverHost.len > 0 and config.serverApiKey.len > 0 and
      config.serverHost notin ["localhost", "127.0.0.1"]:
    let scheme = normalizeServerScheme(config.serverScheme, config.serverPort)
    return (scheme & "://" & config.serverHost & ":" & $config.serverPort, config.serverApiKey)

proc linuxSceneStoreRead*(): JsonNode {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      let config = runnerConfig()
      if config == nil or not framePageOffered(config):
        return nil
      var f: StoreFacts
      withLock factsLock:
        shown = true
        f = facts
      let installed = newJArray()
      for origin in f.origins:
        installed.add %*{"id": origin.id, "store": origin.store, "v": origin.version}
      result = %*{"busy": f.busy, "error": f.error, "done": f.done, "query": f.query,
        "category": f.category, "page": f.page, "installed": installed,
        "removeAny": cloudPlane().url.len == 0 and backendOf(config).url.len == 0,
        "listing": (if f.listing.len > 0: parseJson(f.listing) else: newJNull()),
        "info": {"id": f.infoId, "scene": (if f.info.len > 0: parseJson(f.info) else: newJNull())}}
      result["preview"] = if f.previewStore.len > 0:
        %*{"store": f.previewStore, "id": f.previewId, "name": f.previewName} else: newJNull()
    except Exception:
      result = nil

proc linuxSceneStoreAction*(action: string, args: JsonNode) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      if action == "close":
        withLock factsLock:
          shown = false
        return
      var job = Job(action: action, store: args{"store"}.getStr(), id: args{"id"}.getStr(),
        name: args{"name"}.getStr(), origin: args{"from"}.getStr())
      (job.backendUrl, job.backendKey) = backendOf(runnerConfig())
      withLock factsLock:
        shown = true
        # One thing at a time: the page says what is running.
        if facts.busy.len > 0:
          return
        # A scene on the frame names its store scene by its id.
        if job.store.len == 0 and job.id.len > 0:
          for origin in facts.origins:
            if origin.id == job.id:
              job.store = origin.store
        case action
        of "open":
          if facts.listing.len > 0:
            job.action = "scan"
          else:
            job.action = "browse"
        of "browse":
          if args.hasKey("q"): facts.query = args{"q"}.getStr()
          if args.hasKey("category"): facts.category = args{"category"}.getStr()
          if args.hasKey("page"):
            try: facts.page = max(1, parseInt(args{"page"}.getStr()))
            except ValueError: facts.page = 1
        of "info":
          facts.infoId = job.id
          facts.info = ""
          if job.store.len == 0:
            return # not from the store: nothing to ask
        of "preview", "install", "update", "remove", "discard": discard
        else: return
        job.query = facts.query
        job.category = facts.category
        job.page = facts.page
        if job.action != "scan":
          facts.busy = job.action
          facts.error = ""
          facts.done = ""
      queue(job)
    except Exception:
      discard

proc installSceneStoreHooks*() =
  ## Once, at startup, before the runner draws anything.
  sceneSwitcher.sceneStoreRead = linuxSceneStoreRead
  sceneSwitcher.sceneStoreAction = linuxSceneStoreAction
