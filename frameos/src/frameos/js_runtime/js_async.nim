## Async JavaScript (docs/async-js.md), included into app_runtime.nim on every
## runtime: `fetch`, the timers, `frameos.sleep` and `frameos.loadImage`
## (promises), `frameos.useImage` (a hook for get()), and an app's
## `background()` export.
##
## Every interpreter still lives on the thread that renders and is entered
## from it alone. What waits is a promise and an id: a request goes to the I/O
## (js_io.nim: a Pi's worker threads, an ESP32's task) as values, a timer is a
## time; `pumpJsAsync`, run between renders (a Pi's runner loop, an ESP32's
## idle wait through frameos_nim_tick), settles the ones that are done and
## lets the code that awaited them run on, each stretch up to its next await
## bounded by `jsAsyncSliceMs`. A render never waits on any of it.
##
## A runtime nothing pumps (`asyncPumped` false: the wasm preview and a plane's
## render for a board, an ESP32 that sleeps between renders) has no promise
## that outlives a render: `fetch` and `loadImage` are the blocking calls they
## replace, wrapped in a settled promise, the hooks block, and `background()`
## and the timers never run.

const jsAsyncOn* = not defined(frameosWasm)
  ## A transport to make requests on (js_io.nim) and a loop to pump.

var asyncPumped* = not defined(frameosEmbedded) and not defined(frameosWasm)
  ## Whether something calls `pumpJsAsync` between renders and keeps the
  ## interpreters: a Pi's runner always; an ESP32 that stays awake
  ## (embedded_runtime.nim sets it with keepJsRuntimes).

proc jsAsyncMode(ctx: ptr JSContext): JSValue {.nimcall.} =
  ## The prelude's question: promises that settle later, or blocking calls.
  nimBoolToJS(ctx, jsAsyncOn and asyncPumped)

const
  HookImageRetryMs = 30_000
    ## A useImage that failed is asked again after this long.
  HookImageChurnMs = 10_000
    ## A picture that lost its memory this soon after it came is not loaded
    ## again at once: the app asks for more than fits, and each load would
    ## push out another of its pictures, for ever. It waits HookImageRetryMs.
  MaxHookImages = 96
    ## useImage entries one app keeps (the pictures themselves are kept
    ## pictures, under their own limits).

proc hookImageKey(url: string, options: JsonNode): string =
  url & "\n" & $options

const HookLoading = """{"image":null,"loading":true}"""

proc failedAnswer(error: string): string =
  ## {image: null, error}, as fetchImage answers a failure.
  result = """{"image":null,"error":"""
  escapeJson(error, result)
  result.add '}'

proc hookImageAnswer(entry: HookImage): string =
  if entry.state == hsLoading: HookLoading else: entry.answer

proc hookImageUsable(runtime: JsAppRuntime, entry: HookImage): bool =
  ## A ready entry whose picture is still kept: older kept pictures go when
  ## memory is short or the app keeps too many, and the hook loads it again.
  case entry.state
  of hsReady: runtime.keptImageIds.contains(entry.id)
  of hsLoading: true
  of hsFailed: (getMonoTime() - entry.at).inMilliseconds < HookImageRetryMs
  of hsNone: false

proc findHookImage(runtime: JsAppRuntime, key: string): int =
  for i, entry in runtime.hookImages:
    if entry.key == key:
      return i
  -1

proc rememberHookImage(runtime: JsAppRuntime, entry: HookImage) =
  let at = runtime.findHookImage(entry.key)
  if at >= 0:
    runtime.hookImages[at] = entry
    return
  if runtime.hookImages.len >= MaxHookImages:
    # The oldest that is not loading.
    var oldest = -1
    for i, v in runtime.hookImages:
      if v.state != hsLoading and (oldest < 0 or v.at < runtime.hookImages[oldest].at):
        oldest = i
    if oldest >= 0:
      runtime.hookImages.del(oldest)
  runtime.hookImages.add entry

proc keptImageEntry(key: string, response: JsonNode): HookImage =
  ## fetchImage's answer as a hook entry.
  let image = response{"image"}
  if image.isNil or image.kind != JObject:
    return HookImage(key: key, state: hsFailed, at: getMonoTime(),
      answer: failedAnswer(response{"error"}.getStr("the image could not be loaded")))
  HookImage(key: key, state: hsReady, at: getMonoTime(), id: image{"id"}.getInt(), answer: $response)

proc likeOf(e: JsAppEvalEnv): Image =
  ## The canvas's pixel format, for a picture decoded later outside the
  ## render (RGB565 on an LCD ESP32: half the bytes of RGBA): a 1x1 of it.
  let context = e.context
  let like =
    if context.isNil: nil
    elif not context.decodeTargetImage.isNil: context.decodeTargetImage
    else: context.contextImage()
  if like.isNil:
    return nil
  result = newImageLike(like, 1, 1)
  result.ditherStores = like.ditherStores

proc decodeKeptAnswer(runtime: JsAppRuntime, owner: AppRoot, like: Image,
    options: JsonNode, image: Image): JsonNode =
  ## A picture decoded for an app, kept, and described as fetchImage
  ## describes one ({image: ref, width, height}).
  unmarkImageGraded(image)
  if options.hasKey("colors"):
    let profile = fetchImageColorProfile(options["colors"])
    if profile.isSome and profile.get().hasAdjustments():
      applyAssetColors(image, profile.get())
      markImageGraded(image)
  %*{"image": runtime.storeKeptImageJson(owner, image), "width": image.width, "height": image.height}

when jsAsyncOn:
  import frameos/js_runtime/js_io

  type
    AsyncKind = enum akFetch, akSleep, akImage, akUseImage
    AsyncWait = object
      ## A promise an app waits on (or a useImage entry loading): what
      ## settles it, and who to settle it in. `ctx` is the interpreter that
      ## asked: one rebuilt since is a new context, and the answer is dropped.
      id: int
      runtime: JsAppRuntime
      ctx: ptr JSContext
      owner: AppRoot
      configJson: JsonNode
      kind: AsyncKind
      options: JsonNode
      dueAt: MonoTime
      key: string ## akUseImage: the hook entry
      like: Image ## akImage, akUseImage: the canvas's format (likeOf)
      ready: bool ## answered already (`answer`), settled at the next pump
      answer: string
      failed: bool

  const
    MaxAsyncWaitsPerApp* = 32
      ## Fetches, timers and pictures one app may have pending; one more is
      ## refused (its promise rejects; a useImage asks again at a later
      ## render, which each answer that lands brings).
    JsAsyncSliceMs* = 2000
    PumpBudgetMs = 40
      ## What one pump spends settling before it lets the loop serve input
      ## (a decode is most of it on an ESP32); the rest waits for the next.
    AsyncEvent = "background"
      ## `context.event` while async code runs.

  var
    asyncWaits {.threadvar.}: seq[AsyncWait]
      ## A few dozen at most: a scan is cheaper in flash than a Table.
    nextAsyncId {.threadvar.}: int
    jsAsyncSliceMs* {.threadvar.}: int
      ## What async code may run from one await to the next before it is
      ## stopped (its promise rejects): it shares the thread with every
      ## render. 0 = JsAsyncSliceMs.

  proc sliceMs(): int =
    if jsAsyncSliceMs > 0: jsAsyncSliceMs else: JsAsyncSliceMs

  proc asyncEnv(wait: AsyncWait): JsAppEvalEnv =
    JsAppEvalEnv(runtime: wait.runtime, owner: wait.owner, configJson: wait.configJson,
      context: ExecutionContext(scene: wait.owner.scene, event: AsyncEvent, payload: %*{},
        hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1))

  proc alive(wait: AsyncWait): bool =
    not wait.runtime.isNil and wait.runtime.ready and wait.runtime.js.context == wait.ctx

  proc pendingFor(runtime: JsAppRuntime): int =
    for wait in asyncWaits:
      if wait.runtime == runtime:
        inc result

  proc popWait(id: int, wait: var AsyncWait): bool =
    for i in 0 ..< asyncWaits.len:
      if asyncWaits[i].id == id:
        wait = move(asyncWaits[i])
        asyncWaits.del(i)
        return true
    false

  proc requestHeaders(options: JsonNode): seq[SimpleHttpHeader] =
    let headersNode = options{"headers"}
    if not headersNode.isNil and headersNode.kind == JObject:
      for name, value in headersNode.pairs:
        result.add((name, value.getStr($value)))

  proc fetchRequest(e: JsAppEvalEnv, url: string, options: JsonNode): JsIoRequest =
    ## `fetch`'s init, for the I/O: no render deadline caps it (no render
    ## waits for it), the scene's own response ceiling does.
    result = JsIoRequest(url: url, httpMethod: options{"method"}.getStr("GET").toUpperAscii(),
      body: options{"body"}.getStr(""), maxBytes: jsFetchMaxBytes(e), headers: requestHeaders(options))
    result.timeoutMs = clamp(options{"timeoutMs"}.getInt(DefaultFetchTimeoutMs), 1000, JsHttpMaxTimeoutMs)
    result.maxSeconds = max(DefaultFetchMaxSeconds, result.timeoutMs.float / 1000.0 + 30.0)

  proc imageRequest(e: JsAppEvalEnv, url: string, options: JsonNode): JsIoRequest =
    ## A picture's download, as fetchImage's keep path asks for it.
    var target = url
    when defined(frameosEmbedded):
      # A resizing image service is asked for the size the app wants.
      let (w, h) = (options{"width"}.getInt(0), options{"height"}.getInt(0))
      if w > 0 and h > 0:
        target = embeddedSizedRemoteImageUrl(url, w, h)
    result = JsIoRequest(url: target, httpMethod: "GET", headers: requestHeaders(options),
      maxBytes: frameos_apps.maxImageResponseBytes(e.owner), timeoutMs: DefaultFetchTimeoutMs,
      maxSeconds: DefaultFetchMaxSeconds)

  proc fetchAnswer(answer: var JsIoResult): string =
    ## What `fetch`'s promise settles with: {status, body, headers}, or
    ## {status: 0, error}, which the prelude rejects with a TypeError.
    if answer.error.len > 0:
      result = """{"status":0,"error":"""
      escapeJson(redactedUrlsIn(answer.error), result)
      result.add '}'
      return
    result = """{"status":""" & $answer.code & ""","headers":{"""
    for i, (name, value) in answer.headers:
      if i > 0: result.add ','
      escapeJson(name.toLowerAscii(), result)
      result.add ':'
      escapeJson(value, result)
    result.add """},"body":"""
    escapeJson(jsIoText(answer), result)
    result.add '}'

  proc decodeAnswer(wait: AsyncWait, answer: var JsIoResult): JsonNode =
    ## A picture's answer decoded and kept: fetchImage's {image, width,
    ## height}, or {image: null, error}.
    if answer.error.len > 0:
      return %*{"image": newJNull(), "error": redactedUrlsIn(answer.error)}
    let runtime = wait.runtime
    try:
      var image: Image
      runtime.midCall:
        # On the stack, so a decode short of memory does not release the
        # interpreter it decodes for (releaseKeptJsAppRuntimes).
        when defined(frameosEmbedded):
          let
            (w, h) = (wait.options{"width"}.getInt(0), wait.options{"height"}.getInt(0))
            fit = scaledDecodeFit(wait.options{"fit"}.getStr("cover"))
          image =
            if w > 0 and h > 0:
              decodeBufferedImage(answer.response, nil, fit,
                targetFor = runtime.keptTargetFor(wait.owner, wait.like, w, h, fit))
            else:
              decodeBufferedImage(answer.response)
        else:
          if answer.code >= 400:
            raise newException(IOError, "HTTP " & $answer.code)
          image = decodeFetchedImage(answer.body)
        if image.isNil:
          raise newException(PixieError, "the response was not an image this frame can decode")
        result = runtime.decodeKeptAnswer(wait.owner, wait.like, wait.options, image)
    except CatchableError as error:
      releaseJsIoResult(answer)
      let message = redactedUrlsIn(error.msg)
      frameos_apps.logError(wait.owner, "JS app image failed: " & message)
      result = %*{"image": newJNull(), "error": message}

  proc jsAsyncStart(ctx: ptr JSContext, kind: JSValue, arg: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
    ## The prelude's promises: the id one waits under, 0 when it cannot start
    ## (the prelude rejects it then).
    let e = env(ctx)
    if e == nil or e.runtime.isNil:
      return nimIntToJS(ctx, 0)
    let kindName = toNimString(ctx, kind)
    if e.runtime.pendingFor() >= MaxAsyncWaitsPerApp:
      frameos_apps.logError(e.owner, kindName & " refused: " & $MaxAsyncWaitsPerApp &
        " fetches, timers and pictures already pending")
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
    of "fetch", "image":
      let url = toNimString(ctx, arg)
      wait.options = optionsArg(ctx, optionsJson)
      if kindName == "fetch":
        wait.kind = akFetch
        var request = fetchRequest(e, url, wait.options)
        request.id = id
        if not submitJsIo(request):
          wait.ready = true
          wait.answer = """{"status":0,"error":"too many requests in flight"}"""
      else:
        wait.kind = akImage
        wait.like = likeOf(e)
        if url.startsWith("data:"):
          # Nothing to wait for: decoded now, settled at the next pump.
          let answer = fetchImageJson(e, url, wait.options, forceKeep = true)
          wait.ready = true
          wait.failed = answer{"image"}.isNil or answer["image"].kind != JObject
          wait.answer = if wait.failed: answer{"error"}.getStr("no image") else: $answer
        else:
          var request = imageRequest(e, url, wait.options)
          request.id = id
          if not submitJsIo(request):
            wait.ready = true
            wait.failed = true
            wait.answer = "too many requests in flight"
    else:
      return nimIntToJS(ctx, 0)
    wait.id = id
    asyncWaits.add wait
    nimIntToJS(ctx, id.int32)

  proc jsAsyncCancel(ctx: ptr JSContext, id: JSValue): JSValue {.nimcall.} =
    ## clearTimeout / clearInterval: the wait goes now (a request in flight
    ## is dropped when it answers).
    var wait: AsyncWait
    discard popWait(toNimFloat(ctx, id).int, wait)
    jsUndefSentinel(ctx)

  proc startHookImage(e: JsAppEvalEnv, url, key: string, options: JsonNode): bool =
    ## useImage's download, off the render: false when it cannot start now
    ## (too many pending: a later render asks again).
    if e.runtime.pendingFor() >= MaxAsyncWaitsPerApp:
      return false
    inc nextAsyncId
    var request = imageRequest(e, url, options)
    request.id = nextAsyncId
    if not submitJsIo(request):
      return false
    asyncWaits.add AsyncWait(id: nextAsyncId, runtime: e.runtime, ctx: e.runtime.js.context, owner: e.owner,
      configJson: e.configJson, kind: akUseImage, options: options, key: key, like: likeOf(e))
    true

  proc runAsync(wait: AsyncWait, fnName: string, args: openArray[JSValueConst]): bool =
    ## Enter an app's interpreter outside a render: settle a promise (or start
    ## `background()`), then run what that lets run, up to the next await.
    ## False when the interpreter it was waiting in is gone.
    if not wait.alive():
      return false
    let runtime = wait.runtime
    let ctx = wait.ctx
    runtime.midCall:
      jsAppEnvByCtx[ctx] = asyncEnv(wait)
      let armedHere = runtime.js.armDeadline(sliceMs())
      try:
        let value = callGlobalFunction(ctx, fnName, args)
        if JS_IsException(value) != 0:
          frameos_apps.logError(wait.owner, "async code failed: " & mappedJsExceptionDetails(ctx).message)
        JS_FreeValue(ctx, value)
        runtime.js.runPendingJobs()
        if runtime.js.deadlineTripped():
          frameos_apps.logError(wait.owner, "async code ran for " & $sliceMs() &
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
    discard runAsync(AsyncWait(runtime: runtime, ctx: runtime.js.context, owner: owner,
      configJson: configJson), "__frameosStartBackground", [])

  proc settle(id: int, wait: AsyncWait, json: string, failed: bool): bool =
    let ctx = wait.ctx
    let idValue = nimIntToJS(ctx, id.int32)
    let jsonValue = nimStringToJS(ctx, json)
    let failedValue = nimBoolToJS(ctx, failed)
    try:
      result = runAsync(wait, "__frameosSettle", [idValue, jsonValue, failedValue])
    finally:
      JS_FreeValue(ctx, idValue)
      JS_FreeValue(ctx, jsonValue)
      JS_FreeValue(ctx, failedValue)

  when defined(frameosEmbedded):
    proc fos_js_io_wake_if_waiting() {.importc, cdecl.}
    proc fos_client_input_held(): bool {.importc, cdecl.}
      ## Somebody is tapping (main/fos_client.c): a picture's decode is a
      ## couple of hundred ms of the render task, so answers wait for the
      ## hold to end; the idle wait's slices (a second at most) come back.

  proc pumpJsAsync*(): int =
    ## Between renders, on the thread that renders: every answer that came
    ## back and every timer that is over settles its promise, and the code
    ## waiting on it runs to its next await; a useImage picture is decoded
    ## and its scene asked to render. How many settled. Spends about
    ## PumpBudgetMs, at least one answer; the rest waits for the next pump.
    let started = getMonoTime()
    var redraw: seq[tuple[scene: FrameScene, nodeId: int]]
    template overBudget(): bool =
      (getMonoTime() - started).inMilliseconds >= PumpBudgetMs
    # Answers first: each one is a request somebody waits for.
    var answersNow = true
    when defined(frameosEmbedded):
      answersNow = not fos_client_input_held()
    while answersNow:
      if result > 0 and overBudget():
        when defined(frameosEmbedded):
          fos_js_io_wake_if_waiting()
        else:
          wakeRunner()
        break
      var (ok, answer) = takeJsIoResult()
      if not ok:
        break
      var wait: AsyncWait
      if not popWait(answer.id, wait) or not wait.alive():
        releaseJsIoResult(answer)
        continue
      case wait.kind
      of akFetch:
        if settle(answer.id, wait, fetchAnswer(answer), false):
          inc result
      of akImage:
        let decoded = decodeAnswer(wait, answer)
        let failed = decoded{"image"}.isNil or decoded["image"].kind != JObject
        if settle(answer.id, wait, if failed: decoded{"error"}.getStr("no image") else: $decoded, failed):
          inc result
      of akUseImage:
        let decoded = decodeAnswer(wait, answer)
        wait.runtime.rememberHookImage(keptImageEntry(wait.key, decoded))
        inc result
        if not wait.owner.scene.isNil and not redraw.anyIt(it.scene == wait.owner.scene):
          redraw.add((wait.owner.scene, wait.owner.nodeId.int))
      of akSleep:
        releaseJsIoResult(answer)
    # Timers over, and answers made at once.
    let now = getMonoTime()
    var due: seq[int]
    var i = 0
    while i < asyncWaits.len:
      let wait = asyncWaits[i]
      if not wait.alive() and (wait.kind == akSleep or wait.ready):
        # Its interpreter went: a timer is forgotten now, a request when its
        # answer comes (the I/O still holds it).
        asyncWaits.del(i)
        continue
      if wait.alive() and (wait.ready or (wait.kind == akSleep and wait.dueAt <= now)):
        due.add wait.id
      inc i
    for id in due:
      var wait: AsyncWait
      # A settle before may have cancelled it (clearTimeout).
      if not popWait(id, wait) or not wait.alive():
        continue
      if settle(id, wait, wait.answer, wait.failed):
        inc result
    # One render per scene however many of its pictures came in.
    for (scene, nodeId) in redraw:
      dispatchFromScene(scene, "render", %*{}, nodeId, AsyncEvent)

  proc nextJsAsyncMs*(): int =
    ## How long until the next timer ends (0: something is ready now), -1
    ## when none is pending: the loop waits no longer than that. An answer
    ## from the I/O wakes the loop itself.
    result = -1
    let now = getMonoTime()
    for wait in asyncWaits:
      if wait.ready:
        return 0
      if wait.kind == akSleep:
        let left = max(0, (wait.dueAt - now).inMilliseconds.int)
        if result < 0 or left < result:
          result = left

  proc jsAsyncPending*(): int =
    ## Requests, timers and pictures waiting, every app together.
    asyncWaits.len

else:
  proc jsAsyncStart(ctx: ptr JSContext, kind: JSValue, arg: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
    nimIntToJS(ctx, 0)

  proc jsAsyncCancel(ctx: ptr JSContext, id: JSValue): JSValue {.nimcall.} =
    jsUndefSentinel(ctx)

when defined(frameosWasm):
  var previewLoadRender {.threadvar.}: pointer
    ## The render (its context) that already fetched a useImage picture.

proc jsUseImage(ctx: ptr JSContext, url: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## `frameos.useImage(url, options)`: the picture if it is here, else
  ## {image: null, loading: true} and a download off the render, after which
  ## the scene renders again. fetchImage's options (`keep` is implied); the
  ## same url and options are the same picture while the interpreter lives.
  ## Where nothing pumps, or with `wait: true` (e-paper: one refresh with every
  ## picture), the picture is fetched now, as fetchImage would.
  let e = env(ctx)
  if e == nil:
    return nimStringToJS(ctx, """{"image":null,"error":"no app context"}""")
  let urlStr = toNimString(ctx, url)
  let options = optionsArg(ctx, optionsJson)
  if urlStr.len == 0:
    return nimStringToJS(ctx, """{"image":null}""")
  let key = hookImageKey(urlStr, options)
  let runtime = e.runtime
  let at = runtime.findHookImage(key)
  var known = if at >= 0: runtime.hookImages[at] else: HookImage(key: key)
  if known.state == hsReady and not runtime.keptImageIds.contains(known.id) and
      (getMonoTime() - known.at).inMilliseconds < HookImageChurnMs:
    known = HookImage(key: key, state: hsFailed, at: getMonoTime(),
      answer: failedAnswer("no room for every picture"))
    runtime.hookImages[at] = known
  if runtime.hookImageUsable(known):
    return nimStringToJS(ctx, hookImageAnswer(known))
  var blocking = options{"wait"}.getBool(false) or urlStr.startsWith("data:")
  when jsAsyncOn:
    blocking = blocking or not asyncPumped
    if not blocking:
      if startHookImage(e, urlStr, key, options):
        runtime.rememberHookImage(HookImage(key: key, state: hsLoading, at: getMonoTime()))
      return nimStringToJS(ctx, HookLoading)
  when defined(frameosWasm):
    # The preview: nothing pumps, and a render that fetched every picture of
    # a page one after the other would show nothing for seconds. One picture
    # a render, and the next render soon.
    if not options{"wait"}.getBool(false) and not urlStr.startsWith("data:"):
      let render = cast[pointer](e.context)
      if render == previewLoadRender:
        if not e.context.isNil and (e.context.nextSleep < 0 or e.context.nextSleep > 0.05):
          e.context.nextSleep = 0.05
        return nimStringToJS(ctx, HookLoading)
      previewLoadRender = render
  let entry = keptImageEntry(key, fetchImageJson(e, urlStr, options, forceKeep = true))
  runtime.rememberHookImage(entry)
  nimStringToJS(ctx, hookImageAnswer(entry))
