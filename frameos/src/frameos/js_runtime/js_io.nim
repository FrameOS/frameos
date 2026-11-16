## Async JavaScript's I/O (docs/async-js.md): the HTTP requests a JS app's
## `fetch`, `frameos.loadImage` and `frameos.useImage` start, made off the
## thread that renders, and their answers handed back to it.
##
## Only values cross: a request is strings and numbers, an answer the status,
## the headers and the body (AGENTS.md, "Refs do not cross threads"). The
## render thread owns every interpreter and every promise; it hands requests
## out with `submitJsIo` and takes answers back with `takeJsIoResult`, and
## whatever finishes one wakes it, so the app resumes without waiting for the
## loop's next slice.
##
## - A Pi: JsIoWorkers threads with the HTTP client every app uses
##   (utils/http_client.nim), whose shared state (the DNS cache, the local
##   network policy) is behind its own locks; `wakeRunner` wakes the runner.
## - An ESP32: one FreeRTOS task (components/frameos_nim/fos_js_io.c), made when there is work
##   and gone when there is none, one TLS session at a time: ~40 KB of
##   internal RAM a session is what an ESP32-S3 runs short of first. The body
##   stays in the glue's PSRAM chunks until the render task decodes or copies
##   it; the task wakes the render task's wait (fos_client_wake_for_events).
## - The wasm runtime has none: async calls run there as the blocking calls
##   they replace (js_async.nim, `asyncPumped`).

import ../utils/http_client

type
  JsIoRequest* = object
    id*: int ## 0 stops the worker that takes it
    url*, httpMethod*, body*: string
    headers*: seq[SimpleHttpHeader]
    timeoutMs*, maxBytes*: int
    maxSeconds*: float

  JsIoResult* = object
    id*: int
    code*: int
    error*: string ## empty when the request was answered
    headers*: seq[SimpleHttpHeader] ## a Pi's; the ESP32's glue keeps none
    when defined(frameosEmbedded):
      response*: BoundedHttpBufferResponse ## the glue's chunks, until freed
    else:
      body*: string

when defined(frameosEmbedded):
  const JsIoWorkers* = 1
    ## One TLS session at a time (the header above).

  proc fos_js_io_submit(id: cint, httpMethod, url: cstring, headers: pointer, headersLen: csize_t,
      body: pointer, bodyLen: csize_t, timeoutMs: cint, maxBytes: csize_t): bool {.importc, cdecl.}
  proc fos_js_io_take(id: ptr cint, status: ptr cint, chunks: ptr pointer,
      count: ptr csize_t): bool {.importc, cdecl.}
  proc fos_js_io_in_flight(): cint {.importc, cdecl.}

  proc submitJsIo*(request: sink JsIoRequest): bool =
    ## On the render task: one request for the I/O task. False when its
    ## queue is full or there is no memory for it (the caller answers the
    ## app at once).
    let headerBlock = encodeHttpHeaders(request.headers)
    fos_js_io_submit(request.id.cint, request.httpMethod.cstring, request.url.cstring,
      (if headerBlock.len > 0: unsafeAddr headerBlock[0] else: nil), headerBlock.len.csize_t,
      (if request.body.len > 0: unsafeAddr request.body[0] else: nil), request.body.len.csize_t,
      request.timeoutMs.cint, request.maxBytes.csize_t)

  proc takeJsIoResult*(): tuple[ok: bool, result: JsIoResult] =
    ## On the render task: an answer, if one came back. Its chunks are the
    ## caller's to free (`releaseJsIoResult`, `jsIoText`, or the decode).
    var
      id, status: cint
      chunks: pointer
      count: csize_t
    if not fos_js_io_take(addr id, addr status, addr chunks, addr count):
      return
    result.ok = true
    result.result.id = id.int
    let adopted = adoptHttpChunks(status.int, chunks, count)
    result.result.error = adopted.error
    if adopted.error.len == 0:
      result.result.code = status.int
      result.result.response = adopted.response

  proc releaseJsIoResult*(answer: var JsIoResult) =
    freeHttpBufferResponse(answer.response)

  proc jsIoText*(answer: var JsIoResult): string =
    ## The body as text; its chunks are freed.
    result = httpBufferText(answer.response)
    freeHttpBufferResponse(answer.response)

  proc jsIoInFlight*(): int =
    fos_js_io_in_flight().int

  proc stopJsIo*() = discard

else:
  import std/[atomics, httpcore, locks]
  import ../channels

  const JsIoWorkers* = 4
    ## Requests in flight at once, the frame over. A fifth waits for a worker.

  when defined(testing):
    var jsIoHook*: proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.}
      ## Test seam: answers every request here instead of on the network. Set
      ## before the first request; the workers only read it.

  var
    ioLock: Lock
    started: bool
    requests: Channel[JsIoRequest]
    results: Channel[JsIoResult]
    workers: array[JsIoWorkers, Thread[void]]
    inFlight: Atomic[int]

  initLock(ioLock)

  proc work() {.thread.} =
    while true:
      let request = requests.recv()
      if request.id == 0:
        break
      var answer = JsIoResult(id: request.id)
      try:
        var answered = false
        when defined(testing):
          {.cast(gcsafe).}:
            if jsIoHook != nil:
              answer = jsIoHook(request)
              answer.id = request.id
              answered = true
        if not answered:
          let response = boundedRequestWithHeaders(request.url, httpMethod = request.httpMethod,
            body = request.body, headers = request.headers, timeoutMs = request.timeoutMs,
            maxBytes = request.maxBytes, maxSeconds = request.maxSeconds)
          answer.code = response.code
          answer.body = response.body
          if not response.headers.isNil:
            for name, value in response.headers.pairs:
              answer.headers.add((name, value))
      except CatchableError as error:
        answer.error = error.msg
        if answer.error.len == 0:
          answer.error = "request failed"
      results.send(answer)
      discard inFlight.fetchSub(1)
      wakeRunner()

  proc ensureStarted() =
    withLock ioLock:
      if started:
        return
      requests.open()
      results.open()
      for i in 0 ..< JsIoWorkers:
        createThread(workers[i], work)
      started = true

  proc submitJsIo*(request: sink JsIoRequest): bool =
    ## On the runner thread: one request for a worker.
    ensureStarted()
    discard inFlight.fetchAdd(1)
    requests.send(request)
    true

  proc takeJsIoResult*(): tuple[ok: bool, result: JsIoResult] =
    ## On the runner thread: an answer, if one came back.
    if not started:
      return
    let (ok, answer) = results.tryRecv()
    (ok, answer)

  proc releaseJsIoResult*(answer: var JsIoResult) =
    answer.body = ""

  proc jsIoText*(answer: var JsIoResult): string =
    move(answer.body)

  proc jsIoInFlight*(): int =
    ## Requests handed out and not answered yet.
    inFlight.load()

  proc stopJsIo*() =
    ## Tests: the workers end once they have answered what they hold.
    withLock ioLock:
      if not started:
        return
      for i in 0 ..< JsIoWorkers:
        requests.send(JsIoRequest(id: 0))
      joinThreads(workers)
      requests.close()
      results.close()
      started = false
