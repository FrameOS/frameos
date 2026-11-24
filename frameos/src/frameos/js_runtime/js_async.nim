## Async JavaScript (docs/async-js.md), included into app_runtime.nim on every
## runtime: `fetch`, the timers and `frameos.sleep` (promises), an async
## `init()` that goes on between renders, and the pictures of
## `<img src="https://…">`.
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
## that outlives a render: `fetch` is the blocking call it replaces, wrapped in
## a settled promise, an `<img>` is fetched in the render, and the timers
## never fire (an async `init()` runs to its first wait on one).

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
  UrlImageRetryMs = 30_000
    ## A picture that failed is asked again after this long.
  UrlImageChurnMs = 10_000
    ## A picture that lost its memory this soon after it came, while it was
    ## still being drawn (in this pass or the last), is not loaded again at
    ## once: the app shows more than fits, and each load would push out
    ## another of its pictures, for ever. It waits UrlImageRetryMs. One a
    ## scroll took out of sight and pushed out is loaded again when it is back.
  MaxUrlImages = 96
    ## Entries one app keeps (the pictures themselves are kept pictures,
    ## under their own limits).

proc findUrlImage(runtime: JsAppRuntime, url: string, width, height: int, fit: ScaledDecodeFit): int =
  for i, entry in runtime.urlImages:
    if entry.width == width and entry.height == height and entry.fit == fit and entry.url == url:
      return i
  -1

proc rememberUrlImage(runtime: JsAppRuntime, came: UrlImage) =
  var entry = came
  if entry.drawn == 0:
    # Come in for the render that asked: as good as drawn in it.
    entry.drawn = runtime.urlPass
  let at = runtime.findUrlImage(entry.url, entry.width, entry.height, entry.fit)
  if at >= 0:
    runtime.urlImages[at] = entry
    return
  if runtime.urlImages.len >= MaxUrlImages:
    # The oldest that is not loading.
    var oldest = -1
    for i, v in runtime.urlImages:
      if v.state != uiLoading and (oldest < 0 or v.at < runtime.urlImages[oldest].at):
        oldest = i
    if oldest >= 0:
      runtime.urlImages.del(oldest)
  runtime.urlImages.add entry

proc urlImageFailed(owner: AppRoot, url, error: string) =
  frameos_apps.logError(owner, "<img> " & redactedUrl(url) & ": " & error)

proc keptUrlImage(runtime: JsAppRuntime, owner: AppRoot, url: string, width, height: int,
    fit: ScaledDecodeFit, image: Image, error: string): UrlImage =
  ## A picture that came (kept, as fetchImage's `keep` keeps one), or why not.
  result = UrlImage(url: url, width: width, height: height, fit: fit, at: getMonoTime(), state: uiFailed)
  if image.isNil:
    urlImageFailed(owner, url, error)
    return
  unmarkImageGraded(image)
  result.id = runtime.storeKeptImageJson(owner, image)["id"].getInt()
  result.state = uiReady

proc likeOf(context: ExecutionContext): Image =
  ## The canvas's pixel format, for a picture decoded later outside the
  ## render (RGB565 on an LCD ESP32: half the bytes of RGBA): a 1x1 of it.
  let like =
    if context.isNil: nil
    elif not context.decodeTargetImage.isNil: context.decodeTargetImage
    else: context.contextImage()
  if like.isNil:
    return nil
  result = newImageLike(like, 1, 1)
  result.ditherStores = like.ditherStores

when jsAsyncOn:
  import frameos/js_runtime/js_io

  type
    AsyncKind = enum akFetch, akSleep, akUrlImage
    AsyncWait = object
      ## A promise an app waits on (or an `<img src>` loading): what settles
      ## it, and who to settle it in. `ctx` is the interpreter that asked: one
      ## rebuilt since is a new context, and the answer is dropped.
      id: int
      runtime: JsAppRuntime
      ctx: ptr JSContext
      owner: AppRoot
      configJson: JsonNode
      kind: AsyncKind
      options: JsonNode
      dueAt: MonoTime
      url: string ## akUrlImage: the picture, at width x height, fit
      width, height: int
      fit: ScaledDecodeFit
      like: Image ## akUrlImage: the canvas's format (likeOf)
      ready: bool ## answered already (`answer`), settled at the next pump
      answer: string
      failed: bool

  const
    MaxAsyncWaitsPerApp* = 32
      ## Fetches, timers and pictures one app may have pending; one more is
      ## refused (its promise rejects; an `<img>` asks again at a later
      ## render, which each answer that lands brings).
    JsAsyncSliceMs* = 2000
    PumpBudgetMs = 40
      ## What one pump spends settling before it lets the loop serve input
      ## (a decode is most of it on an ESP32); the rest waits for the next.
    AsyncEvent = "async"
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
    # The newest config, not the one of the call that started the wait: a
    # loop in init() sees a field the scene changed since.
    let config = if wait.runtime.liveConfig.isNil: wait.configJson else: wait.runtime.liveConfig
    JsAppEvalEnv(runtime: wait.runtime, owner: wait.owner, configJson: config,
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

  proc imageRequest(owner: AppRoot, url: string, width, height: int): JsIoRequest =
    ## A picture's download, as fetchImage's keep path asks for it.
    var target = url
    when defined(frameosEmbedded):
      # A resizing image service is asked for the size drawn.
      target = embeddedSizedRemoteImageUrl(url, width, height)
    result = JsIoRequest(url: target, httpMethod: "GET",
      maxBytes: frameos_apps.maxImageResponseBytes(owner), timeoutMs: DefaultFetchTimeoutMs,
      maxSeconds: DefaultFetchMaxSeconds)

  proc fetchAnswer(ctx: ptr JSContext, answer: var JsIoResult): JSValue =
    ## What `fetch`'s promise settles with: {status, body, headers}, or
    ## {status: 0, error}, which the prelude rejects with a TypeError. The
    ## body is its own JS string (answerToJS), never part of a JSON text.
    var body = ""
    if answer.error.len == 0:
      try:
        body = jsIoText(answer)
      except IOError as err:
        # A body with no block to hold it whole (http_client.requireRoomForBody).
        releaseJsIoResult(answer)
        answer.error = err.msg
    var head: string
    if answer.error.len > 0:
      head = """{"status":0,"error":"""
      escapeJson(redactedUrlsIn(answer.error), head)
      head.add '}'
      return answerToJS(ctx, head, body, false)
    head = """{"status":""" & $answer.code & ""","headers":{"""
    for i, (name, value) in answer.headers:
      if i > 0: head.add ','
      escapeJson(name.toLowerAscii(), head)
      head.add ':'
      escapeJson(value, head)
    head.add "}}"
    answerToJS(ctx, head, body, true)

  proc decodeAnswer(wait: AsyncWait, answer: var JsIoResult): UrlImage =
    ## A picture's answer decoded at the size asked and kept, or why not.
    var image: Image
    var error = answer.error
    if error.len == 0:
      let runtime = wait.runtime
      try:
        runtime.midCall:
          # On the stack, so a decode short of memory does not release the
          # interpreter it decodes for (releaseKeptJsAppRuntimes).
          when defined(frameosEmbedded):
            image = decodeBufferedImage(answer.response, nil, wait.fit,
              targetFor = runtime.keptTargetFor(wait.owner, wait.like, wait.width, wait.height, wait.fit))
          else:
            if answer.code >= 400:
              raise newException(IOError, "HTTP " & $answer.code)
            image = decodeFetchedImage(answer.body)
            # Kept at the size it is drawn, as an ESP32 decodes it, when it is
            # many times that: a page of 512 px store thumbnails kept whole is
            # more pixels than the app's kept pictures may hold, and they
            # pushed each other out (the Scene store's grid, 2026-11-21).
            if not image.isNil and wait.width >= 32 and wait.height >= 32 and
                image.width * image.height > 4 * wait.width * wait.height:
              let target = runtime.keptTargetFor(wait.owner, wait.like, wait.width, wait.height,
                wait.fit)(image.width, image.height)
              if not target.isNil:
                scaleAndDrawImage(target, image, scaledFitPlacement(wait.fit))
                image = target
          if image.isNil:
            error = "the response was not an image this frame can decode"
      except CatchableError as e:
        error = e.msg
    releaseJsIoResult(answer)
    wait.runtime.keptUrlImage(wait.owner, wait.url, wait.width, wait.height, wait.fit, image,
      redactedUrlsIn(error))

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
    of "fetch":
      wait.options = optionsArg(ctx, optionsJson)
      wait.kind = akFetch
      var request = fetchRequest(e, toNimString(ctx, arg), wait.options)
      request.id = id
      if not submitJsIo(request):
        wait.ready = true
        wait.answer = """{"status":0,"error":"too many requests in flight"}"""
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

  proc startUrlImage(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext,
      url: string, width, height: int, fit: ScaledDecodeFit): bool =
    ## An `<img src>`'s download, off the render: false when it cannot start
    ## now (too many pending: a later render asks again).
    if runtime.pendingFor() >= MaxAsyncWaitsPerApp:
      return false
    inc nextAsyncId
    var request = imageRequest(owner, url, width, height)
    request.id = nextAsyncId
    if not submitJsIo(request):
      return false
    asyncWaits.add AsyncWait(id: nextAsyncId, runtime: runtime, ctx: runtime.js.context, owner: owner,
      kind: akUrlImage, url: url, width: width, height: height, fit: fit, like: likeOf(context))
    true

  proc runAsync(wait: AsyncWait, fnName: string, args: openArray[JSValueConst]): bool =
    ## Enter an app's interpreter outside a render: settle a promise, then run
    ## what that lets run, up to the next await.
    ## False when the interpreter it was waiting in is gone.
    if not wait.alive():
      return false
    let runtime = wait.runtime
    let ctx = wait.ctx
    runtime.midCall:
      let armedHere = runtime.js.armDeadline(sliceMs())
      try:
        withAppEnv(ctx, asyncEnv(wait)):
          let value = callGlobalFunction(ctx, fnName, args)
          if JS_IsException(value) != 0:
            frameos_apps.logError(wait.owner, "async code failed: " &
              runtime.appText(mappedJsExceptionDetails(ctx).message))
          JS_FreeValue(ctx, value)
          runtime.js.runPendingJobs()
        if runtime.js.deadlineTripped():
          frameos_apps.logError(wait.owner, "async code ran for " & $sliceMs() &
            " ms without an await and was stopped")
      finally:
        if armedHere:
          runtime.js.disarmDeadline()
        runtime.closeLineStreams()
    true

  proc settle(id: int, wait: AsyncWait, value: JSValue, failed: bool): bool =
    ## `value`: JSON text, or an answer already made (fetchAnswer); taken.
    let ctx = wait.ctx
    let idValue = nimIntToJS(ctx, id.int32)
    let failedValue = nimBoolToJS(ctx, failed)
    try:
      result = runAsync(wait, "__frameosSettle", [idValue, value, failedValue])
    finally:
      JS_FreeValue(ctx, idValue)
      JS_FreeValue(ctx, value)
      JS_FreeValue(ctx, failedValue)

  proc settle(id: int, wait: AsyncWait, json: string, failed: bool): bool =
    settle(id, wait, nimStringToJS(wait.ctx, json), failed)

  when defined(frameosEmbedded):
    proc fos_js_io_wake_if_waiting() {.importc, cdecl.}
    proc fos_client_input_pending(): bool {.importc, cdecl.}
      ## A tap or a key is queued or just came (main/fos_client.c): it goes
      ## first, and a picture's decode (a couple of hundred ms of the render
      ## task) waits for the next pump, a slice later.

  proc pumpJsAsync*(): int =
    ## Between renders, on the thread that renders: every answer that came
    ## back and every timer that is over settles its promise, and the code
    ## waiting on it runs to its next await; an `<img>`'s picture is decoded
    ## and its scene asked to render. How many settled. Spends about
    ## PumpBudgetMs, at least one answer; the rest waits for the next pump.
    let started = getMonoTime()
    var redraw: seq[tuple[scene: FrameScene, nodeId: int]]
    template overBudget(): bool =
      (getMonoTime() - started).inMilliseconds >= PumpBudgetMs
    # Answers first: each one is a request somebody waits for.
    var answersNow = true
    when defined(frameosEmbedded):
      answersNow = not fos_client_input_pending()
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
        if settle(answer.id, wait, fetchAnswer(wait.ctx, answer), false):
          inc result
      of akUrlImage:
        wait.runtime.rememberUrlImage(decodeAnswer(wait, answer))
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
  var urlImagesOneARender* = false
    ## The browser preview's (frameos_wasm_set_pictures_one_a_render): a page
    ## that shows every frame as it comes gets an `<img>` page's pictures one
    ## a render. A plane's render is the one picture a board or a check gets,
    ## so it waits for all of them.

proc fitName(fit: ScaledDecodeFit): string =
  case fit
  of fitStretch: "stretch"
  of fitContain: "contain"
  else: "cover"

proc keptHasRoom(runtime: JsAppRuntime, pixels: int): bool
  ## Whether one more kept picture of `pixels` pushes none out (app_runtime.nim).

proc drawnKept(runtime: JsAppRuntime, entry: int): Image =
  ## The kept picture of `urlImages[entry]`, which an `<img>` draws now: the
  ## newest of the kept, so the ones a scroll took out of sight go first when
  ## room is needed, never one still on the screen (the Scene store's covers
  ## loaded and vanished as its list scrolled while the oldest loaded went
  ## first, 2026-11-22).
  runtime.urlImages[entry].drawn = runtime.urlPass
  let id = runtime.urlImages[entry].id
  let at = runtime.keptImageIds.find(id)
  if at >= 0 and at < runtime.keptImageIds.high:
    runtime.keptImageIds.delete(at)
    runtime.keptImageIds.add(id)
  runtime.images.getOrDefault(id, nil)

proc urlImage(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext,
    url: string, width, height: int, fit: ScaledDecodeFit, blocking: bool, shown = true): Image =
  ## `<img src="https://…">` at `width` x `height` panel pixels: the picture
  ## if it is here, else a download (off the render unless `blocking`) and,
  ## meanwhile, the same url at another size if one is kept (a box that
  ## changed size), else nothing. Kept pictures: the same url at the same
  ## size is one picture while the interpreter lives. One not `shown` (near
  ## the screen, not on it) is fetched ahead only into room the kept
  ## pictures have: it never pushes out one that shows.
  var at = runtime.findUrlImage(url, width, height, fit)
  if at >= 0:
    case runtime.urlImages[at].state
    of uiReady:
      let id = runtime.urlImages[at].id
      if runtime.keptImageIds.contains(id):
        return runtime.drawnKept(at)
      if not shown and not runtime.keptHasRoom(width * height):
        return nil
      if shown and runtime.urlImages[at].drawn >= runtime.urlPass - 1 and
          (getMonoTime() - runtime.urlImages[at].at).inMilliseconds < UrlImageChurnMs:
        runtime.urlImages[at] = UrlImage(url: url, width: width, height: height, fit: fit,
          state: uiFailed, at: getMonoTime())
      else:
        at = -1
    of uiFailed:
      if (getMonoTime() - runtime.urlImages[at].at).inMilliseconds >= UrlImageRetryMs:
        at = -1
    of uiLoading:
      discard
  if at < 0 and not shown and not runtime.keptHasRoom(width * height):
    return nil
  if at < 0:
    # Nothing pumps (the browser preview, a deep sleeper): no later to fetch
    # in, so the render does. Asked only where the async I/O is compiled in,
    # the browser preview never fetched an `<img>` at all.
    var now = blocking or url.startsWith("data:") or not asyncPumped
    when jsAsyncOn:
      if not now:
        if startUrlImage(runtime, owner, context, url, width, height, fit):
          runtime.rememberUrlImage(UrlImage(url: url, width: width, height: height, fit: fit,
            state: uiLoading, at: getMonoTime()))
    when defined(frameosWasm):
      # The preview: nothing pumps, and a render that fetched every picture of
      # a page one after the other would show nothing for seconds. One picture
      # a render, and the next render soon. Marked on the render's context: a
      # pointer to the last one was kept before, and a new render's context
      # made where the last was freed passed for it, so no picture came after
      # that and the scene asked for a render every 50 ms.
      if now and urlImagesOneARender and not url.startsWith("data:") and not context.isNil:
        if context.urlImageFetched:
          if context.nextSleep < 0 or context.nextSleep > 0.05:
            context.nextSleep = 0.05
          now = false
        else:
          context.urlImageFetched = true
    if now:
      let e = JsAppEvalEnv(runtime: runtime, owner: owner, context: context)
      let answer = fetchImageJson(e, url, %*{"width": width, "height": height, "fit": fitName(fit)},
        forceKeep = true)
      let image = answer{"image"}
      var entry = UrlImage(url: url, width: width, height: height, fit: fit, state: uiFailed, at: getMonoTime(),
        drawn: runtime.urlPass)
      if not image.isNil and image.kind == JObject:
        entry.state = uiReady
        entry.id = image{"id"}.getInt()
      else:
        urlImageFailed(owner, url, answer{"error"}.getStr())
      runtime.rememberUrlImage(entry)
      if entry.state == uiReady:
        return runtime.images.getOrDefault(entry.id, nil)
  # Meanwhile: the same picture at another size.
  for i, entry in runtime.urlImages:
    if entry.state == uiReady and entry.url == url and runtime.keptImageIds.contains(entry.id):
      return runtime.drawnKept(i)

type UrlView = array[4, float32]
  ## Left, top, right, bottom, in a node's own coordinates.

const UrlViewAll: UrlView = [-1e9'f32, -1e9, 1e9, 1e9]

proc attrNum(node: SvgNode, name: string, default: float32): float32 =
  let text = node.attr(name)
  if text.len == 0:
    return default
  try: parseFloat(text).float32
  except ValueError: default

proc meets(view: UrlView, x, y, width, height: float32): bool {.inline.} =
  not (x + width < view[0] or x > view[2] or y + height < view[1] or y > view[3])

proc fillUrlImagesIn(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext,
    node: SvgNode, scale: float32, blocking: bool, view, seen: UrlView, shown: var seq[int]) =
  ## `view`: what is near the screen, `seen`: what is on it, both in the
  ## node's coordinates. The kept pictures that show go in `shown`.
  let url = node.attr("image-url")
  if url.len > 0:
    let
      x = node.attrNum("x", 0)
      y = node.attrNum("y", 0)
      width = node.attrNum("width", 0)
      height = node.attrNum("height", 0)
    if not view.meets(x, y, width, height):
      # Out of sight and not near it: fetched when a scroll brings it close,
      # and drawn as nothing until then (a picture it had stays).
      if node.image.isNil and node.tag != "g":
        node.tag = "g"
        node.forgetParse()
      return
    let
      w = max(1, round(width * scale).int)
      h = max(1, round(height * scale).int)
      fit = case node.attr("preserveAspectRatio")
        of "none": fitStretch
        of "xMidYMid meet": fitContain
        else: fitCover
      onScreen = seen.meets(x, y, width, height)
      image = runtime.urlImage(owner, context, url, w, h, fit, blocking, onScreen)
      tag = if image.isNil: "g" else: "image"
    if onScreen and not image.isNil:
      let at = runtime.findUrlImage(url, w, h, fit)
      if at >= 0 and runtime.urlImages[at].state == uiReady:
        shown.add runtime.urlImages[at].id
    if node.image != image or node.tag != tag:
      node.image = image
      node.tag = tag
      node.forgetParse()
    return
  var inner = view
  var innerSeen = seen
  if node.tag == "svg" and node.attr("viewBox").len > 0:
    # A box that clips or scrolls (ui/layout.nim `viewport`): the part of the
    # view it shows, and a screen of itself around that, in its coordinates.
    let parts = node.attr("viewBox").replace(",", " ").splitWhitespace()
    let
      x = node.attrNum("x", 0)
      y = node.attrNum("y", 0)
      w = node.attrNum("width", 0)
      h = node.attrNum("height", 0)
    var box: array[4, float32]
    var ok = parts.len == 4 and w > 0 and h > 0
    if ok:
      for i in 0 .. 3:
        try: box[i] = parseFloat(parts[i]).float32
        except ValueError: ok = false
    if ok and box[2] > 0 and box[3] > 0:
      let
        sx = box[2] / w
        sy = box[3] / h
        left = max(view[0], x) - w
        top = max(view[1], y) - h
        right = min(view[2], x + w) + w
        bottom = min(view[3], y + h) + h
      inner = [box[0] + (left - x) * sx, box[1] + (top - y) * sy,
        box[0] + (right - x) * sx, box[1] + (bottom - y) * sy]
      let
        sLeft = max(seen[0], x)
        sTop = max(seen[1], y)
        sRight = min(seen[2], x + w)
        sBottom = min(seen[3], y + h)
      innerSeen = [box[0] + (sLeft - x) * sx, box[1] + (sTop - y) * sy,
        box[0] + (sRight - x) * sx, box[1] + (sBottom - y) * sy]
    else:
      inner = UrlViewAll
      innerSeen = UrlViewAll
  elif node.attr("transform").len > 0:
    # Moved, scaled or turned (the layout does so only to an inline <svg>,
    # which holds no <img>): every picture in it, as before.
    inner = UrlViewAll
    innerSeen = UrlViewAll
  for child in node.children:
    runtime.fillUrlImagesIn(owner, context, child, scale, blocking, inner, innerSeen, shown)

proc fillUrlImages(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext,
    node: SvgNode, scale: float32, blocking: bool) =
  ## The layout's `<img src="https://…">`s (ui/layout.nim `image-url`), each
  ## given its picture at the size it was laid out at, in panel pixels;
  ## nothing drawn where there is none yet. Only the pictures that show, or
  ## are within a screen of showing (a box that scrolls: within a box's
  ## height of its viewport), are fetched, as a browser's lazy loading does:
  ## a long page's every picture at once pushed each other out of the kept
  ## ones (docs/async-js.md).
  let
    w = node.attrNum("width", 0)
    h = node.attrNum("height", 0)
    view = if w > 0 and h > 0: [-w, -h, 2 * w, 2 * h] else: UrlViewAll
    seen = if w > 0 and h > 0: [0'f32, 0, w, h] else: UrlViewAll
  inc runtime.urlPass
  var shown: seq[int]
  runtime.fillUrlImagesIn(owner, context, node, scale, blocking, view, seen, shown)
  # The pictures that show are the newest of the kept, after those only
  # near: when room is needed, what is off the screen goes first.
  for id in shown:
    let at = runtime.keptImageIds.find(id)
    if at >= 0 and at < runtime.keptImageIds.high:
      runtime.keptImageIds.delete(at)
      runtime.keptImageIds.add(id)
