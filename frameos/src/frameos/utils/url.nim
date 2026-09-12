import strformat
import strutils
import frameos/types
when not defined(frameosEmbedded) and not defined(frameosWasm):
  # The hotspot listener lives on the mummy server, which the embedded
  # firmware and the wasm bundle do not compile.
  import frameos/server/hotspot_listener
import frameos/utils/http_client

proc publicScheme*(config: FrameConfig): string =
  if config.httpsProxy.enable: "https" else: "http"

proc publicPort*(config: FrameConfig): int =
  if config.httpsProxy.enable and config.httpsProxy.port > 0:
    config.httpsProxy.port
  else:
    config.framePort

proc publicHost*(config: FrameConfig): string =
  if config.frameHost.len > 0: config.frameHost else: "localhost"

proc hotspotSetupPort*(config: FrameConfig): int =
  ## The port the hotspot scene and captive portal send the phone to: the
  ## hotspot's own listener while one is up, the frame port otherwise.
  when not defined(frameosEmbedded) and not defined(frameosWasm):
    let port = hotspotListenerPort()
    if port > 0:
      return port
  if config.framePort > 0: config.framePort else: 8787

proc publicBaseUrl*(config: FrameConfig): string =
  &"{publicScheme(config)}://{publicHost(config)}:{publicPort(config)}"

proc authenticatedFrameUrl*(config: FrameConfig, path: string, requireWriteAccess = true): string =
  let shouldIncludeAccessKey =
    if requireWriteAccess:
      config.frameAccess != "public"
    else:
      config.frameAccess == "private"

  result = publicBaseUrl(config) & path
  if shouldIncludeAccessKey:
    result &= (if path.contains("?"): "&" else: "?") & "k=" & config.frameAccessKey

proc downloadUrl*(url: string): string =
  boundedGetContent(url, maxBytes = DefaultMaxHttpResponseBytes)

proc downloadUrl*(config: FrameConfig, url: string): string =
  let maxBytes =
    if config != nil and config.maxHttpResponseBytes > 0:
      config.maxHttpResponseBytes
    else:
      DefaultMaxHttpResponseBytes
  boundedGetContent(url, maxBytes = maxBytes)
