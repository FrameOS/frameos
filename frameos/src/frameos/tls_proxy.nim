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
  let caddyfilePath = getTempDir() / "frameos-caddyfile"
  let caddyfileContents = fmt"""https://:{tlsPort} {{
  reverse_proxy 127.0.0.1:{upstreamPort}
  tls internal
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
