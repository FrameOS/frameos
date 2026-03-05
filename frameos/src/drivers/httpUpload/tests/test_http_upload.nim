import std/[json, unittest]
import pixie
import std/httpclient

import ../httpUpload
import frameos/types

type LogSink = ref object
  entries: seq[JsonNode]

proc makeLogger(sink: LogSink): Logger =
  result = Logger(enabled: true)
  result.log = proc(payload: JsonNode) =
    sink.entries.add(copy(payload))
  result.enable = proc() = discard
  result.disable = proc() = discard

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

  test "render returns early when image has no pixels":
    let sink = LogSink(entries: @[])
    var requestCount = 0
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      requestCount.inc
      (200, "")

    let driver = Driver(
      name: "httpUpload",
      logger: makeLogger(sink),
      url: "https://example.com/upload",
      headers: @[],
      lastHash: ""
    )

    var image = makeImage()
    image.data.setLen(0)
    driver.render(image)

    check requestCount == 0
    check driver.lastHash == ""
    check sink.entries.len == 0

  test "render sets default content type and skips duplicate hash":
    let sink = LogSink(entries: @[])
    var requestCount = 0
    requestHook = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
      requestCount.inc
      check headers.hasKey("X-Test")
      check headers["X-Test"] == "1"
      check headers["Content-Type"] == "image/png"
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
