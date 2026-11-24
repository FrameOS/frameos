## A TLS client to an IP literal checks that the certificate names that
## address (utils/tls_client.nim); std/net checks names only.
import std/[net, os, unittest]
import mummy

import ../tls_client

const
  # Self-signed P-256 for localhost / 127.0.0.1, valid until 2126 (the TLS
  # listener test's own).
  ownAddressCert = """-----BEGIN CERTIFICATE-----
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
  ownAddressKey = """-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJyAmtKAVs7XPLTMJD7guygpiNJd3O9y2MtywgoTnARroAoGCCqGSM49
AwEHoUQDQgAEjCPyQJKX0GmOjA3KtvR9eySCw45lPnsAfdS70IbMXaWhOTmrM2kl
AGTSvUM8DZHQM8mNStEwE6CHOYuOpkBpuw==
-----END EC PRIVATE KEY-----
"""
  # Self-signed P-256 for example.test / 10.9.9.9, valid until 2126: trusted,
  # and for somebody else.
  otherAddressCert = """-----BEGIN CERTIFICATE-----
MIIBozCCAUqgAwIBAgIUM9+pfYW7N0AcfG+hwXDudoFKvbwwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MCAXDTI2MTEyNDE5MjA1OFoYDzIxMjYx
MDMxMTkyMDU4WjAXMRUwEwYDVQQDDAxleGFtcGxlLnRlc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATxJ3n0acxDx7+kS4ToT3s3QNA35WMWHHqOh1pIguEe5gzy
r0eXFtq+wCz0CQHIWSmtDj/krXexI9ZZ5DvGe176o3IwcDAdBgNVHQ4EFgQUXpWP
E1VfDywFq1mgfgDc2ljr3oMwHwYDVR0jBBgwFoAUXpWPE1VfDywFq1mgfgDc2ljr
3oMwHQYDVR0RBBYwFIIMZXhhbXBsZS50ZXN0hwQKCQkJMA8GA1UdEwEB/wQFMAMB
Af8wCgYIKoZIzj0EAwIDRwAwRAIgQO2QS8voyfO40jKq4uGpwnyXoupczbllobOR
ol8vkTUCIHOUx8kwQB+tQduKu5MAbEn+LdMpcM44ow6Z3ii0iJl/
-----END CERTIFICATE-----
"""
  otherAddressKey = """-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJpAiEgxpkustldVbQn9d9Ng3kEkftQyWE57tHxfStUZoAoGCCqGSM49
AwEHoUQDQgAE8Sd59GnMQ8e/pEuE6E97N0DQN+VjFhx6jodaSILhHuYM8q9Hlxba
vsAs9AkByFkprQ4/5K13sSPWWeQ7xnte+g==
-----END EC PRIVATE KEY-----
"""
  plainPort = 19451
  ownPort = 19452
  otherPort = 19453

proc handler(request: Request) {.gcsafe.} =
  request.respond(200, body = "ok")

proc serveTls(server: Server) {.thread.} =
  try:
    server.serve()
  except CatchableError:
    discard

let server = newServer(handler, workerThreads = 1)
discard server.addListener(Port(plainPort), "127.0.0.1")
discard server.addListener(Port(ownPort), "127.0.0.1", newTlsConfig(ownAddressCert, ownAddressKey))
discard server.addListener(Port(otherPort), "127.0.0.1", newTlsConfig(otherAddressCert, otherAddressKey))
var thread: Thread[Server]
createThread(thread, serveTls, server)

let caFile = getTempDir() / ("frameos-tls-client-test-" & $getCurrentProcessId() & ".pem")
writeFile(caFile, ownAddressCert & otherAddressCert)

proc handshake(port: int, checked: bool) =
  ## Both certificates are trusted (each is its own CA): only the address
  ## can tell them apart.
  let ctx = newContext(verifyMode = CVerifyPeer, caFile = caFile)
  var socket = newSocket()
  try:
    var connected = false
    for attempt in 0 ..< 50:
      try:
        socket.connect("127.0.0.1", Port(port))
        connected = true
        break
      except OSError:
        sleep(20)
    doAssert connected
    if checked: ctx.wrapTlsClient(socket, "127.0.0.1")
    else: ctx.wrapConnectedSocket(socket, handshakeAsClient, "127.0.0.1")
  finally:
    socket.close()
    ctx.destroyContext()

suite "a TLS client to an address":
  test "a certificate that names the address is the server":
    handshake(ownPort, checked = true)

  test "a trusted certificate for another address is not":
    # What std/net alone lets through: the chain is good, the name is not
    # looked at, because the host is an IP literal.
    handshake(otherPort, checked = false)
    expect SslError:
      handshake(otherPort, checked = true)

removeFile(caFile)
# Down before the process exits: a serving thread still holding its TLS
# sessions while OpenSSL cleans up at exit crashed the run on CI, after both
# tests had passed (the TLS listener test's harness closes its server too).
GC_fullCollect()
server.close()
joinThread(thread)
