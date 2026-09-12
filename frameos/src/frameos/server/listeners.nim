## Which sockets the on-device HTTP server listens on, decided from the
## frame config alone so it can be unit-tested without binding anything.
##
## - The plain HTTP listener is always there: `framePort` (8787) on every
##   interface, or on `bindHost` when set, or on loopback when the HTTPS
##   listener is meant to be the only one reachable (`exposeOnlyPort`).
## - The HTTPS listener (`httpsProxy.port`, 8443) exists when HTTPS is
##   enabled AND the backend has minted the frame its certificate and key.
##   TLS terminates inside the runtime (a FrameOS/mummy fork with OpenSSL
##   listeners); there is no separate proxy process any more.
##
## The `httpsProxy` name in the config is kept for the API's sake
## (docs/api-triality.md): the shape is the same on Pi, Buildroot and ESP32.
import frameos/types

type
  ListenerSpec* = object
    address*: string
    port*: int
    tls*: bool

proc serverPort*(frameConfig: FrameConfig): int =
  if frameConfig.framePort == 0: 8787 else: frameConfig.framePort

proc httpsPort*(frameConfig: FrameConfig): int =
  if frameConfig.httpsProxy != nil and frameConfig.httpsProxy.port > 0:
    frameConfig.httpsProxy.port
  else:
    8443

proc httpsEnabled*(frameConfig: FrameConfig): bool =
  frameConfig.httpsProxy != nil and frameConfig.httpsProxy.enable

proc hasTlsMaterial*(frameConfig: FrameConfig): bool =
  frameConfig.httpsProxy != nil and
    frameConfig.httpsProxy.serverCert.len > 0 and
    frameConfig.httpsProxy.serverKey.len > 0

proc serverBindAddress*(frameConfig: FrameConfig): string =
  if frameConfig.bindHost.len > 0:
    frameConfig.bindHost
  elif httpsEnabled(frameConfig) and frameConfig.httpsProxy.exposeOnlyPort:
    "127.0.0.1"
  else:
    "0.0.0.0"

proc httpsBindAddress*(frameConfig: FrameConfig): string =
  if frameConfig.bindHost.len > 0: frameConfig.bindHost else: "0.0.0.0"

proc planListeners*(frameConfig: FrameConfig): seq[ListenerSpec] =
  ## The listeners the server should open, plain first. An enabled HTTPS
  ## setting without certificate material yields no TLS listener; the
  ## caller logs that (`tls:default_cert`) rather than serving a made-up
  ## certificate.
  result.add(ListenerSpec(address: serverBindAddress(frameConfig), port: serverPort(frameConfig), tls: false))
  if httpsEnabled(frameConfig) and hasTlsMaterial(frameConfig):
    result.add(ListenerSpec(address: httpsBindAddress(frameConfig), port: httpsPort(frameConfig), tls: true))

proc hotspotNeedsOwnListener*(frameConfig: FrameConfig): bool =
  ## The setup hotspot hands phones 10.42.0.1; a plain listener that is not
  ## on every interface (loopback for `exposeOnlyPort`, or a `bindHost`)
  ## cannot be reached from there, so the portal gets a listener of its own
  ## for as long as the hotspot is up.
  serverBindAddress(frameConfig) != "0.0.0.0"
