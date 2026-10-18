import std/[os, strutils, unittest]

import ./helpers/http_harness
import ../hotspot_listener
import ../../types
import ../../utils/url

var server = startRouterServer(19338)

proc exposeOnlyConfig(): FrameConfig =
  result = defaultFrameConfig()
  result.httpsProxy = HttpsProxyConfig(enable: true, port: 8443, exposeOnlyPort: true)

suite "hotspot listener":
  setup:
    drainEventChannel()
    stopHotspotListener(server.server)

  teardown:
    stopHotspotListener(server.server)

  test "no portal listener when plain HTTP already reaches every interface":
    let (port, address, _) = startHotspotListener(server.server, defaultFrameConfig())
    check port == 0
    check address == ""
    check hotspotListenerPort() == 0
    check hotspotSetupPort(defaultFrameConfig()) == 8787

  test "the captive listener on port 80 redirects to the setup URL, when port 80 can be bound":
    let config = defaultFrameConfig()
    configureServerState(config, hotspotActive = true)
    let started = startHotspotListener(server.server, config)
    # Port 80 needs CAP_NET_BIND_SERVICE (the unit has it) or a permissive
    # OS; a dev machine may refuse or already have something there. Either
    # way the answer is consistent, and the portal URL does not depend on it.
    check started.captivePort in [0, hotspotCaptivePort]
    check hotspotCaptiveListenerPort() == started.captivePort
    check hotspotSetupPort(config) == 8787
    if started.captivePort > 0:
      var response: TestResponse
      for attempt in 0 ..< 50:
        try:
          response = httpRequest(started.captivePort, "GET", "/", headers = [("Host", "10.42.0.1")])
          break
        except OSError:
          sleep(20)
      check response.status == 302
      check response.header("location") == "http://10.42.0.1:8787/"
      let probe = httpRequest(started.captivePort, "GET", "/generate_204",
        headers = [("Host", "connectivitycheck.gstatic.com")])
      check probe.status == 302
    stopHotspotListener(server.server)
    check hotspotCaptiveListenerPort() == 0
    if started.captivePort > 0:
      check waitForPortRefused(started.captivePort)

  test "expose-only HTTPS gets a listener the portal can reach":
    let config = exposeOnlyConfig()
    configureServerState(config, hotspotActive = true)
    let (port, address, _) = startHotspotListener(server.server, config)
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
    let (first, _, _) = startHotspotListener(server.server, config)
    check first > 0
    let (second, _, _) = startHotspotListener(server.server, config)
    check second > 0
    check hotspotListenerPort() == second

    stopHotspotListener(server.server)
    check hotspotListenerPort() == 0
    check hotspotSetupPort(config) == 8787
    check waitForPortRefused(second)

  test "a nil server is tolerated":
    let (port, _, captive) = startHotspotListener(nil, exposeOnlyConfig())
    check port == 0
    check captive == 0
    stopHotspotListener(nil)
    check hotspotListenerPort() == 0

stopServer(server)
