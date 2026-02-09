import strformat
import frameos/types

proc publicScheme*(config: FrameConfig): string =
  if config.enableTls: "https" else: "http"

proc publicPort*(config: FrameConfig): int =
  if config.enableTls and config.tlsPort > 0:
    config.tlsPort
  else:
    config.framePort

proc publicHost*(config: FrameConfig): string =
  if config.frameHost.len > 0: config.frameHost else: "localhost"

proc publicBaseUrl*(config: FrameConfig): string =
  &"{publicScheme(config)}://{publicHost(config)}:{publicPort(config)}"
