import net
import os
import osproc
import strformat
import locks
import frameos/types
import frameos/utils/process

var setupProxyLock: Lock
initLock(setupProxyLock)
var setupProxyProcess: Process = nil
var setupProxyActivePort: int = 0

proc setupProxyPort*(): int {.gcsafe.} =
  withLock setupProxyLock:
    result = setupProxyActivePort

proc stopSetupProxyLocked() =
  ## Stops caddy via the Process handle: signalling a stored PID could hit an
  ## unrelated process after PID reuse, and never reaping the child left a
  ## zombie behind every hotspot start/stop cycle.
  if setupProxyProcess == nil:
    setupProxyActivePort = 0
    return

  setupProxyProcess.stopProcess()
  try:
    close(setupProxyProcess)
  except CatchableError:
    discard
  setupProxyProcess = nil
  setupProxyActivePort = 0

proc stopSetupProxy*() {.gcsafe.} =
  withLock setupProxyLock:
    {.cast(gcsafe).}:
      stopSetupProxyLocked()

proc findFreePort(startPort: int): int =
  for port in startPort..65535:
    var socket: Socket = nil
    try:
      socket = newSocket()
      socket.bindAddr(Port(port))
      close(socket)
      return port
    except CatchableError:
      if socket != nil:
        try:
          close(socket)
        except CatchableError:
          discard
  return 0

proc startSetupProxy*(frameConfig: FrameConfig) {.gcsafe.} =
  withLock setupProxyLock:
    {.cast(gcsafe).}:
      stopSetupProxyLocked()

      if not frameConfig.httpsProxy.enable or not frameConfig.httpsProxy.exposeOnlyPort:
        return

      let proxyPort = findFreePort(8000)
      if proxyPort == 0:
        return

      let upstreamPort = if frameConfig.framePort > 0: frameConfig.framePort else: 8787
      let caddyVendorPath = getEnv("FRAMEOS_TLS_PROXY_VENDOR_PATH", "/srv/frameos/vendor/caddy")
      let caddyfilePath = caddyVendorPath / "frameos-setup-proxy-caddyfile"

      try:
        if not dirExists(caddyVendorPath):
          createDir(caddyVendorPath)
      except CatchableError:
        return

      let caddyfileContents = fmt"""{{
  admin off
  auto_https off
}}
:{proxyPort} {{
  reverse_proxy 127.0.0.1:{upstreamPort}
}}
"""

      try:
        writeFile(caddyfilePath, caddyfileContents)
      except CatchableError:
        return

      try:
        setupProxyProcess = startProcessSerialized(
          "caddy",
          args = @[
            "run",
            "--config",
            caddyfilePath,
            "--adapter",
            "caddyfile",
          ],
          options = {poUsePath, poParentStreams}
        )
        setupProxyActivePort = proxyPort
      except CatchableError:
        setupProxyProcess = nil
        setupProxyActivePort = 0
