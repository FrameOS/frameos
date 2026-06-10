import net
import os
import osproc
import posix
import strformat
import times
import frameos/types
import frameos/utils/process

var setupProxyPid: int = 0
var setupProxyActivePort: int = 0

proc setupProxyPort*(): int =
  setupProxyActivePort

proc stopSetupProxy*() =
  if setupProxyPid <= 0:
    setupProxyActivePort = 0
    return

  discard posix.kill(Pid(setupProxyPid), SIGTERM)

  let waitUntil = epochTime() + 1.5
  while epochTime() < waitUntil:
    if posix.kill(Pid(setupProxyPid), 0) != 0:
      break
    sleep(100)

  discard posix.kill(Pid(setupProxyPid), SIGKILL)
  setupProxyPid = 0
  setupProxyActivePort = 0

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

proc startSetupProxy*(frameConfig: FrameConfig) =
  stopSetupProxy()

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
    let processHandle = startProcessSerialized(
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
    setupProxyPid = processHandle.processID.int
    close(processHandle)
    setupProxyActivePort = proxyPort
  except CatchableError:
    setupProxyPid = 0
    setupProxyActivePort = 0
