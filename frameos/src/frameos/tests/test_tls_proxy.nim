import json
import os
import strutils
import sequtils
import times
import unittest

import ../tls_proxy
import ../types

var loggedEvents: seq[string] = @[]

proc testLogger(): Logger =
  Logger(
    log: proc(payload: JsonNode) =
    loggedEvents.add(payload{"event"}.getStr(""))
  )

proc tlsConfig(port: int): FrameConfig =
  FrameConfig(
    httpsProxy: HttpsProxyConfig(
      enable: true,
      port: port,
      exposeOnlyPort: true,
      serverCert: "test-cert",
      serverKey: "test-key",
    ),
    framePort: 8787,
  )

proc waitUntil(predicate: proc(): bool {.closure.}, timeoutMs = 2000, stepMs = 50): bool =
  let startedAt = epochTime()
  while (epochTime() - startedAt) * 1000 < timeoutMs.float:
    if predicate():
      return true
    sleep(stepMs)
  predicate()

proc writeFakeCaddy(tempDir, pidFile, stoppedFile, vendorDir: string) =
  let fakeCaddyPath = tempDir / "caddy"
  writeFile(fakeCaddyPath, """#!/bin/sh
set -eu
printf '%s\n' "$$" >> "$TLS_PROXY_TEST_PID_FILE"
trap 'printf "%s\n" "$$" >> "$TLS_PROXY_TEST_STOPPED_FILE"; exit 0' TERM INT
while true; do sleep 1; done
""")
  setFilePermissions(fakeCaddyPath, {fpUserRead, fpUserWrite, fpUserExec})
  putEnv("TLS_PROXY_TEST_PID_FILE", pidFile)
  putEnv("TLS_PROXY_TEST_STOPPED_FILE", stoppedFile)
  putEnv("FRAMEOS_TLS_PROXY_VENDOR_PATH", vendorDir)

suite "TLS proxy lifecycle":
  test "starting when one is already running stops previous process":
    loggedEvents = @[]
    let logger = testLogger()
    let oldPath = getEnv("PATH")
    let tempDir = getTempDir() / "frameos-test-tls-proxy-restart"
    createDir(tempDir)
    let pidFile = tempDir / "pids.txt"
    let stoppedFile = tempDir / "stopped.txt"
    if fileExists(pidFile):
      removeFile(pidFile)
    if fileExists(stoppedFile):
      removeFile(stoppedFile)
    let vendorDir = tempDir / "vendor"
    writeFakeCaddy(tempDir, pidFile, stoppedFile, vendorDir)
    putEnv("PATH", tempDir & ":" & oldPath)

    startTlsProxy(tlsConfig(18443), logger)
    check waitUntil(proc(): bool = fileExists(pidFile))
    let firstPid = readFile(pidFile).splitLines().filterIt(it.len > 0)[0]

    startTlsProxy(tlsConfig(18443), logger)

    check waitUntil(proc(): bool = fileExists(stoppedFile))
    let stoppedPids = readFile(stoppedFile).splitLines().filterIt(it.len > 0)
    check firstPid in stoppedPids

    check waitUntil(proc(): bool =
      fileExists(pidFile) and readFile(pidFile).splitLines().filterIt(it.len > 0).len >= 2
    )
    let startedPids = readFile(pidFile).splitLines().filterIt(it.len > 0)
    check startedPids.len >= 2

    stopTlsProxy(logger)
    putEnv("PATH", oldPath)
    delEnv("FRAMEOS_TLS_PROXY_VENDOR_PATH")

  test "starting with TLS disabled stops existing proxy":
    loggedEvents = @[]
    let logger = testLogger()
    let oldPath = getEnv("PATH")
    let tempDir = getTempDir() / "frameos-test-tls-proxy-disable"
    createDir(tempDir)
    let pidFile = tempDir / "pids.txt"
    let stoppedFile = tempDir / "stopped.txt"
    if fileExists(pidFile):
      removeFile(pidFile)
    if fileExists(stoppedFile):
      removeFile(stoppedFile)
    let vendorDir = tempDir / "vendor"
    writeFakeCaddy(tempDir, pidFile, stoppedFile, vendorDir)
    putEnv("PATH", tempDir & ":" & oldPath)

    startTlsProxy(tlsConfig(19443), logger)
    check waitUntil(proc(): bool = fileExists(pidFile))
    let firstPid = readFile(pidFile).splitLines().filterIt(it.len > 0)[0]

    startTlsProxy(FrameConfig(httpsProxy: HttpsProxyConfig(enable: false)), logger)

    check waitUntil(proc(): bool = fileExists(stoppedFile))
    let stoppedPids = readFile(stoppedFile).splitLines().filterIt(it.len > 0)
    check firstPid in stoppedPids

    stopTlsProxy(logger)
    putEnv("PATH", oldPath)
    delEnv("FRAMEOS_TLS_PROXY_VENDOR_PATH")
