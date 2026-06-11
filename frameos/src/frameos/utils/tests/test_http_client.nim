import std/[httpclient, net, os, strutils, times, unittest]

import ../http_client

## A tiny blocking HTTP server on a thread that routes canned responses by
## path, so the bounded client can be tested end to end without the network.

var serverPort: Port
var serverThread: Thread[void]

proc respond(client: Socket, raw: string) =
  client.send(raw)
  client.close()

proc serverLoop() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  serverPort = boundPort

  while true:
    var client: Socket
    server.accept(client)
    var requestLine = ""
    try:
      requestLine = client.recvLine(timeout = 5000)
      # drain headers
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
    except CatchableError:
      client.close()
      continue

    let parts = requestLine.splitWhitespace()
    let path = if parts.len >= 2: parts[1] else: "/"

    case path
    of "/quit":
      respond(client, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
      break
    of "/content-length":
      respond(client, "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nEtag: \"abc123\"\r\n\r\nhello world")
    of "/chunked":
      respond(client, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" &
        "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")
    of "/eof-body":
      respond(client, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nstreamed until close")
    of "/redirect":
      respond(client, "HTTP/1.1 302 Found\r\nLocation: /content-length\r\nContent-Length: 0\r\n\r\n")
    of "/redirect-loop":
      respond(client, "HTTP/1.1 302 Found\r\nLocation: /redirect-loop\r\nContent-Length: 0\r\n\r\n")
    of "/big":
      respond(client, "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n" & "x".repeat(1000))
    of "/slow":
      # Accept, then never send anything: the client's IO timeout must fire.
      sleep(3000)
      client.close()
    of "/not-found":
      respond(client, "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found")
    else:
      respond(client, "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")

  server.close()

proc baseUrl(): string =
  "http://127.0.0.1:" & $int(serverPort)

suite "bounded http client":
  setup:
    discard

  test "starts test server":
    createThread(serverThread, serverLoop)
    for _ in 0 ..< 100:
      if int(serverPort) != 0:
        break
      sleep(10)
    check int(serverPort) != 0

  test "reads content-length bodies":
    check boundedGetContent(baseUrl() & "/content-length") == "hello world"

  test "reads chunked bodies":
    check boundedGetContent(baseUrl() & "/chunked") == "hello world"

  test "reads connection-close bodies to EOF":
    check boundedGetContent(baseUrl() & "/eof-body") == "streamed until close"

  test "follows redirects":
    check boundedGetContent(baseUrl() & "/redirect") == "hello world"

  test "gives up on redirect loops":
    expect HttpRequestError:
      discard boundedGetContent(baseUrl() & "/redirect-loop")

  test "raises HttpRequestError on 4xx":
    expect HttpRequestError:
      discard boundedGetContent(baseUrl() & "/not-found")

  test "enforces maxBytes":
    expect IOError:
      discard boundedGetContent(baseUrl() & "/big", maxBytes = 100)

  test "head metadata returns length and etag":
    let meta = boundedHeadMetadata(baseUrl() & "/content-length")
    check meta.contentLength == 11
    check meta.etag == "\"abc123\""

  test "a silent server times out within the deadline":
    let startedAt = epochTime()
    expect CatchableError:
      discard boundedGetContent(baseUrl() & "/slow", timeoutMs = 500, maxSeconds = 1.0)
    check epochTime() - startedAt < 2.5

  test "rejects invalid urls":
    expect ValueError:
      discard boundedGetContent("ftp://example.com/x")

  test "stops test server":
    try:
      discard boundedGetContent(baseUrl() & "/quit", timeoutMs = 1000, maxSeconds = 2.0)
    except CatchableError:
      discard
    check true
