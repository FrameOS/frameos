## The management socket over TLS: the link token goes only to a peer whose
## certificate is for the provider's hostname.
##
## Nim's async TLS verifies the chain and never the name, so a certificate
## any trusted CA issued for any other name used to complete the upgrade and
## receive `Authorization: Bearer <link token>`. The stub here is that peer:
## a TLS server whose chain verifies (the test's own CA, handed to the dial
## through `hubDialCaFile`) and whose certificate names another host.
import std/[asyncdispatch, asyncnet, locks, net, os, osproc, strutils, unittest]
import ws

import ../hub_client

const TestPort = 19476
const AccessToken = "hub-tls-name-token"

let dir = getTempDir() / ("frameos-hub-tls-" & $getCurrentProcessId())
createDir(dir)

proc run(command: string) =
  let (output, code) = execCmdEx(command, workingDir = dir)
  if code != 0:
    raise newException(IOError, "openssl failed: " & command & "\n" & output)

proc makeAuthority(name: string) =
  run("openssl req -x509 -newkey rsa:2048 -nodes -keyout " & name & ".key -out " &
      name & ".pem -subj '/CN=FrameOS test " & name & "' -days 2")

proc makeLeaf(name, host, authority: string) =
  writeFile(dir / (name & ".ext"), "subjectAltName=DNS:" & host & "\n")
  run("openssl req -newkey rsa:2048 -nodes -keyout " & name & ".key -out " & name &
      ".csr -subj '/CN=" & host & "'")
  run("openssl x509 -req -in " & name & ".csr -CA " & authority & ".pem -CAkey " &
      authority & ".key -CAcreateserial -out " & name & ".pem -days 2 -extfile " &
      name & ".ext")

makeAuthority("ca")
makeAuthority("otherca")
makeLeaf("right", "localhost", "ca")
makeLeaf("wrong", "other.example", "ca")

var stubLock: Lock
initLock(stubLock)
var servedCert = "" # which leaf the next connection gets
var received = ""   # every byte the stub read after its handshake

proc serve() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(TestPort), "127.0.0.1")
  server.listen()
  while true:
    var client: Socket
    try:
      server.accept(client)
    except CatchableError:
      break
    var certFile, keyFile: string
    {.gcsafe.}:
      withLock stubLock:
        certFile = dir / (servedCert & ".pem")
        keyFile = dir / (servedCert & ".key")
    try:
      let ctx = newContext(verifyMode = CVerifyNone, certFile = certFile, keyFile = keyFile)
      ctx.wrapConnectedSocket(client, handshakeAsServer)
      var secKey = ""
      while true:
        let line = client.recvLine(timeout = 5000)
        {.gcsafe.}:
          withLock stubLock:
            received.add line
        if line == "\r\n" or line.len == 0:
          break
        if line.toLowerAscii().startsWith("sec-websocket-key:"):
          secKey = line.split(":", 1)[1].strip()
      client.send("HTTP/1.1 101 Switching Protocols\r\n" &
                  "Upgrade: websocket\r\nConnection: Upgrade\r\n" &
                  "Sec-WebSocket-Accept: " & webSocketAcceptFor(secKey) & "\r\n\r\n")
    except CatchableError:
      discard
    try:
      client.close()
    except CatchableError:
      discard

var serverThread: Thread[void]
createThread(serverThread, serve)
sleep(200)

proc dial(leaf, authority: string): tuple[connected: bool, error, seen: string] =
  withLock stubLock:
    servedCert = leaf
    received = ""
  hubDialCaFile = dir / (authority & ".pem")
  let handle = DialHandle()
  try:
    let socket = waitFor dialManagementSocket(
      "https://localhost:" & $TestPort, "/api/frames/ws", AccessToken, handle)
    result.connected = true
    socket.tcpSocket.close()
  except CatchableError as error:
    result.error = error.msg
  sleep(300) # let the stub finish reading what was sent
  withLock stubLock:
    result.seen = received

suite "cloud hub socket: the certificate is for the provider":
  test "a provider with a certificate for its name gets the token":
    let outcome = dial("right", "ca")
    check outcome.connected
    check AccessToken in outcome.seen

  test "a trusted certificate for another name never sees the token":
    let outcome = dial("wrong", "ca")
    check not outcome.connected
    check "not for localhost" in outcome.error
    check AccessToken notin outcome.seen
    check "authorization" notin outcome.seen.toLowerAscii()

  test "a certificate from an authority the frame does not trust never sees it":
    let outcome = dial("right", "otherca")
    check not outcome.connected
    check AccessToken notin outcome.seen

removeDir(dir)
quit(if programResult == 0: 0 else: 1)
