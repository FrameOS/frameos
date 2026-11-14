## Background JavaScript's I/O (docs/background-js.md): the HTTP requests a JS
## app's `frameos.fetch` starts, made on a few worker threads while the runner
## thread renders, and their answers handed back to it.
##
## Only values cross: a request is strings and numbers, an answer the status
## and body text (AGENTS.md, "Refs do not cross threads"). The runner thread
## owns every interpreter and every promise; it hands requests out with
## `submitJsIo` and takes answers back with `takeJsIoResult`, and a worker that
## finishes one wakes it (`wakeRunner`) so the app resumes without waiting for
## the loop's next slice. The HTTP client is the one every app uses
## (utils/http_client.nim), whose shared state (the DNS cache, the local
## network policy) is behind its own locks.
##
## Linux only: the firmware and the wasm runtime have no background JS.

import std/[atomics, locks]
import ../channels
import ../utils/http_client

const JsIoWorkers* = 4
  ## Requests in flight at once, the frame over. A fifth waits for a worker.

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
    body*: string
    error*: string ## empty when the request was answered

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

proc submitJsIo*(request: sink JsIoRequest) =
  ## On the runner thread: one request for a worker.
  ensureStarted()
  discard inFlight.fetchAdd(1)
  requests.send(request)

proc takeJsIoResult*(): tuple[ok: bool, result: JsIoResult] =
  ## On the runner thread: an answer, if one came back.
  if not started:
    return
  let (ok, answer) = results.tryRecv()
  (ok, answer)

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
