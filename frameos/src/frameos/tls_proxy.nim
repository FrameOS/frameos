import json
import locks
import os
import osproc
import strformat
import frameos/types
import frameos/utils/process

# Guards the process handle and desired-state flags: the monitor thread,
# the main thread (start/stop on boot/shutdown) and the runner ("reload")
# all touch them.
var tlsProxyLock: Lock
initLock(tlsProxyLock)

var tlsProxyProcess: Process
var tlsProxyDesired = false
var monitorThread: Thread[void]
var monitorStarted = false
var monitorConfig: FrameConfig
var monitorLogger: Logger

const
  TlsProxyMonitorIntervalMs = 10_000
  TlsProxyRestartMinIntervalMs = 30_000

proc stopTlsProxyLocked(logger: Logger) =
  if tlsProxyProcess == nil:
    return

  tlsProxyProcess.stopProcess()

  try:
    close(tlsProxyProcess)
  except CatchableError:
    discard

  tlsProxyProcess = nil

  if logger != nil:
    logger.log(%*{
      "event": "tls:stop",
      "message": "Stopped Caddy TLS proxy",
    })

proc startTlsProxyLocked(frameConfig: FrameConfig, logger: Logger) =
  stopTlsProxyLocked(logger)

  if not frameConfig.httpsProxy.enable:
    return
  let hasCustomCert = frameConfig.httpsProxy.serverCert.len > 0 and frameConfig.httpsProxy.serverKey.len > 0
  if not hasCustomCert:
    logger.log(%*{
      "event": "tls:default_cert",
      "message": "No custom TLS certificate provided, can't enable Caddy TLS proxy",
    })
    return

  let tlsPort = if frameConfig.httpsProxy.port > 0: frameConfig.httpsProxy.port else: 8443
  let upstreamPort = if frameConfig.framePort > 0: frameConfig.framePort else: 8787
  let caddyVendorPath = getEnv("FRAMEOS_TLS_PROXY_VENDOR_PATH", "/srv/frameos/vendor/caddy")
  let certPath = caddyVendorPath / "frameos-tls-cert.pem"
  let keyPath = caddyVendorPath / "frameos-tls-key.pem"
  let caddyfilePath = caddyVendorPath / "frameos-caddyfile"
  let readmePath = caddyVendorPath / "README"

  try:
    if not dirExists(caddyVendorPath):
      createDir(caddyVendorPath)
      writeFile(readmePath, "This directory is manged by FrameOS on start if the TLS config changes. Do not modify any files here yourself. ")
  except CatchableError as error:
    logger.log(%*{
      "event": "tls:vendor_dir_error",
      "message": "Failed to create Caddy vendor directory",
      "error": error.msg,
      "path": caddyVendorPath,
    })
    return

  try:
    writeFile(certPath, frameConfig.httpsProxy.serverCert)
    writeFile(keyPath, frameConfig.httpsProxy.serverKey)
  except CatchableError as error:
    logger.log(%*{
      "event": "tls:cert_write_error",
      "message": "Failed to write custom TLS certificate files",
      "error": error.msg,
    })
    return

  let caddyfileContents = fmt"""{{
  admin off
  auto_https off
}}
:{tlsPort} {{
  reverse_proxy 127.0.0.1:{upstreamPort}
  tls {certPath} {keyPath}
}}
"""

  try:
    writeFile(caddyfilePath, caddyfileContents)
  except CatchableError as error:
    logger.log(%*{
      "event": "tls:caddyfile_error",
      "message": "Failed to write Caddyfile",
      "error": error.msg,
      "path": caddyfilePath,
    })
    return

  logger.log(%*{
    "event": "tls:start",
    "message": "Starting Caddy TLS proxy",
    "port": tlsPort,
    "customCert": hasCustomCert,
  })

  try:
    tlsProxyProcess = startProcessSerialized(
      "caddy",
      args = @["run", "--config", caddyfilePath, "--adapter", "caddyfile"],
      options = {poUsePath, poParentStreams}
    )
  except CatchableError as error:
    logger.log(%*{
      "event": "tls:start_error",
      "message": "Failed to start Caddy TLS proxy",
      "error": error.msg,
    })

proc monitorLoop() {.thread.} =
  ## If caddy dies on its own, HTTPS access used to stay dead until the next
  ## full service restart. Reap the corpse and restart it, at most once per
  ## TlsProxyRestartMinIntervalMs.
  while true:
    sleep(TlsProxyMonitorIntervalMs)
    {.gcsafe.}:
      withLock tlsProxyLock:
        if not tlsProxyDesired or tlsProxyProcess == nil:
          continue
        var alive = true
        try:
          alive = tlsProxyProcess.running()
        except CatchableError:
          alive = false
        if alive:
          continue
        if monitorLogger != nil:
          monitorLogger.log(%*{
            "event": "tls:crashed",
            "message": "Caddy TLS proxy exited unexpectedly, restarting",
          })
        try:
          close(tlsProxyProcess)
        except CatchableError:
          discard
        tlsProxyProcess = nil
        startTlsProxyLocked(monitorConfig, monitorLogger)
      sleep(TlsProxyRestartMinIntervalMs - TlsProxyMonitorIntervalMs)

proc stopTlsProxy*(logger: Logger = nil) =
  withLock tlsProxyLock:
    tlsProxyDesired = false
    stopTlsProxyLocked(logger)

proc startTlsProxy*(frameConfig: FrameConfig, logger: Logger) =
  withLock tlsProxyLock:
    monitorConfig = frameConfig
    monitorLogger = logger
    tlsProxyDesired = frameConfig.httpsProxy.enable
    startTlsProxyLocked(frameConfig, logger)
    if tlsProxyDesired and not monitorStarted:
      monitorStarted = true
      createThread(monitorThread, monitorLoop)
