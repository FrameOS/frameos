import std/unittest

import ../listeners
import ../../types

proc makeConfig(
  framePort = 8787,
  bindHost = "",
  httpsEnabled = false,
  httpsPort = 8443,
  exposeOnlyPort = false,
  serverCert = "",
  serverKey = ""
): FrameConfig =
  FrameConfig(
    framePort: framePort,
    bindHost: bindHost,
    httpsProxy: HttpsProxyConfig(
      enable: httpsEnabled,
      port: httpsPort,
      exposeOnlyPort: exposeOnlyPort,
      serverCert: serverCert,
      serverKey: serverKey,
    ),
  )

suite "listener planning":
  test "plain HTTP on every interface by default":
    let specs = planListeners(makeConfig())
    check specs == @[ListenerSpec(address: "0.0.0.0", port: 8787, tls: false)]

  test "frame port zero means 8787":
    check serverPort(makeConfig(framePort = 0)) == 8787
    check planListeners(makeConfig(framePort = 0))[0].port == 8787

  test "bindHost pins the plain listener":
    let specs = planListeners(makeConfig(bindHost = "192.168.1.20", framePort = 9000))
    check specs == @[ListenerSpec(address: "192.168.1.20", port: 9000, tls: false)]

  test "HTTPS with certificate material adds a TLS listener":
    let specs = planListeners(makeConfig(httpsEnabled = true, httpsPort = 9443, serverCert = "cert", serverKey = "key"))
    check specs == @[
      ListenerSpec(address: "0.0.0.0", port: 8787, tls: false),
      ListenerSpec(address: "0.0.0.0", port: 9443, tls: true),
    ]

  test "HTTPS port zero means 8443":
    let specs = planListeners(makeConfig(httpsEnabled = true, httpsPort = 0, serverCert = "cert", serverKey = "key"))
    check specs[1].port == 8443

  test "HTTPS without certificate material stays plain only":
    # The runtime logs tls:default_cert for this case instead of serving a
    # made-up certificate.
    let config = makeConfig(httpsEnabled = true, serverCert = "cert")
    check httpsEnabled(config)
    check not hasTlsMaterial(config)
    check planListeners(config) == @[ListenerSpec(address: "0.0.0.0", port: 8787, tls: false)]

  test "HTTPS disabled ignores certificate material":
    let config = makeConfig(httpsEnabled = false, serverCert = "cert", serverKey = "key")
    check planListeners(config).len == 1

  test "exposeOnlyPort keeps plain HTTP on loopback and TLS public":
    let specs = planListeners(makeConfig(httpsEnabled = true, exposeOnlyPort = true, serverCert = "cert", serverKey = "key"))
    check specs == @[
      ListenerSpec(address: "127.0.0.1", port: 8787, tls: false),
      ListenerSpec(address: "0.0.0.0", port: 8443, tls: true),
    ]

  test "exposeOnlyPort without HTTPS does not hide the plain listener":
    let specs = planListeners(makeConfig(httpsEnabled = false, exposeOnlyPort = true))
    check specs[0].address == "0.0.0.0"

  test "bindHost applies to both listeners":
    let specs = planListeners(makeConfig(bindHost = "10.0.0.5", httpsEnabled = true, serverCert = "cert", serverKey = "key"))
    check specs[0].address == "10.0.0.5"
    check specs[1].address == "10.0.0.5"

  test "a missing httpsProxy block is plain HTTP":
    let config = FrameConfig(framePort: 8787)
    check not httpsEnabled(config)
    check not hasTlsMaterial(config)
    check planListeners(config) == @[ListenerSpec(address: "0.0.0.0", port: 8787, tls: false)]

suite "hotspot listener need":
  test "not needed when plain HTTP is on every interface":
    check not hotspotNeedsOwnListener(makeConfig())
    check not hotspotNeedsOwnListener(makeConfig(httpsEnabled = true, serverCert = "cert", serverKey = "key"))
    check not hotspotNeedsOwnListener(makeConfig(httpsEnabled = false, exposeOnlyPort = true))

  test "needed when the plain listener is on loopback or pinned":
    check hotspotNeedsOwnListener(makeConfig(httpsEnabled = true, exposeOnlyPort = true))
    check hotspotNeedsOwnListener(makeConfig(bindHost = "127.0.0.1"))
    check not hotspotNeedsOwnListener(makeConfig(bindHost = "0.0.0.0"))
