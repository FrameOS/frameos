## Provenance-keyed refusal of the process-spawning apps (spawn_guard.nim).

import std/[json, options, os, strutils, times, unittest]

import frameos/local_access
import frameos/spawn_guard
import frameos/types
import frameos/utils/http_client

proc storeScene(): FrameScene =
  InterpretedFrameScene(id: "store".SceneId, storeOrigin: true)

proc ownScene(): FrameScene =
  InterpretedFrameScene(id: "own".SceneId, storeOrigin: false)

suite "spawning apps and store-origin scenes":
  var previousDir = ""
  var sandbox = ""

  setup:
    previousDir = getCurrentDir()
    sandbox = getTempDir() / "frameos-spawn-guard-" & $epochTime()
    createDir(sandbox)
    setCurrentDir(sandbox)
    forgetStoredLocalNetworkAccess()
    setLocalNetworkPolicy(false)

  teardown:
    setLocalNetworkPolicy(false)
    setCurrentDir(previousDir)
    removeDir(sandbox)
    forgetStoredLocalNetworkAccess()

  test "a scene the owner wrote may run them":
    check spawningAppRefusal(ownScene(), "chromiumScreenshot") == ""
    # Compiled/legacy scenes are not InterpretedFrameScene at all: also allowed.
    check spawningAppRefusal(FrameScene(id: "legacy".SceneId), "rstpSnapshot") == ""
    check spawningAppRefusal(nil, "rstpSnapshot") == ""

  test "a store scene is refused until the local admin allows it at the panel":
    let refusal = spawningAppRefusal(storeScene(), "chromiumScreenshot")
    check refusal.len > 0
    check refusal.contains("scene store")
    check refusal.contains("chromiumScreenshot")
    persistAllowShellApps(true)
    check spawningAppRefusal(storeScene(), "chromiumScreenshot") == ""
    persistAllowShellApps(false)
    check spawningAppRefusal(storeScene(), "rstpSnapshot").len > 0

  test "the shell-apps fact lives beside the LAN elevation without clobbering it":
    persistLocalNetworkAccess(true)
    persistAllowShellApps(true)
    check storedLocalNetworkAccess().get()
    check storedAllowShellApps()
    persistLocalNetworkAccess(false)
    check storedAllowShellApps()
    let data = parseJson(readFile(LocalAccessStatePath))
    check data["allowLocalNetworkAccess"].getBool() == false
    check data["allowShellApps"].getBool() == true
    # The cache survives a re-read of the same file.
    forgetStoredLocalNetworkAccess()
    check storedAllowShellApps()
    check not storedLocalNetworkAccess().get()

suite "spawn targets":
  setup:
    setLocalNetworkPolicy(false)
  teardown:
    setLocalNetworkPolicy(false)

  test "only the schemes the app can use, and only with a host":
    check spawnTargetRefusal("https://example.com/page", ["http", "https"]) == ""
    check spawnTargetRefusal("http://example.com:8080/x", ["http", "https"]) == ""
    check spawnTargetRefusal("rtsp://cam.example/live", ["rtsp", "rtsps", "http", "https"]) == ""
    check spawnTargetRefusal("file:///etc/shadow", ["http", "https"]).contains("scheme")
    check spawnTargetRefusal("javascript:alert(1)", ["http", "https"]).contains("scheme")
    check spawnTargetRefusal("chrome://settings", ["http", "https"]).contains("scheme")
    check spawnTargetRefusal("rtsp://cam/live", ["http", "https"]).contains("scheme")
    check spawnTargetRefusal("https:///nohost", ["http", "https"]).contains("no host")
    check spawnTargetRefusal("   ", ["http", "https"]).contains("no URL")

  test "the parsed target carries scheme, host and the scheme's default port":
    let plain = spawnTarget("  https://example.com/page ", ["http", "https"])
    check plain.refusal == ""
    check plain.url == "https://example.com/page"
    check plain.scheme == "https"
    check plain.hostname == "example.com"
    check plain.port == 443
    check spawnTarget("rtsp://cam.example/live", ["rtsp"]).port == 554
    check spawnTarget("http://cam.example:8080/x", ["http"]).port == 8080
    # With the deny off nothing is pinned: the child resolves for itself.
    check plain.address == ""
    check plain.pinnedUrl == plain.url

  test "with the deny on, the target is pinned to the address that was checked":
    # A literal address needs no lookup, so the pin is the literal itself
    # and the URL is left alone; a private literal is refused outright.
    setLocalNetworkPolicy(true)
    let literal = spawnTarget("http://93.184.216.34/x", ["http"])
    check literal.refusal == ""
    check literal.address == ""
    check literal.pinnedUrl == "http://93.184.216.34/x"
    check spawnTarget("rtsp://192.168.1.20/live", ["rtsp"]).refusal.contains("blocked")
    check spawnTarget("http://127.0.0.1:8787/", ["http"]).refusal.contains("blocked")
    # A name resolves once; the child then gets that answer, never a second
    # lookup of the name (the rebinding hole). localhost is the one name a
    # test can resolve without the network, and it classifies as private.
    check spawnTarget("http://localhost/", ["http"]).refusal.contains("blocked")
    check spawnTargetRefusal("http://example.com:notaport/", ["http", "https"]).contains("port")

  test "the private-network policy applies to the child's target too":
    # Off: a LAN address is the owner's business.
    check spawnTargetRefusal("http://127.0.0.1/admin", ["http", "https"]) == ""
    check spawnTargetRefusal("http://192.168.1.1/", ["http", "https"]) == ""
    # On (cloud-managed, or a store scene resident): the same classifier the
    # HTTP client uses says no before anything is spawned.
    setLocalNetworkPolicy(true)
    check spawnTargetRefusal("http://127.0.0.1/admin", ["http", "https"]).contains("blocked")
    check spawnTargetRefusal("rtsp://192.168.1.20:554/live", ["rtsp", "http"]).contains("blocked")
    # An exempt endpoint stays reachable, as for the HTTP client.
    setLocalNetworkPolicy(true, @["192.168.1.20:554"])
    check spawnTargetRefusal("rtsp://192.168.1.20:554/live", ["rtsp", "http"]) == ""
