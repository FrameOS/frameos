import json
import os
import osproc
import strformat
import frameos/types

proc startTlsProxy*(frameConfig: FrameConfig, logger: Logger) =
  if not frameConfig.enableTls:
    return

  let tlsPort = if frameConfig.tlsPort > 0: frameConfig.tlsPort else: 8443
  let upstreamPort = if frameConfig.framePort > 0: frameConfig.framePort else: 8787
  let certPath = getTempDir() / "frameos-tls-cert.pem"
  let keyPath = getTempDir() / "frameos-tls-key.pem"
  let caddyfilePath = getTempDir() / "frameos-caddyfile"
  let hasCustomCert = frameConfig.tlsServerCert.len > 0 and frameConfig.tlsServerKey.len > 0

  if hasCustomCert:
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

  let tlsDirective = if hasCustomCert: fmt"  tls {certPath} {keyPath}" else: "  tls internal"
  let caddyfileContents = fmt"""{{
  admin off
  auto_https disable_redirects
}}
https://*:{tlsPort} {{
  reverse_proxy 127.0.0.1:{upstreamPort}
{tlsDirective}
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
    discard startProcess(
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
