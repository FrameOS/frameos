import std/[json, net, os, strutils, unittest]
import pixie
import std/httpclient

import ../httpUpload
import frameos/driver_context
import frameos/utils/http_client

type LogSink = ref object
  entries: seq[JsonNode]

proc makeLogger(sink: LogSink): DriverLogger =
  result = DriverLogger(enabled: true)
  result.log = proc(payload: JsonNode) =
    sink.entries.add(copy(payload))

proc makeImage(): Image =
  result = newImage(2, 2)
  result.fill(rgba(10, 20, 30, 255))

suite "httpUpload driver":
  teardown:
    requestHook = nil

  test "render returns early when url is empty":
    let sink = LogSink(entries: @[])
    var requestCount = 0
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      requestCount.inc
      (200, "")

    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "",
      headers: @[],
      lastHash: ""
    )

    driver.render(makeImage())
    check requestCount == 0
    check sink.entries.len == 0

  test "render sets default content type and skips duplicate hash":
    let sink = LogSink(entries: @[])
    var requestCount = 0
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      requestCount.inc
      check headers.hasKey("X-Test")
      check headers["X-Test"] == "1"
      check headers["Content-Type"] == "image/png"
      check headers["X-FrameOS-Driver"] == "httpUpload"
      check headers["X-FrameOS-Image-Hash"].len > 0
      check headers["X-FrameOS-Image-Width"] == "2"
      check headers["X-FrameOS-Image-Height"] == "2"
      check parseInt(headers["X-FrameOS-Image-Bytes"]) > 0
      (204, "")

    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "https://example.com/upload",
      headers: @[HttpHeaderPair(name: "X-Test", value: "1")],
      lastHash: ""
    )

    let image = makeImage()
    driver.render(image)
    driver.render(image)

    check requestCount == 1
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:httpUpload"
    check sink.entries[0]["status"].getInt() == 204

  test "render preserves explicit content type header":
    let sink = LogSink(entries: @[])
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      check headers["Content-Type"] == "application/octet-stream"
      (200, "")

    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "https://example.com/upload",
      headers: @[HttpHeaderPair(name: "Content-Type", value: "application/octet-stream")],
      lastHash: ""
    )

    driver.render(makeImage())
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:httpUpload"

  test "render logs status errors and request exceptions":
    let sink = LogSink(entries: @[])
    var failWithException = false
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      if failWithException:
        raise newException(ValueError, "request failed")
      (500, "upstream failure")

    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "https://example.com/upload",
      headers: @[],
      lastHash: ""
    )

    driver.render(makeImage())
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:httpUpload:error"
    check sink.entries[0]["status"].getInt() == 500
    check sink.entries[0]["error"].getStr() == "upstream failure"

    failWithException = true
    driver.lastHash = ""
    driver.render(makeImage())
    check sink.entries.len == 2
    check sink.entries[1]["event"].getStr() == "driver:httpUpload:error"
    check sink.entries[1].hasKey("status") == false
    check sink.entries[1]["error"].getStr() == "request failed"

## A tiny blocking HTTP server on a thread: it reads one POST, then answers
## with a 500 whose body describes what it saw, so the driver's error log
## carries the request the bounded client actually sent.
var uploadServerPort: Port
var uploadServerThread: Thread[void]

proc uploadServerLoop() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  uploadServerPort = boundPort

  while true:
    var client: Socket
    server.accept(client)
    var requestLine = ""
    var contentType = ""
    var extra = ""
    var contentLength = 0
    var hostSeen = 0
    try:
      requestLine = client.recvLine(timeout = 5000)
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
        let lowered = line.toLowerAscii()
        if lowered.startsWith("content-type:"):
          contentType = line.split(':', 1)[1].strip()
        elif lowered.startsWith("content-length:"):
          contentLength = parseInt(line.split(':', 1)[1].strip())
        elif lowered.startsWith("x-test:"):
          extra = line.split(':', 1)[1].strip()
        elif lowered.startsWith("host:"):
          inc hostSeen
      var body = ""
      while body.len < contentLength:
        let chunk = client.recv(contentLength - body.len, timeout = 5000)
        if chunk.len == 0:
          break
        body.add(chunk)
      let parts = requestLine.splitWhitespace()
      let summary = (if parts.len > 0: parts[0] else: "?") & "|" & contentType & "|" & extra &
        "|" & $body.len & "|hosts=" & $hostSeen & "|png=" & $(body.startsWith("\x89PNG"))
      if parts.len >= 2 and parts[1] == "/quit":
        client.send("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        client.close()
        break
      client.send("HTTP/1.1 500 Internal Server Error\r\nContent-Length: " & $summary.len &
        "\r\n\r\n" & summary)
    except CatchableError:
      discard
    client.close()

suite "httpUpload driver on the bounded client":
  teardown:
    requestHook = nil

  test "a configured header carrying CRLF is refused before any request goes out":
    let sink = LogSink(entries: @[])
    var requestCount = 0
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      requestCount.inc
      (200, "")

    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "https://example.com/upload",
      headers: @[HttpHeaderPair(name: "X-Test", value: "1\r\nX-Injected: yes")],
      lastHash: ""
    )
    driver.render(makeImage())
    check requestCount == 0
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:httpUpload:error"
    check "control character" in sink.entries[0]["error"].getStr()

    # A header name that is not a token is refused the same way.
    driver.headers = @[HttpHeaderPair(name: "X Test", value: "1")]
    driver.lastHash = ""
    driver.render(makeImage())
    check requestCount == 0
    check sink.entries.len == 2
    check "header name" in sink.entries[1]["error"].getStr()

  test "hop-by-hop and framing headers belong to the client and are dropped":
    let sink = LogSink(entries: @[])
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      check not headers.hasKey("Host")
      check not headers.hasKey("Content-Length")
      check not headers.hasKey("Connection")
      check headers["X-Kept"] == "yes"
      (204, "")

    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "https://example.com/upload",
      headers: @[
        HttpHeaderPair(name: "Host", value: "evil.example"),
        HttpHeaderPair(name: "content-length", value: "1"),
        HttpHeaderPair(name: "Connection", value: "keep-alive"),
        HttpHeaderPair(name: "X-Kept", value: "yes"),
      ],
      lastHash: ""
    )
    driver.render(makeImage())
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:httpUpload"

  test "the default request is one bounded POST with the PNG body and headers":
    createThread(uploadServerThread, uploadServerLoop)
    while uploadServerPort == Port(0):
      sleep(10)
    defer:
      try:
        discard boundedRequest("http://127.0.0.1:" & $int(uploadServerPort) & "/quit",
                               timeoutMs = 2000, maxSeconds = 5.0)
      except CatchableError:
        discard
      joinThread(uploadServerThread)

    let sink = LogSink(entries: @[])
    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "http://127.0.0.1:" & $int(uploadServerPort) & "/upload",
      headers: @[HttpHeaderPair(name: "X-Test", value: "seen")],
      lastHash: ""
    )
    driver.render(makeImage())
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:httpUpload:error"
    check sink.entries[0]["status"].getInt() == 500
    let summary = sink.entries[0]["error"].getStr()
    let parts = summary.split('|')
    check parts.len == 6
    check parts[0] == "POST"
    check parts[1] == "image/png"
    check parts[2] == "seen"
    check parseInt(parts[3]) > 0
    check parts[4] == "hosts=1"
    check parts[5] == "png=true"

  test "an unresolvable host fails inside the driver's budget instead of hanging":
    let sink = LogSink(entries: @[])
    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "http://127.0.0.1:1/upload", # nothing listens on port 1
      headers: @[],
      lastHash: ""
    )
    driver.render(makeImage())
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:httpUpload:error"
    check not sink.entries[0].hasKey("status")
