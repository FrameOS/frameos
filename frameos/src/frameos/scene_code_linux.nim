## The code editor's host on a Linux frame (docs/code-editor.md): what a JS app
## reads and asks with `frameos.code(op, arg)` (frameos/scene_code_hooks.nim;
## the Code editor sample scene is that app). The ESP32's twin is
## embedded/esp32/main/fos_code.c.
##
## - A scene's source is read off the scenes on disk: the uploaded set (what a
##   cloud or the editor pushed) first, then the deployed scenes.
## - `ask` and a save go to the frame's control plane when it has one (`POST
##   …/panel/code`: the cloud it is managed by, else its backend): the plane
##   has the AI and holds the scene list. A frame with no plane saves into its
##   own scenes, as the scene store installs there (scene_store_linux.nim
##   saveHere), and has no AI to ask.
##
## Threads: the hooks run on the runner thread and hand the worker values (a
## job of strings); the worker does the network and the disk and hands back
## values under `codeLock`. No ref crosses.

import std/[json, locks, strutils]
import frameos/types
import frameos/channels
import frameos/events_gen
import frameos/frame_settings_lock
import frameos/server/api
from frameos/scenes import UPLOADED_SCENES_JSON_PATH, shownSceneId
import frameos/scene_code_hooks
import frameos/scene_store_linux
import frameos/utils/http_client

const
  AnswerMaxBytes = 8 * 1024 * 1024
  AskTimeoutMs = 180_000 ## the plane's AI takes up to two minutes, renders included
  SaveTimeoutMs = 30_000

type
  Job = object
    action, args: string
    backendUrl, backendKey: string ## the frame's backend, when it has one

  CodeFacts = object
    busy, error, done: string
    draft: string ## the AI's last scene, its JSON text
    draftId, draftName, summary: string

var
  codeLock: Lock
  facts = CodeFacts()
  asker = "" ## guarded by codeLock: the scene to redraw on news, while it shows
  jobs: Channel[Job]
  worker: Thread[void]
  workerStarted = false

initLock(codeLock)

proc news() =
  {.cast(gcsafe).}:
    var scene = ""
    withLock codeLock:
      scene = asker
    if scene.len > 0 and shownSceneId().string == scene:
      sendEvent(evRender, newJObject(), eoSystem)

# ----------------------------------------------------------------- the disk

proc heldScenes(): seq[JsonNode] =
  ## Every scene on the frame: the uploaded set first, then the deployed ones.
  try:
    let uploaded = parseJson(readFile(UPLOADED_SCENES_JSON_PATH))
    for scene in uploaded{"scenes"}.getElems():
      result.add scene
  except CatchableError:
    discard
  for scene in loadScenePayload().getElems():
    result.add scene

proc sceneText*(id: string): string =
  ## The scene of that id as the frame holds it, "" without one.
  if id.len == 0:
    return ""
  for scene in heldScenes():
    if scene.kind == JObject and scene{"id"}.getStr() == id:
      return $scene

proc saveHereCode*(scene: JsonNode, show: bool): string =
  ## Into the frame's own scenes, replacing one of its id: its default mark,
  ## button map and layout stay, as a plane keeps them. "" or a refusal code.
  let id = scene{"id"}.getStr()
  let saved = newJArray()
  var replaced = false
  for held in loadScenePayload().getElems():
    if held{"id"}.getStr() == id and not replaced:
      replaced = true
      for key in ["default", "eventMap", "layout", "origin"]:
        if held.hasKey(key) and not scene.hasKey(key):
          scene[key] = held[key]
      saved.add scene
    else:
      saved.add held
  if not replaced:
    if scene.hasKey("default"):
      scene.delete("default")
    saved.add scene
  saveHere(saved, if show: id else: "")

proc refusal*(scene: JsonNode): string =
  ## What no host saves, plane or not (docs/code-editor.md): "" when it may.
  if scene.isNil or scene.kind != JObject or scene{"id"}.getStr().len == 0 or
      scene{"id"}.getStr().len > 128:
    return "invalid_scene"
  if scene{"id"}.getStr().startsWith("system/"):
    return "invalid_scene"
  let execution = scene{"settings", "execution"}.getStr("interpreted")
  if execution != "interpreted":
    return "scene_requires_compilation"

# --------------------------------------------------------------- the network

proc askPlane(url, token, body: string, timeoutMs: int): tuple[error: string, answer: JsonNode] =
  try:
    let response = boundedRequestWithHeaders(url, httpMethod = "POST", body = body,
      headers = @[("Authorization", "Bearer " & token), ("Content-Type", "application/json")],
      timeoutMs = timeoutMs, maxBytes = AnswerMaxBytes, maxRedirects = 0)
    var answer: JsonNode
    try: answer = parseJson(response.body)
    except CatchableError: answer = newJObject()
    if answer.kind != JObject:
      answer = newJObject()
    if response.code != 200 or not answer{"ok"}.getBool(false):
      var code = answer{"error"}.getStr()
      if code.len == 0:
        # A 404 with no word of the plane's is a plane from before the route.
        code = if response.code == 429: "rate_limited"
               elif response.code == 404: "plane_update_required"
               else: "plane_unavailable"
      return (code, answer)
    ("", answer)
  except CatchableError:
    ("plane_unavailable", newJObject())

# ----------------------------------------------------------------- the work

proc work(job: Job, error: var string) =
  var args = newJObject()
  try: args = parseJson(job.args)
  except CatchableError: discard
  if args.kind != JObject:
    args = newJObject()
  var plane = cloudPanel("code")
  if plane.url.len == 0 and job.backendUrl.len > 0:
    plane = (job.backendUrl & "/api/panel/code", job.backendKey)
  case job.action
  of "ask":
    if plane.url.len == 0:
      error = "no_plane"
      return
    let prompt = args{"prompt"}.getStr().strip()
    if prompt.len == 0:
      error = "empty_prompt"
      return
    let body = %*{"action": "ask", "prompt": prompt}
    if args{"scene"} != nil and args{"scene"}.kind == JObject:
      body["scene"] = args["scene"]
    let (refused, answer) = askPlane(plane.url, plane.token, $body, AskTimeoutMs)
    let scene = answer{"scene"}
    if refused.len > 0 or scene.isNil or scene.kind != JObject:
      error = if refused.len > 0: refused else: "invalid_answer"
      return
    withLock codeLock:
      facts.draft = $scene
      facts.draftId = scene{"id"}.getStr()
      facts.draftName = scene{"name"}.getStr()
      facts.summary = answer{"summary"}.getStr()
  of "save":
    let scene = args{"scene"}
    let show = args{"show"}.getBool(true)
    error = refusal(scene)
    if error.len > 0:
      return
    if plane.url.len > 0:
      error = askPlane(plane.url, plane.token, $(%*{"action": "save", "scene": scene, "show": show}),
        SaveTimeoutMs).error
    else:
      error = saveHereCode(scene, show)
  else:
    discard

proc run(job: Job) {.gcsafe.} =
  {.cast(gcsafe).}:
    var error = ""
    try:
      work(job, error)
    except Exception as e:
      # Nothing that goes wrong here may end the thread (and with it the
      # runtime): the app says it did not work.
      log(%*{"event": "sceneCode:error", "action": job.action, "error": e.msg})
      error = "failed"
    withLock codeLock:
      facts.busy = ""
      facts.error = error
      facts.done = if error.len > 0: "" else: job.action

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

proc factsJson(scene: string, config: FrameConfig): string =
  var f: CodeFacts
  withLock codeLock:
    asker = scene
    # Everything but the draft itself, which "draft" hands out alone.
    f = CodeFacts(busy: facts.busy, error: facts.error, done: facts.done, draftId: facts.draftId,
      draftName: facts.draftName, summary: facts.summary)
  let answer = %*{"busy": f.busy, "error": f.error, "done": f.done,
    "ask": cloudPanel("code").url.len > 0 or backendOf(config).url.len > 0, "save": true}
  answer["draft"] = if f.draftId.len > 0:
    %*{"id": f.draftId, "name": f.draftName, "summary": f.summary} else: newJNull()
  $answer

proc start(scene, action, args: string, config: FrameConfig) =
  var job = Job(action: action, args: args)
  (job.backendUrl, job.backendKey) = backendOf(config)
  withLock codeLock:
    asker = scene
    if action == "clear":
      if facts.busy.len == 0:
        facts = CodeFacts()
      return
    # One thing at a time: the app says what is running.
    if facts.busy.len > 0 or action notin ["ask", "save"]:
      return
    facts.busy = action
    facts.error = ""
    facts.done = ""
  queue(job)

proc linuxSceneCode*(scene, op, arg: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      let config = runnerConfig()
      if config == nil or not framePageOffered(config):
        return if op == "read": "" else: SettingsOffCode
      case op
      of "read": result = factsJson(scene, config)
      of "source": result = sceneText(arg)
      of "draft":
        withLock codeLock:
          result = facts.draft
      else:
        start(scene, op, arg, config)
        result = "true"
    except Exception:
      result = ""

proc installSceneCodeHooks*() =
  ## Once, at startup, before the runner draws anything.
  sceneCode = linuxSceneCode
