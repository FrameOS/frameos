import httpclient
import strformat
import strutils
import frameos/types

proc publicScheme*(config: FrameConfig): string =
  if config.httpsProxy.enable: "https" else: "http"

proc publicPort*(config: FrameConfig): int =
  if config.httpsProxy.enable and config.httpsProxy.port > 0:
    config.httpsProxy.port
  else:
    config.framePort

proc publicHost*(config: FrameConfig): string =
  if config.frameHost.len > 0: config.frameHost else: "localhost"

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
  let client = newHttpClient(timeout = 30000)
  try:
    result = client.getContent(url)
  finally:
    client.close()
