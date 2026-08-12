import std/[httpclient, net, os, strutils, times, unittest]

import ../../spool
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
    var authHeader = ""
    try:
      requestLine = client.recvLine(timeout = 5000)
      # drain headers, remembering the credentials the client chose to send
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
        if line.toLowerAscii().startsWith("authorization:"):
          authHeader = line.split(':', 1)[1].strip()
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
    of "/echo-auth":
      respond(client, "HTTP/1.1 200 OK\r\nContent-Length: " & $authHeader.len &
        "\r\n\r\n" & authHeader)
    of "/redirect-same-origin":
      respond(client, "HTTP/1.1 302 Found\r\nLocation: /echo-auth\r\nContent-Length: 0\r\n\r\n")
    of "/redirect-other-origin":
      # Same server, different origin as far as the URL is concerned.
      respond(client, "HTTP/1.1 302 Found\r\nLocation: http://localhost:" &
        $int(serverPort) & "/echo-auth\r\nContent-Length: 0\r\n\r\n")
    of "/redirect-loop":
      respond(client, "HTTP/1.1 302 Found\r\nLocation: /redirect-loop\r\nContent-Length: 0\r\n\r\n")
    of "/big":
      respond(client, "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n" & "x".repeat(1000))
    of "/spool-large":
      var body = newStringOfCap(200_000)
      for i in 0 ..< 200_000:
        body.add(chr(ord('a') + i mod 26))
      respond(client, "HTTP/1.1 200 OK\r\nContent-Length: " & $body.len & "\r\n\r\n" & body)
    of "/spool-redirect":
      # The 302 carries a body of its own; none of it may end up in the spool.
      respond(client, "HTTP/1.1 302 Found\r\nLocation: /spool-large\r\n" &
        "Content-Length: 22\r\n\r\nredirect body, not you")
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

  test "an unresolvable host fails fast the second time":
    # The first attempt pays the resolver's own timeout; the failure is then
    # cached, which is what stops a blackholed resolver from parking every
    # worker thread on every request.
    forgetResolvedHosts()
    let host = "no-such-host.frameos-tests.invalid"
    expect CatchableError:
      discard boundedGetContent("http://" & host & "/x", timeoutMs = 2000, maxSeconds = 5.0)
    let startedAt = epochTime()
    expect CatchableError:
      discard boundedGetContent("http://" & host & "/x", timeoutMs = 2000, maxSeconds = 5.0)
    check epochTime() - startedAt < 0.2

  test "honours a redirect cap below the default":
    # /redirect bounces once, so a cap of zero must refuse to follow it.
    expect HttpRequestError:
      discard boundedRequest(baseUrl() & "/redirect", maxRedirects = 0)
    check boundedRequestContent(baseUrl() & "/redirect", maxRedirects = 1) == "hello world"


  test "credentials survive a same-origin redirect":
    var headers = newHttpHeaders({"Authorization": "Bearer secret-token"})
    check boundedRequestContent(baseUrl() & "/redirect-same-origin", headers = headers) ==
      "Bearer secret-token"

  test "credentials are stripped when a redirect crosses origins":
    # An open redirect on the first host must not hand the caller's bearer
    # token to whatever the Location header names.
    var headers = newHttpHeaders({"Authorization": "Bearer secret-token"})
    check boundedRequestContent(baseUrl() & "/redirect-other-origin", headers = headers) == ""
    # The header the caller passed in is untouched for its own next use.
    check headers["Authorization"] == "Bearer secret-token"

  test "a large body streams into a file-backed spool":
    # The whole point of boundedGetSpool: past the threshold the body lands in
    # a file as it comes off the socket, and never exists whole in memory.
    let dir = getTempDir() / "frameos-http-spool-test"
    removeDir(dir)
    var expected = newStringOfCap(200_000)
    for i in 0 ..< 200_000:
      expected.add(chr(ord('a') + i mod 26))
    let spooled = boundedGetSpool(baseUrl() & "/spool-large",
      spoolThresholdBytes = 16 * 1024, spoolDir = dir)
    check spooled.isFileBacked()
    check spooled.len == 200_000
    check spooled.materialize() == expected

  test "a small body stays an in-memory spool":
    let spooled = boundedGetSpool(baseUrl() & "/content-length",
      spoolThresholdBytes = 16 * 1024)
    check not spooled.isFileBacked()
    check spooled.materialize() == "hello world"

  test "chunked transfer streams into the spool too":
    let spooled = boundedGetSpool(baseUrl() & "/chunked",
      spoolThresholdBytes = 4,
      spoolDir = getTempDir() / "frameos-http-spool-test")
    check spooled.isFileBacked()
    check spooled.materialize() == "hello world"

  test "a redirect hop's own body never reaches the spool":
    let spooled = boundedGetSpool(baseUrl() & "/spool-redirect",
      spoolThresholdBytes = 16 * 1024,
      spoolDir = getTempDir() / "frameos-http-spool-test")
    check spooled.len == 200_000
    check spooled.materialize().startsWith("abcdefgh")

  test "4xx raises with the error body and leaves no spool file behind":
    let dir = getTempDir() / "frameos-http-spool-404"
    removeDir(dir)
    expect HttpRequestError:
      discard boundedGetSpool(baseUrl() & "/not-found",
        spoolThresholdBytes = 4, spoolDir = dir)
    # The sink only sees 2xx bodies, so nothing was ever written.
    var leftovers = 0
    if dirExists(dir):
      for _ in walkDirRec(dir): inc leftovers
    check leftovers == 0

  test "maxBytes aborts a streaming spool and cleans up its file":
    let dir = getTempDir() / "frameos-http-spool-capped"
    removeDir(dir)
    expect IOError:
      discard boundedGetSpool(baseUrl() & "/spool-large",
        maxBytes = 50_000, spoolThresholdBytes = 4 * 1024, spoolDir = dir)
    var leftovers = 0
    if dirExists(dir):
      for _ in walkDirRec(dir): inc leftovers
    check leftovers == 0

  test "stops test server":
    try:
      discard boundedGetContent(baseUrl() & "/quit", timeoutMs = 1000, maxSeconds = 2.0)
    except CatchableError:
      discard
    check true
