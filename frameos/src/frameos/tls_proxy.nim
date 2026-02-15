import json
import os
import osproc
import strformat
import frameos/types

var tlsProxyProcess: Process

proc stopTlsProxy*(logger: Logger = nil) =
  if tlsProxyProcess == nil:
    return

  try:
    if running(tlsProxyProcess):
      terminate(tlsProxyProcess)
      discard waitForExit(tlsProxyProcess, 1500)
      if running(tlsProxyProcess):
        kill(tlsProxyProcess)
        discard waitForExit(tlsProxyProcess, 500)
  except CatchableError:
    discard

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

proc startTlsProxy*(frameConfig: FrameConfig, logger: Logger) =
  stopTlsProxy(logger)

  if not frameConfig.enableTls:
    return
  let hasCustomCert = frameConfig.tlsServerCert.len > 0 and frameConfig.tlsServerKey.len > 0
  if not hasCustomCert:
    logger.log(%*{
      "event": "tls:default_cert",
      "message": "No custom TLS certificate provided, can't enable Caddy TLS proxy",
    })
    return

  let tlsPort = if frameConfig.tlsPort > 0: frameConfig.tlsPort else: 8443
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
    writeFile(certPath, frameConfig.tlsServerCert)
    writeFile(keyPath, frameConfig.tlsServerKey)
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
    tlsProxyProcess = startProcess(
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
