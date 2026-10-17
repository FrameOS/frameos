## What the process-spawning apps may hand to a child (spawn_guard.nim), and
## the local-access fact that lets Chromium run unsandboxed as root. Who may
## run the apps at all is the install's call ("runs shell commands",
## frontend/src/utils/sceneAccess.ts), not the frame's.

import std/[json, options, os, strutils, times, unittest]

import frameos/local_access
import frameos/spawn_guard
import frameos/types
import frameos/utils/http_client

suite "the shell-apps fact":
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
    check not plain.denyActive
    check plain.pinnedUrl == plain.url
    check spawnSubresourcePin("192.168.1.1", 80) == ("", "")

  test "with the deny on, the target is pinned to the address that was checked":
    # A literal address needs no lookup, so the pin is the literal itself
    # and the URL is left alone; a private literal is refused outright.
    setLocalNetworkPolicy(true)
    let literal = spawnTarget("http://93.184.216.34/x", ["http"])
    check literal.refusal == ""
    check literal.address == ""
    # ...but the child still learns the deny is on, so it holds the page
    # to the checked host set (chromiumScreenshot gates sub-resources).
    check literal.denyActive
    check literal.pinnedUrl == "http://93.184.216.34/x"
    # A sub-resource host goes through the same once-only check: a public
    # literal pins to itself, a private one is refused.
    check spawnSubresourcePin("203.0.113.7", 443) == ("", "203.0.113.7")
    check spawnSubresourcePin("10.0.0.5", 80).refusal.contains("Local network access is off for this frame")
    check spawnSubresourcePin("localhost", 8787).refusal.contains("Local network access is off for this frame")
    check spawnSubresourcePin("", 80).refusal.contains("host")
    check spawnTarget("rtsp://192.168.1.20/live", ["rtsp"]).refusal.contains("Local network access is off for this frame")
    check spawnTarget("http://127.0.0.1:8787/", ["http"]).refusal.contains("Local network access is off for this frame")
    # A name resolves once; the child then gets that answer, never a second
    # lookup of the name (the rebinding hole). localhost is the one name a
    # test can resolve without the network, and it classifies as private.
    check spawnTarget("http://localhost/", ["http"]).refusal.contains("Local network access is off for this frame")
    check spawnTargetRefusal("http://example.com:notaport/", ["http", "https"]).contains("port")

  test "the private-network policy applies to the child's target too":
    # Off: a LAN address is the owner's business.
    check spawnTargetRefusal("http://127.0.0.1/admin", ["http", "https"]) == ""
    check spawnTargetRefusal("http://192.168.1.1/", ["http", "https"]) == ""
    # On (cloud-managed, or a store scene resident): the same classifier the
    # HTTP client uses says no before anything is spawned.
    setLocalNetworkPolicy(true)
    check spawnTargetRefusal("http://127.0.0.1/admin", ["http", "https"]).contains("Local network access is off for this frame")
    check spawnTargetRefusal("rtsp://192.168.1.20:554/live", ["rtsp", "http"]).contains("Local network access is off for this frame")
    # An exempt endpoint stays reachable, as for the HTTP client.
    setLocalNetworkPolicy(true, @["192.168.1.20:554"])
    check spawnTargetRefusal("rtsp://192.168.1.20:554/live", ["rtsp", "http"]) == ""
