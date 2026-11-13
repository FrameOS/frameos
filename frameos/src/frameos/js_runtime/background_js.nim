## Background JavaScript (docs/background-js.md), included into app_runtime.nim
## on a Pi only (`jsBackgroundOn`): an app's `background()` export, and
## `frameos.fetch` / `frameos.sleep`, which return promises.
##
## Every interpreter still lives on the runner thread and is entered from it
## alone. What waits is a promise and an id: a fetch goes to a worker thread
## (js_io.nim) as strings, a sleep is a time; `pumpJsBackground`, run by the
## runner's loop between renders, settles the ones that are done and lets the
## code that awaited them run on, each stretch up to its next await bounded
## by `jsBackgroundSliceMs`. A render never waits on any of it.

import frameos/js_runtime/js_io

type
  AsyncKind = enum akFetch, akSleep
  AsyncWait = object
    ## A promise an app is waiting on: what settles it, and who to settle it
    ## in. `ctx` is the interpreter that asked: one rebuilt since is a new
    ## context, and the answer is dropped.
    runtime: JsAppRuntime
    ctx: ptr JSContext
    owner: AppRoot
    configJson: JsonNode
    kind: AsyncKind
    options: JsonNode
    dueAt: MonoTime

const
  MaxAsyncWaitsPerApp* = 16
    ## Fetches and sleeps one app may have pending; one more is refused.
  JsBackgroundSliceMs* = 2000
  BackgroundEvent = "background"
    ## `context.event` while background code runs.

var
  asyncWaits {.threadvar.}: Table[int, AsyncWait]
  nextAsyncId {.threadvar.}: int
  jsBackgroundSliceMs* {.threadvar.}: int
    ## What background code may run from one await to the next before it is
    ## stopped (its promise rejects): it shares the runner thread with every
    ## render. 0 = JsBackgroundSliceMs.

proc sliceMs(): int =
  if jsBackgroundSliceMs > 0: jsBackgroundSliceMs else: JsBackgroundSliceMs

proc backgroundEnv(wait: AsyncWait): JsAppEvalEnv =
  JsAppEvalEnv(runtime: wait.runtime, owner: wait.owner, configJson: wait.configJson,
    context: ExecutionContext(scene: wait.owner.scene, event: BackgroundEvent, payload: %*{},
      hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1))

proc alive(wait: AsyncWait): bool =
  not wait.runtime.isNil and wait.runtime.ready and wait.runtime.js.context == wait.ctx

proc fetchRequest(e: JsAppEvalEnv, url: string, options: JsonNode): JsIoRequest =
  ## httpRequest's options, for a worker: no render deadline caps it (no
  ## render waits for it), the scene's own response ceiling does.
  result = JsIoRequest(url: url, httpMethod: options{"method"}.getStr("GET").toUpperAscii(),
    body: options{"body"}.getStr(""), maxBytes: jsFetchMaxBytes(e))
  if options{"bodyBase64"}.getStr("").len > 0:
    result.body = decode(options["bodyBase64"].getStr())
  let headersNode = options{"headers"}
  if not headersNode.isNil and headersNode.kind == JObject:
    for name, value in headersNode.pairs:
      result.headers.add((name, value.getStr($value)))
  result.timeoutMs = clamp(options{"timeoutMs"}.getInt(DefaultFetchTimeoutMs), 1000, JsHttpMaxTimeoutMs)
  result.maxSeconds = max(DefaultFetchMaxSeconds, result.timeoutMs.float / 1000.0 + 30.0)

proc fetchAnswer(options: JsonNode, answer: JsIoResult): JsonNode =
  ## What `frameos.fetch` resolves with: httpRequest's answer, the same shape.
  result = %*{"status": answer.code}
  if answer.error.len > 0:
    result["status"] = %0
    result["error"] = %redactedUrlsIn(answer.error)
    return
  let find = options{"find"}.getStr("")
  if find.len > 0:
    let length = clamp(options{"findLength"}.getInt(JsHttpFindDefaultLength), 1, JsHttpFindMaxLength)
    let limit = clamp(options{"findLimit"}.getInt(JsHttpFindDefaultLimit), 1, JsHttpFindMaxLimit)
    result["found"] = findSnippets(answer.body, find, length, limit)
    if answer.code < 200 or answer.code >= 300:
      result["body"] = %*answer.body[0 ..< utf8Boundary(answer.body, JsHttpFindErrorBodyBytes)]
  elif options{"base64"}.getBool(false):
    result["bodyBase64"] = %*encode(answer.body)
  else:
    result["body"] = %*answer.body

proc jsAsyncStart(ctx: ptr JSContext, kind: JSValue, arg: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## The prelude's `frameos.fetch` / `frameos.sleep`: the id its promise
  ## waits under, 0 when it cannot start (the prelude rejects it then).
  let e = env(ctx)
  if e == nil or e.runtime.isNil:
    return nimIntToJS(ctx, 0)
  let kindName = toNimString(ctx, kind)
  var pending = 0
  for wait in asyncWaits.values:
    if wait.runtime == e.runtime:
      inc pending
  if pending >= MaxAsyncWaitsPerApp:
    frameos_apps.logError(e.owner, "frameos." & kindName & " refused: " & $MaxAsyncWaitsPerApp &
      " fetches and sleeps already pending")
    return nimIntToJS(ctx, 0)
  var wait = AsyncWait(runtime: e.runtime, ctx: ctx, owner: e.owner, configJson: e.configJson)
  inc nextAsyncId
  let id = nextAsyncId
  case kindName
  of "sleep":
    var seconds = 0.0
    try:
      seconds = parseFloat(toNimString(ctx, arg))
    except ValueError:
      discard
    wait.kind = akSleep
    wait.dueAt = getMonoTime() + initDuration(milliseconds = int(clamp(seconds, 0.0, 86_400.0) * 1000))
  of "fetch":
    var options = %*{}
    try:
      options = parseJson(toNimString(ctx, optionsJson))
    except CatchableError:
      discard
    if options.isNil or options.kind != JObject:
      options = %*{}
    wait.kind = akFetch
    wait.options = options
    var request = fetchRequest(e, toNimString(ctx, arg), options)
    request.id = id
    submitJsIo(request)
  else:
    return nimIntToJS(ctx, 0)
  asyncWaits[id] = wait
  nimIntToJS(ctx, id.int32)

proc runBackground(wait: AsyncWait, fnName: string, args: openArray[JSValueConst]): bool =
  ## Enter an app's interpreter outside a render: settle a promise (or start
  ## `background()`), then run what that lets run, up to the next await.
  ## False when the interpreter it was waiting in is gone.
  if not wait.alive():
    return false
  let runtime = wait.runtime
  let ctx = wait.ctx
  runtime.midCall:
    jsAppEnvByCtx[ctx] = backgroundEnv(wait)
    let armedHere = runtime.js.armDeadline(sliceMs())
    try:
      let value = callGlobalFunction(ctx, fnName, args)
      if JS_IsException(value) != 0:
        frameos_apps.logError(wait.owner, "background code failed: " & mappedJsExceptionDetails(ctx).message)
      JS_FreeValue(ctx, value)
      runtime.js.runPendingJobs()
      if runtime.js.deadlineTripped():
        frameos_apps.logError(wait.owner, "background code ran for " & $sliceMs() &
          " ms without an await and was stopped")
    finally:
      if armedHere:
        runtime.js.disarmDeadline()
      if jsAppEnvByCtx.hasKey(ctx):
        jsAppEnvByCtx.del(ctx)
      runtime.closeLineStreams()
  true

proc startBackground(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode) =
  ## Once the interpreter is up and init() ran: the app's `background()`, if
  ## it has one, runs to its first await.
  discard runBackground(AsyncWait(runtime: runtime, ctx: runtime.js.context, owner: owner,
    configJson: configJson), "__frameosStartBackground", [])

proc pumpJsBackground*(): int =
  ## On the runner thread, between renders: every fetch answered and every
  ## sleep over settles its promise, and the background code waiting on it
  ## runs to its next await. How many settled.
  var ready: seq[tuple[id: int, json: string]]
  while true:
    let (ok, answer) = takeJsIoResult()
    if not ok:
      break
    if asyncWaits.hasKey(answer.id):
      ready.add((answer.id, $fetchAnswer(asyncWaits[answer.id].options, answer)))
  let now = getMonoTime()
  var gone: seq[int]
  for id, wait in asyncWaits.pairs:
    if not wait.alive():
      # Its interpreter went: a sleep is forgotten now, a fetch when its
      # answer comes (a worker still holds it).
      if wait.kind == akSleep:
        gone.add id
    elif wait.kind == akSleep and wait.dueAt <= now:
      ready.add((id, ""))
  for id in gone:
    asyncWaits.del(id)
  for (id, json) in ready:
    var wait: AsyncWait
    if not asyncWaits.pop(id, wait) or not wait.alive():
      continue
    let ctx = wait.ctx
    let idValue = nimIntToJS(ctx, id.int32)
    let jsonValue = nimStringToJS(ctx, json)
    try:
      if runBackground(wait, "__frameosSettle", [idValue, jsonValue]):
        inc result
    finally:
      JS_FreeValue(ctx, idValue)
      JS_FreeValue(ctx, jsonValue)

proc nextJsBackgroundMs*(): int =
  ## How long until the next sleep ends, -1 when none is pending: the runner's
  ## loop sleeps no longer than that. A fetch's answer wakes it itself.
  result = -1
  let now = getMonoTime()
  for wait in asyncWaits.values:
    if wait.kind == akSleep:
      let left = max(0, (wait.dueAt - now).inMilliseconds.int)
      if result < 0 or left < result:
        result = left

proc jsBackgroundPending*(): int =
  ## Fetches and sleeps waiting, every app together.
  asyncWaits.len

const backgroundJsPrelude = compactJs("""
  "use strict";
  (() => {
    const pending = new Map();
    globalThis.__frameosSettle = (id, json) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      p.resolve(json === "" ? undefined : JSON.parse(json));
    };
    const start = (kind, arg, options) => new Promise((resolve, reject) => {
      const id = jsAsyncStart(kind, arg, options);
      if (id > 0) pending.set(id, { resolve, reject });
      else reject(new Error("frameos." + kind + " could not start"));
    });
    frameos.fetch = (url, options) =>
      start("fetch", String(url || ""), JSON.stringify(options || {}, __jsReplacer));
    frameos.sleep = (seconds) => start("sleep", String(Number(seconds) || 0), "");
    globalThis.__frameosStartBackground = () => {
      const mod = __frameosExports();
      const fn = mod && mod.background;
      if (typeof fn !== "function") return false;
      Promise.resolve()
        .then(() => fn(globalThis.__frameosAppInstance, globalThis.__frameosContext))
        .then(undefined, (e) => jsAppLog("error",
          JSON.stringify(["background() failed: " + ((e && e.message) || String(e))])));
      return true;
    };
  })();
""")
