import std/[net, os, unittest]

import ./helpers/http_harness
import ../hotspot_listener
import ../../types
import ../../utils/url

var server = startRouterServer(19338)

proc exposeOnlyConfig(): FrameConfig =
  result = defaultFrameConfig()
  result.httpsProxy = HttpsProxyConfig(enable: true, port: 8443, exposeOnlyPort: true)

proc connectionRefused(port: int): bool =
  let probe = newSocket()
  try:
    probe.connect("127.0.0.1", Port(port), timeout = 1000)
    probe.close()
    false
  except OSError:
    true

suite "hotspot listener":
  setup:
    drainEventChannel()
    stopHotspotListener(server.server)

  teardown:
    stopHotspotListener(server.server)

  test "no listener when plain HTTP already reaches every interface":
    let (port, address) = startHotspotListener(server.server, defaultFrameConfig())
    check port == 0
    check address == ""
    check hotspotListenerPort() == 0
    check hotspotSetupPort(defaultFrameConfig()) == 8787

  test "expose-only HTTPS gets a listener the portal can reach":
    let config = exposeOnlyConfig()
    configureServerState(config, hotspotActive = true)
    let (port, address) = startHotspotListener(server.server, config)
    check port >= 8000 and port <= 8099
    # 10.42.0.1 is not on this machine, so the listener fell back to every
    # interface, as the Caddy setup proxy always bound.
    check address in ["10.42.0.1", "0.0.0.0"]
    check hotspotListenerPort() == port
    check hotspotSetupPort(config) == port

    # The removal is applied by the serving thread; give it a moment.
    var response: TestResponse
    for attempt in 0 ..< 50:
      try:
        response = httpRequest(port, "GET", "/setup/status")
        break
      except OSError:
        sleep(20)
    check response.status == 200

  test "starting again replaces the listener, stopping frees the port":
    let config = exposeOnlyConfig()
    configureServerState(config, hotspotActive = true)
    let (first, _) = startHotspotListener(server.server, config)
    check first > 0
    let (second, _) = startHotspotListener(server.server, config)
    check second > 0
    check hotspotListenerPort() == second

    stopHotspotListener(server.server)
    check hotspotListenerPort() == 0
    check hotspotSetupPort(config) == 8787
    var refused = false
    for attempt in 0 ..< 100:
      if connectionRefused(second):
        refused = true
        break
      sleep(20)
    check refused

  test "a nil server is tolerated":
    let (port, _) = startHotspotListener(nil, exposeOnlyConfig())
    check port == 0
    stopHotspotListener(nil)
    check hotspotListenerPort() == 0

stopServer(server)
