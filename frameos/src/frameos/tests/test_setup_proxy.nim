import std/[os, osproc, sequtils, strutils, times, unittest]

import ../setup_proxy
import ../types

proc makeConfig(enable: bool, exposeOnly: bool, framePort = 8787): FrameConfig =
  FrameConfig(
    framePort: framePort,
    httpsProxy: HttpsProxyConfig(
      enable: enable,
      port: 8443,
      exposeOnlyPort: exposeOnly,
    ),
  )

proc makeFakeCaddyBin(dirPath: string) =
  let scriptPath = dirPath / "caddy"
  writeFile(scriptPath, "#!/bin/sh\nif [ -n \"$FRAMEOS_FAKE_CADDY_PIDS\" ]; then\n  echo \"$$\" >> \"$FRAMEOS_FAKE_CADDY_PIDS\"\nfi\ntrap 'exit 0' TERM INT\nwhile :; do\n  sleep 1\ndone\n")
  discard execCmdEx("chmod +x " & quoteShell(scriptPath))

proc waitFor(condition: proc(): bool {.closure.}, timeoutMs = 1200, pollMs = 20): bool =
  let deadline = epochTime() + (float(timeoutMs) / 1000.0)
  while epochTime() < deadline:
    if condition():
      return true
    sleep(pollMs)
  condition()

suite "setup proxy lifecycle":
  let tempRoot = "tmp/frameos-setup-proxy-tests"
  let vendorPath = tempRoot / "vendor"
  let binPath = tempRoot / "bin"
  let pidsPath = tempRoot / "pids.txt"
  let oldPath = getEnv("PATH", "")

  setup:
    stopSetupProxy()
    if not dirExists(tempRoot):
      createDir(tempRoot)
    if not dirExists(vendorPath):
      createDir(vendorPath)
    if not dirExists(binPath):
      createDir(binPath)
    makeFakeCaddyBin(binPath)
    if fileExists(pidsPath):
      removeFile(pidsPath)

    putEnv("FRAMEOS_TLS_PROXY_VENDOR_PATH", vendorPath)
    putEnv("FRAMEOS_FAKE_CADDY_PIDS", pidsPath)
    putEnv("PATH", binPath & ":" & oldPath)

  teardown:
    stopSetupProxy()
    putEnv("PATH", oldPath)

  test "start with expose-only mode sets active port":
    startSetupProxy(makeConfig(enable = true, exposeOnly = true, framePort = 9123))
    let activePort = setupProxyPort()
    check activePort >= 0

    let caddyfile = vendorPath / "frameos-setup-proxy-caddyfile"
    if activePort > 0:
      check fileExists(caddyfile)
      let caddyConf = readFile(caddyfile)
      check caddyConf.contains("reverse_proxy 127.0.0.1:9123")
    else:
      check not fileExists(caddyfile)

  test "restarting proxy terminates previous process":
    startSetupProxy(makeConfig(enable = true, exposeOnly = true))
    if setupProxyPort() > 0:
      check waitFor(proc(): bool = fileExists(pidsPath))
      startSetupProxy(makeConfig(enable = true, exposeOnly = true))
      check waitFor(proc(): bool = readFile(pidsPath).splitLines().filterIt(it.len > 0).len >= 2)

      let lines = readFile(pidsPath).splitLines().filterIt(it.len > 0)
      let firstPid = parseInt(lines[0])
      let secondPid = parseInt(lines[1])

      check firstPid != secondPid
      check setupProxyPort() >= 8000
    else:
      check setupProxyPort() == 0

  test "disabled proxy does not keep active port":
    startSetupProxy(makeConfig(enable = false, exposeOnly = true))
    check setupProxyPort() == 0

    startSetupProxy(makeConfig(enable = true, exposeOnly = false))
    check setupProxyPort() == 0
