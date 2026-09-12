## An on-device settings save APPLIES: the sockets are rebound before the
## config is written (a port the frame cannot bind refuses the save), a
## driver-init key restarts the runtime instead of reloading it, and the
## system steps `frameos setup` would run are queued for the worker. The
## response's `apply` block reports all of it, which is what the admin page
## follows to a new port or scheme.
import std/[json, locks, net, os, strutils, tables, unittest]
import mummy

import ./helpers/http_harness
import ../listener_control
import ../listeners
import ../rate_limit
import ../settings_apply
import ../../channels
import ../../types
import ../api

const
  plainPort = 19351
  movedPort = 19352
  tlsPort = 19453
  # Self-signed P-256 for localhost/127.0.0.1, valid until 2126 (same
  # material as test_tls_listener.nim).
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

  # A second self-signed P-256 pair for localhost/127.0.0.1 (100 years):
  # replacing the certificate rebinds the SAME port, the case where the
  # old socket is still closing when the new one is bound.
  replacementCert = """-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUBIjAs0kyM3Gt6QoDaS7R71oMtKcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkxMjE2MDUxMFoYDzIxMjYwODE5
MTYwNTEwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAReolNQ2tR9aEBUGTXFu8Anq3m2qE9AGwcJplYAkPL0mPbPszuTtfll
stjCaYdoumDTJY6gSHuLYNRo9ItY9n3Zo28wbTAdBgNVHQ4EFgQULstp9ZXPF6vw
tPJ1ieZOxezNED0wHwYDVR0jBBgwFoAULstp9ZXPF6vwtPJ1ieZOxezNED0wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIhAME0YNvPYDIPbGeF0r+LZqWyxS0rSenJQSwwAF7HXyTyAiA7
GyJuJEaquE7LUK7Wxcop0f62B4+Z2zgxxw+YwJNGCg==
-----END CERTIFICATE-----
"""
  replacementKey = """-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIBEFyyqFhWz1+08tcxhNC+eBzvYQ8QETMUVbPLodWkAwoAoGCCqGSM49
AwEHoUQDQgAEXqJTUNrUfWhAVBk1xbvAJ6t5tqhPQBsHCaZWAJDy9Jj2z7M7k7X5
ZbLYwmmHaLpg0yWOoEh7i2DUaPSLWPZ92Q==
-----END EC PRIVATE KEY-----
"""

var server = startRouterServer(plainPort)

# The worker runs real setup steps (sudo, fstab) — capture the jobs instead.
var capturedLock: Lock
initLock(capturedLock)
var capturedJobs: seq[SettingsJob] = @[]
setSettingsJobRunnerForTest(proc(job: SettingsJob) {.gcsafe.} =
  withLock capturedLock:
    {.cast(gcsafe).}:
      capturedJobs.add(job)
)

proc capturedKinds(expected: int): seq[string] =
  for attempt in 0 ..< 200:
    withLock capturedLock:
      {.cast(gcsafe).}:
        if capturedJobs.len >= expected:
          for job in capturedJobs:
            result.add($job.kind)
          return
    sleep(10)
  withLock capturedLock:
    {.cast(gcsafe).}:
      for job in capturedJobs:
        result.add($job.kind)

proc clearCaptured() =
  withLock capturedLock:
    {.cast(gcsafe).}:
      capturedJobs = @[]

proc waitForPort(port: int): bool =
  for attempt in 0 ..< 100:
    let probe = newSocket()
    try:
      probe.connect("127.0.0.1", Port(port), timeout = 500)
      probe.close()
      return true
    except OSError:
      probe.close()
      sleep(20)
  false

proc portRefused(port: int): bool =
  for attempt in 0 ..< 100:
    let probe = newSocket()
    try:
      probe.connect("127.0.0.1", Port(port), timeout = 500)
      probe.close()
      sleep(20)
    except OSError:
      probe.close()
      return true
  false

proc httpsRequest(port: int, path: string, headers: openArray[(string, string)] = []): TestResponse =
  var socket = newSocket()
  let ctx = newContext(verifyMode = CVerifyNone)
  ctx.wrapSocket(socket)
  var connected = false
  for attempt in 0 ..< 50:
    try:
      socket.connect("127.0.0.1", Port(port))
      connected = true
      break
    except OSError:
      sleep(20)
  doAssert connected, "TLS listener never came up"
  var requestLines = @["GET " & path & " HTTP/1.1", "Host: 127.0.0.1:" & $port, "Connection: close"]
  for (name, value) in headers:
    requestLines.add(name & ": " & value)
  requestLines.add("")
  requestLines.add("")
  socket.send(requestLines.join("\c\L"))
  var raw = ""
  while true:
    let chunk = socket.recv(4096, timeout = 5000)
    if chunk.len == 0:
      break
    raw.add(chunk)
  socket.close()
  let split = raw.find("\c\L\c\L")
  let head = if split >= 0: raw[0 ..< split] else: raw
  result.body = if split >= 0: raw[split + 4 .. ^1] else: ""
  let lines = head.split("\c\L")
  result.status = parseInt(lines[0].split(" ")[1])
  result.headers = initTable[string, string]()
  for line in lines[1 .. ^1]:
    let colon = line.find(":")
    if colon > 0:
      result.headers[line[0 ..< colon].strip().toLowerAscii()] = line[colon + 1 .. ^1].strip()

proc adminCookieFrom(response: TestResponse): string =
  let cookie = response.header("set-cookie")
  if cookie.len == 0:
    return ""
  cookie.split(";", 1)[0]

proc eventNames(): seq[string] =
  while true:
    let (ok, payload) = eventChannel.tryRecv()
    if not ok:
      break
    result.add(payload[1])

let tempRoot = getTempDir() / "frameos-settings-apply-routes"
createDir(tempRoot)
let configPath = tempRoot / "frame.json"
let scenesPath = tempRoot / "scenes.json.gz"
putEnv("FRAMEOS_CONFIG", configPath)
putEnv("FRAMEOS_SCENES_JSON", scenesPath)

proc storedConfig(): JsonNode =
  parseJson(readFile(configPath))

proc resetFrame(): string =
  ## A frame served on 127.0.0.1:<plainPort> (bindHost keeps the plan honest
  ## about where the harness listener really is), admin login enabled.
  ## Returns the admin cookie.
  drainEventChannel()
  clearCaptured()
  # Every test logs in afresh (configureServerState clears the sessions);
  # the device allows 10 logins per 5 minutes per address.
  resetRateLimits()
  writeFile(configPath, $(%*{
    "name": "Apply frame",
    "mode": "rpios",
    "frameHost": "localhost",
    "framePort": plainPort,
    "bindHost": "127.0.0.1",
    "frameAccess": "private",
    "frameAccessKey": "test-key",
    "frameAdminAuth": {"enabled": true, "user": "admin", "pass": "secret"},
    "httpsProxy": {"enable": false, "port": tlsPort},
    "timeZone": "Europe/Brussels",
    "device": "web_only",
    "width": 800,
    "height": 480,
  }))
  var config = defaultFrameConfig()
  config.mode = "rpios"
  config.framePort = plainPort
  config.bindHost = "127.0.0.1"
  config.frameAdminAuth = %*{"enabled": true, "user": "admin", "pass": "secret"}
  config.httpsProxy = HttpsProxyConfig(enable: false, port: tlsPort)
  configureServerState(config)
  let login = httpRequest(server.port, "POST", "/api/admin/login",
    headers = [("Content-Type", "application/json")],
    body = $(%*{"username": "admin", "password": "secret"}))
  doAssert login.status == 200, "login failed: " & $login.status & " " & login.body
  adminCookieFrom(login)

proc save(port: int, cookie: string, payload: JsonNode): TestResponse =
  httpRequest(port, "POST", "/api/frames/1",
    headers = [("Cookie", cookie), ("Content-Type", "application/json")], body = $payload)

# Everything below rebinds the harness server's listeners by handle.
registerControlledServer(server.server)
registerActiveListener(ListenerSpec(address: "127.0.0.1", port: plainPort, tls: false), server.listener)

suite "settings save applies on the device":
  test "an unchanged save touches nothing":
    let cookie = resetFrame()
    let response = save(server.port, cookie, %*{"name": "Apply frame", "timezone": "Europe/Brussels"})
    check response.status == 200
    let apply = parseJson(response.body)["apply"]
    check apply["runtime"].getStr() == "none"
    check not apply["listeners_changed"].getBool()
    check apply["system"].len == 0
    check apply["listeners"].len == 1
    check apply["listeners"][0]["port"].getInt() == plainPort
    check eventNames().len == 0

  test "a plain change reloads the runtime; skip_runtime_reload only skips that":
    let cookie = resetFrame()
    var response = save(server.port, cookie, %*{"name": "Renamed"})
    check response.status == 200
    check parseJson(response.body)["apply"]["runtime"].getStr() == "reload"
    check eventNames() == @["reload"]
    response = save(server.port, cookie, %*{"name": "Renamed twice", "skip_runtime_reload": true})
    check response.status == 200
    check parseJson(response.body)["apply"]["runtime"].getStr() == "none"
    check eventNames().len == 0
    check storedConfig()["name"].getStr() == "Renamed twice"

  test "a driver-init key restarts the runtime instead of reloading it":
    let cookie = resetFrame()
    let response = save(server.port, cookie, %*{"gpio_buttons": [{"pin": 5, "label": "A"}]})
    check response.status == 200
    check parseJson(response.body)["apply"]["runtime"].getStr() == "restart"
    check eventNames() == @["restart"]

  test "time zone and mountpoints are queued for the settings worker":
    let cookie = resetFrame()
    let response = save(server.port, cookie, %*{
      "timezone": "Europe/Tallinn",
      "mountpoints": {"enabled": true, "items": [{"enabled": true, "source": "//nas/photos", "target": "/mnt/photos"}]},
    })
    check response.status == 200
    let apply = parseJson(response.body)["apply"]
    check apply["runtime"].getStr() == "reload"
    check apply["system"] == %*["timezone", "mounts"]
    check capturedKinds(2) == @["timezone", "mounts"]
    # The job carries the merged config it applies.
    withLock capturedLock:
      {.cast(gcsafe).}:
        check parseJson(capturedJobs[0].configJson)["timeZone"].getStr() == "Europe/Tallinn"

  test "a display driver change runs driver setup, which restarts on its own":
    let cookie = resetFrame()
    let response = save(server.port, cookie, %*{"device": "pimoroni.inky_impression_13"})
    check response.status == 200
    let apply = parseJson(response.body)["apply"]
    check apply["runtime"].getStr() == "restart"
    check apply["system"] == %*["driver_setup"]
    # No restart event from the route: the worker sends it after setup.
    check eventNames().len == 0
    check capturedKinds(1) == @["driver_setup"]

  test "a new port is served before the config is written, and the old one closes":
    let cookie = resetFrame()
    let response = save(server.port, cookie, %*{"frame_port": movedPort})
    check response.status == 200
    let apply = parseJson(response.body)["apply"]
    check apply["listeners_changed"].getBool()
    check apply["listeners"] == %*[{"address": "127.0.0.1", "port": movedPort, "tls": false}]
    check storedConfig()["framePort"].getInt() == movedPort
    check waitForPort(movedPort)
    # The session cookie is host-scoped: the same login works on the new port.
    let moved = httpRequest(movedPort, "GET", "/api/frames/1", headers = [("Cookie", cookie)])
    check moved.status == 200
    check portRefused(plainPort)
    # Back to where the rest of the suite expects the server.
    let back = save(movedPort, cookie, %*{"frame_port": plainPort})
    check back.status == 200
    check waitForPort(plainPort)
    check portRefused(movedPort)
    check activeListenerSpecs() == @[ListenerSpec(address: "127.0.0.1", port: plainPort, tls: false)]

  test "a port the frame cannot bind refuses the save and keeps the config":
    let cookie = resetFrame()
    let squatter = newSocket()
    squatter.setSockOpt(OptReuseAddr, true)
    squatter.bindAddr(Port(movedPort), "127.0.0.1")
    squatter.listen()
    defer: squatter.close()
    let response = save(server.port, cookie, %*{"frame_port": movedPort, "name": "Never saved"})
    check response.status == 409
    let body = parseJson(response.body)
    check body["detail"].getStr().contains("HTTP on 127.0.0.1:" & $movedPort)
    check body["apply"]["listeners"] == %*[{"address": "127.0.0.1", "port": plainPort, "tls": false}]
    check storedConfig()["framePort"].getInt() == plainPort
    check storedConfig()["name"].getStr() == "Apply frame"
    check eventNames().len == 0
    # Still served where it was.
    check httpRequest(server.port, "GET", "/api/frames/1", headers = [("Cookie", cookie)]).status == 200

  test "turning HTTPS on adds a TLS listener next to the plain one; off removes it":
    let cookie = resetFrame()
    var response = save(server.port, cookie, %*{
      "https_proxy": {"enable": true, "port": tlsPort, "certs": {"server": testCert, "server_key": testKey}},
    })
    check response.status == 200
    var apply = parseJson(response.body)["apply"]
    check apply["listeners_changed"].getBool()
    check apply["listeners"] == %*[
      {"address": "127.0.0.1", "port": plainPort, "tls": false},
      {"address": "127.0.0.1", "port": tlsPort, "tls": true},
    ]
    let secure = httpsRequest(tlsPort, "/api/frames/1", headers = [("Cookie", cookie)])
    check secure.status == 200
    check parseJson(secure.body)["frame"]["https_proxy"]["enable"].getBool()

    response = save(server.port, cookie, %*{"https_proxy": {"enable": false}})
    check response.status == 200
    apply = parseJson(response.body)["apply"]
    check apply["listeners_changed"].getBool()
    check apply["listeners"] == %*[{"address": "127.0.0.1", "port": plainPort, "tls": false}]
    check portRefused(tlsPort)

  test "replacing the certificate rebinds the same port":
    let cookie = resetFrame()
    var response = save(server.port, cookie, %*{
      "https_proxy": {"enable": true, "port": tlsPort, "certs": {"server": testCert, "server_key": testKey}},
    })
    check response.status == 200
    check httpsRequest(tlsPort, "/api/frames/1", headers = [("Cookie", cookie)]).status == 200
    # Same port, new material: the old TLS listener is on its way out when
    # the new one binds (listener_control retries until the close lands).
    response = save(server.port, cookie, %*{
      "https_proxy": {"enable": true, "port": tlsPort, "certs": {"server": replacementCert, "server_key": replacementKey}},
    })
    check response.status == 200
    let apply = parseJson(response.body)["apply"]
    check apply["listeners_changed"].getBool()
    check apply["listeners"] == %*[
      {"address": "127.0.0.1", "port": plainPort, "tls": false},
      {"address": "127.0.0.1", "port": tlsPort, "tls": true},
    ]
    check storedConfig()["httpsProxy"]["serverCert"].getStr() == replacementCert
    check httpsRequest(tlsPort, "/api/frames/1", headers = [("Cookie", cookie)]).status == 200
    # And the same material again is a no-op.
    response = save(server.port, cookie, %*{
      "https_proxy": {"enable": true, "port": tlsPort, "certs": {"server": replacementCert, "server_key": replacementKey}},
    })
    check response.status == 200
    check not parseJson(response.body)["apply"]["listeners_changed"].getBool()
    check save(server.port, cookie, %*{"https_proxy": {"enable": false}}).status == 200
    check portRefused(tlsPort)

  test "a certificate the runtime cannot load refuses the save":
    let cookie = resetFrame()
    let response = save(server.port, cookie, %*{
      "https_proxy": {"enable": true, "port": tlsPort, "certs": {"server": "not a cert", "server_key": "nor a key"}},
    })
    check response.status == 409
    check parseJson(response.body)["detail"].getStr().contains("HTTPS on 127.0.0.1:" & $tlsPort)
    check not storedConfig()["httpsProxy"]["enable"].getBool()
    check portRefused(tlsPort)

  test "HTTPS enabled without a certificate stays plain, as at start-up":
    let cookie = resetFrame()
    let response = save(server.port, cookie, %*{"https_proxy": {"enable": true, "port": tlsPort}})
    check response.status == 200
    let apply = parseJson(response.body)["apply"]
    check not apply["listeners_changed"].getBool()
    check apply["listeners"] == %*[{"address": "127.0.0.1", "port": plainPort, "tls": false}]
    check storedConfig()["httpsProxy"]["enable"].getBool()

suite "which system steps a change needs, per platform":
  test "Raspberry Pi OS applies all three":
    var change = FrameConfigChange(any: true, timezone: true, mounts: true, device: true)
    check settingsJobsFor(change, "rpios") == @[sjTimezone, sjMounts, sjDriverSetup]
  test "Buildroot has no apt and no writable fstab: mounts are never queued":
    var change = FrameConfigChange(any: true, timezone: true, mounts: true, device: true)
    check settingsJobsFor(change, "buildroot") == @[sjTimezone, sjDriverSetup]
  test "a microcontroller or a dev build gets nothing":
    var change = FrameConfigChange(any: true, timezone: true, mounts: true, device: true)
    check settingsJobsFor(change, "embedded").len == 0
    check settingsJobsFor(change, "web_only").len == 0
  test "nothing changed, nothing queued":
    check settingsJobsFor(FrameConfigChange(), "rpios").len == 0

stopServer(server)
removeDir(tempRoot)
