import std/unittest

import ../url
import ../../types

proc makeConfig(
  frameHost = "frame.local",
  framePort = 8787,
  frameAccess = "public",
  frameAccessKey = "test-key",
  httpsEnabled = false,
  httpsPort = 8443,
  exposeOnlyPort = false
): FrameConfig =
  FrameConfig(
    frameHost: frameHost,
    framePort: framePort,
    frameAccess: frameAccess,
    frameAccessKey: frameAccessKey,
    httpsProxy: HttpsProxyConfig(
      enable: httpsEnabled,
      port: httpsPort,
      exposeOnlyPort: exposeOnlyPort,
    ),
  )

suite "URL helpers":
  test "public scheme host and port resolution":
    let config = makeConfig(frameHost = "", httpsEnabled = true, httpsPort = 9443)
    check publicScheme(config) == "https"
    check publicHost(config) == "localhost"
    check publicPort(config) == 9443
    check publicBaseUrl(config) == "https://localhost:9443"

  test "https enabled with zero proxy port falls back to frame port":
    let config = makeConfig(httpsEnabled = true, httpsPort = 0, framePort = 9000)
    check publicPort(config) == 9000

  test "hotspot setup port falls back to frame port when no setup proxy is active":
    let config = makeConfig(httpsEnabled = true, exposeOnlyPort = true, framePort = 9123)
    check hotspotSetupPort(config) == 9123

  test "authenticated URL omits key for public write access":
    let config = makeConfig(frameAccess = "public")
    check authenticatedFrameUrl(config, "/api/frame") == "http://frame.local:8787/api/frame"

  test "authenticated URL includes key for private write access":
    let config = makeConfig(frameAccess = "private", frameAccessKey = "secret")
    check authenticatedFrameUrl(config, "/api/frame") == "http://frame.local:8787/api/frame?k=secret"

  test "read-only URLs include key only for private mode":
    let publicConfig = makeConfig(frameAccess = "public")
    let privateConfig = makeConfig(frameAccess = "private", frameAccessKey = "secret")
    check authenticatedFrameUrl(publicConfig, "/api/public", requireWriteAccess = false) == "http://frame.local:8787/api/public"
    check authenticatedFrameUrl(privateConfig, "/api/public", requireWriteAccess = false) ==
      "http://frame.local:8787/api/public?k=secret"

  test "authenticated URL appends key with ampersand when query is present":
    let config = makeConfig(frameAccess = "private", frameAccessKey = "secret")
    check authenticatedFrameUrl(config, "/api/frame?x=1") == "http://frame.local:8787/api/frame?x=1&k=secret"
