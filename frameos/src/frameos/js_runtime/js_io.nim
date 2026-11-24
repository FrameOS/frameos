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
##
## A request with `pieceBytes` set is answered in pieces (`fetch`'s `onChunk`,
## docs/async-js.md "A response in pieces"): `jkPiece` results in order, each
## the next bytes of the body, then one `jkEnd`. The first of them has the
## response's `head`: the URL it came from on its first line and its headers
## on the rest. An ESP32 reads the pieces off the socket as the app takes
## them and never holds the body; a Pi downloads it whole first.

import ../utils/http_client

type
  JsIoRequest* = object
    id*: int ## 0 stops the worker that takes it
    url*, httpMethod*, body*: string
    headers*: seq[SimpleHttpHeader]
    timeoutMs*, maxBytes*: int
    maxSeconds*: float
    pieceBytes*: int ## > 0: the answer in pieces of this size

  JsIoKind* = enum
    jkWhole ## a request's one answer
    jkPiece ## a piece of a streamed body: more answers follow
    jkEnd   ## a streamed body's end (`error`: why it was cut short)

  JsIoResult* = object
    id*: int
    code*: int
    error*: string ## empty when the request was answered
    headers*: seq[SimpleHttpHeader] ## a Pi's, and a stream's; the ESP32's glue keeps no other
    kind*: JsIoKind
    url*: string    ## a Pi's: where the answer came from, after redirects
    head*: string   ## a stream's first answer: that URL ("" when no redirect was followed
                    ## or the runtime cannot tell), a line break, and the response's
                    ## headers, "name: value" a line
    piece*: string  ## jkPiece: its bytes
    when defined(frameosEmbedded):
      response*: BoundedHttpBufferResponse ## the glue's chunks, until freed
    else:
      body*: string

when defined(frameosEmbedded):
  const JsIoWorkers* = 1
    ## One TLS session at a time (the header above).

  proc fos_js_io_submit(id: cint, httpMethod, url: cstring, headers: pointer, headersLen: csize_t,
      body: pointer, bodyLen: csize_t, timeoutMs: cint, maxBytes: csize_t,
      pieceBytes: csize_t): bool {.importc, cdecl.}
  proc fos_js_io_take(id: ptr cint, status: ptr cint, chunks: ptr pointer,
      count: ptr csize_t, kind: ptr cint, head: ptr pointer, waitMs: cint): bool {.importc, cdecl.}
  proc fos_js_io_cancel(id: cint) {.importc, cdecl.}
  proc fos_js_io_in_flight(): cint {.importc, cdecl.}
  proc c_free(p: pointer) {.importc: "free", header: "<stdlib.h>".}

  proc submitJsIo*(request: sink JsIoRequest): bool =
    ## On the render task: one request for the I/O task. False when its
    ## queue is full or there is no memory for it (the caller answers the
    ## app at once).
    let headerBlock = encodeHttpHeaders(request.headers)
    fos_js_io_submit(request.id.cint, request.httpMethod.cstring, request.url.cstring,
      (if headerBlock.len > 0: unsafeAddr headerBlock[0] else: nil), headerBlock.len.csize_t,
      (if request.body.len > 0: unsafeAddr request.body[0] else: nil), request.body.len.csize_t,
      request.timeoutMs.cint, request.maxBytes.csize_t, request.pieceBytes.csize_t)

  proc cancelJsIo*(id: int) =
    ## On the render task: nobody waits for request `id` any more. One not
    ## started is dropped and a stream being read is closed; no answer for
    ## it comes after this.
    fos_js_io_cancel(id.cint)

  proc takeJsIoResult*(waitMs = 0): tuple[ok: bool, result: JsIoResult] =
    ## On the render task: an answer, if one came back (or comes within
    ## `waitMs`). Its chunks are the caller's to free (`releaseJsIoResult`,
    ## `jsIoText`, or the decode).
    var
      id, status, kind: cint
      chunks, head: pointer
      count: csize_t
    if not fos_js_io_take(addr id, addr status, addr chunks, addr count, addr kind, addr head, waitMs.cint):
      return
    result.ok = true
    result.result.id = id.int
    if kind != 0:
      # A piece of a streamed body or its end: copied, and the task's
      # buffers freed.
      result.result.kind = if kind == 1: jkPiece else: jkEnd
      result.result.code = status.int
      if head != nil:
        result.result.head = $cast[cstring](head)
        c_free(head)
      if chunks != nil:
        if kind == 1:
          result.result.piece = newString(count.int)
          if count > 0:
            copyMem(addr result.result.piece[0], chunks, count.int)
        else:
          result.result.error = $cast[cstring](chunks)
        c_free(chunks)
      if status == 0 and result.result.error.len == 0:
        result.result.error = "request failed"
      return
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

  proc sendPieces(whole: var JsIoResult, pieceBytes: int) =
    ## A body in pieces: a Pi has it whole by now (inflated here when it came
    ## gzipped), so the pieces only keep it from being one JS string.
    var last = JsIoResult(id: whole.id, kind: jkEnd, code: whole.code, error: whole.error)
    if whole.error.len == 0:
      last.head = whole.url & "\n"
      for (name, value) in whole.headers:
        last.head.add name & ": " & value & "\n"
      var body = move(whole.body)
      try:
        body = inflatedBody(body, last.head)
      except CatchableError:
        body = ""
        last.error = "the answer does not inflate"
      var at = 0
      while at < body.len:
        let n = min(pieceBytes, body.len - at)
        var piece = JsIoResult(id: whole.id, kind: jkPiece, code: whole.code, piece: body[at ..< at + n])
        piece.head = move(last.head)
        last.head = ""
        results.send(piece)
        at += n
    else:
      last.code = 0
    results.send(last)

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
          answer.url = response.url
          if not response.headers.isNil:
            for name, value in response.headers.pairs:
              answer.headers.add((name, value))
      except CatchableError as error:
        answer.error = error.msg
        if answer.error.len == 0:
          answer.error = "request failed"
      if request.pieceBytes > 0:
        sendPieces(answer, request.pieceBytes)
      else:
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

  proc cancelJsIo*(id: int) =
    ## Nobody waits for request `id` any more. A Pi's request runs on (its
    ## answer, or the pieces of it, are dropped as they come).
    discard

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
