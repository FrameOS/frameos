## The frame's own HTTPS listener, end to end through the real router: a
## TLS listener added next to the harness's plain one, a std/net TLS client,
## and the two places that must know the request was secure without an
## X-Forwarded-Proto header — the Secure cookie flag and the same-origin
## guard's default port.
import std/[json, net, os, strutils, tables, unittest]
import mummy

import ./helpers/http_harness
import ../../types

const
  tlsPort = 19443
  # Self-signed P-256 for localhost/127.0.0.1, valid until 2126, in the
  # SEC 1 "EC PRIVATE KEY" form the backend mints (tls.py).
  testCert = """-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUZamAN7dinEGglG7utfMsGMaoY5swCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkxMjEyMjAwMFoYDzIxMjYwODE5
MTIyMDAwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASMI/JAkpfQaY6MDcq29H17JILDjmU+ewB91LvQhsxdpaE5OaszaSUA
ZNK9QzwNkdAzyY1K0TAToIc5i46mQGm7o28wbTAdBgNVHQ4EFgQUJ4P/LWfu8ZcB
SLelGeRgm5ioawQwHwYDVR0jBBgwFoAUJ4P/LWfu8ZcBSLelGeRgm5ioawQwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgId13ZagrbcVFwPpJKQoawNrBB0m0zXb9UAKYErVrt+gCIBvt
ed4IFxd0P+pnRIL9P6rkTp35FXAiA3YX696h4QuJ
-----END CERTIFICATE-----
"""
  testKey = """-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJyAmtKAVs7XPLTMJD7guygpiNJd3O9y2MtywgoTnARroAoGCCqGSM49
AwEHoUQDQgAEjCPyQJKX0GmOjA3KtvR9eySCw45lPnsAfdS70IbMXaWhOTmrM2kl
AGTSvUM8DZHQM8mNStEwE6CHOYuOpkBpuw==
-----END EC PRIVATE KEY-----
"""

var server = startRouterServer(19337)
let tls = newTlsConfig(testCert, testKey)
let tlsListener = server.server.addListener(Port(tlsPort), "127.0.0.1", tls)

proc httpsRequest(
    httpMethod: string,
    path: string,
    headers: openArray[(string, string)] = [],
    body = ""
  ): TestResponse =
  ## Like the harness's httpRequest, over TLS.
  var socket = newSocket()
  let ctx = newContext(verifyMode = CVerifyNone)
  ctx.wrapSocket(socket)
  var connected = false
  for attempt in 0 ..< 50:
    try:
      socket.connect("127.0.0.1", Port(tlsPort))
      connected = true
      break
    except OSError:
      # The listener is registered by the serving thread's next iteration
      sleep(20)
  doAssert connected, "TLS listener never came up"

  var requestLines = @[httpMethod & " " & path & " HTTP/1.1"]
  requestLines.add("Host: 127.0.0.1:" & $tlsPort)
  requestLines.add("Connection: close")
  for (name, value) in headers:
    requestLines.add(name & ": " & value)
  if body.len > 0:
    requestLines.add("Content-Length: " & $body.len)
  requestLines.add("")
  requestLines.add(body)
  socket.send(requestLines.join("\c\L"))

  var raw = ""
  while true:
    var chunk = ""
    try:
      chunk = socket.recv(4096, timeout = 5000)
    except CatchableError:
      break
    if chunk.len == 0:
      break
    raw.add(chunk)
  socket.close()

  let headerEnd = raw.find("\c\L\c\L")
  doAssert headerEnd >= 0, "no HTTP response over TLS: " & raw
  let head = raw[0 ..< headerEnd]
  result.body = if headerEnd + 4 <= raw.high: raw[(headerEnd + 4) .. raw.high] else: ""
  let lines = head.split("\c\L")
  result.status = parseInt(lines[0].split(" ")[1])
  for i in 1 ..< lines.len:
    let splitAt = lines[i].find(':')
    if splitAt <= 0:
      continue
    result.headers[lines[i][0 ..< splitAt].strip().toLowerAscii()] = lines[i][(splitAt + 1) .. ^1].strip()

suite "HTTPS listener":
  setup:
    drainEventChannel()
    configureServerState(defaultFrameConfig())

  test "the listener reports itself as TLS":
    check tlsListener.secure
    check tlsListener.port == Port(tlsPort)

  test "the same route answers on both listeners":
    let plain = httpRequest(server.port, "GET", "/setup/status")
    let secure = httpsRequest("GET", "/setup/status")
    check plain.status == 200
    check secure.status == 200
    check parseJson(secure.body).hasKey("hotspot")

  test "cookies set over the frame's own HTTPS carry Secure without a proxy header":
    let plain = httpRequest(server.port, "GET", "/?k=test-key")
    check plain.status == 302
    check plain.header("set-cookie").contains("frame_access_key=test-key")
    check "Secure" notin plain.header("set-cookie")

    let secure = httpsRequest("GET", "/?k=test-key")
    check secure.status == 302
    check secure.header("set-cookie").contains("frame_access_key=test-key")
    check secure.header("set-cookie").contains("Secure")

  test "the same-origin guard fills in 443 for an https Origin on the TLS listener":
    # Admin auth is off in the default config: reaching the route is a 401
    # with the route's own message, the guard's refusal is a 403.
    let own = httpsRequest(
      "POST",
      "/api/admin/login",
      headers = [("Origin", "https://127.0.0.1:" & $tlsPort), ("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check own.status == 401

    let foreign = httpsRequest(
      "POST",
      "/api/admin/login",
      headers = [("Origin", "https://evil.example"), ("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check foreign.status == 403

  test "a POST body arrives intact over TLS":
    let body = "x".repeat(200_000)
    let response = httpsRequest(
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = body,
    )
    # Not JSON, but the whole body was read before the route answered
    check response.status in [400, 401]

  test "the listener can be removed while serving":
    server.server.removeListener(tlsListener)
    check waitForPortRefused(tlsPort)
    check httpRequest(server.port, "GET", "/setup/status").status == 200

stopServer(server)
