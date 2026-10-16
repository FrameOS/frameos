## The setup hotspot's own HTTP listener.
##
## While the hotspot is up the phone that joined it talks to 10.42.0.1. When
## the frame's plain listener is not on every interface (`exposeOnlyPort`
## binds it to loopback so only HTTPS is reachable; `bindHost` pins it to
## one address) the captive portal would be unreachable exactly when it
## matters, so the runtime adds a second plain listener for the hotspot and
## removes it when the AP goes down. Caddy used to play this part as a third
## process (`setup_proxy.nim`); now it is one more listener on the same
## mummy server, added and removed while it serves.
##
## The port is the first free one from 8000, as before, so the URL on the
## hotspot scene stays short. Binding 10.42.0.1 itself keeps the listener off
## the LAN; when that address is not on the interface (a NetworkManager
## backend that has not assigned it yet, a test machine) the listener falls
## back to every interface, which is what the Caddy proxy always did.
##
## A second, redirect-only listener sits on 10.42.0.1:80 for the hotspot's
## lifetime: the captive-portal probes a phone sends when it joins a network
## (`captiveProbePaths` in web_routes.nim) go to port 80, and with the
## hotspot's DNS answering every name with 10.42.0.1 they land here. The
## router answers anything on that port with a 302 to the setup URL
## (`captivePortalRedirect`), which is what makes the OS open its "sign in
## to network" sheet. The unit holds CAP_NET_BIND_SERVICE for this; where
## port 80 cannot be bound (a dev machine, a port already taken) the portal
## works as before, by QR code or typed URL, and the log says so.
import std/locks
import mummy
from std/net import Port
import frameos/types
import ./listeners

const
  hotspotAddress* = "10.42.0.1"
  hotspotCaptivePort* = 80
  hotspotListenerFirstPort = 8000
  hotspotListenerLastPort = 8099

var hotspotListenerLock: Lock
initLock(hotspotListenerLock)
var activeListener: Listener = nil
var activePort = 0
var captiveListener: Listener = nil
var captivePort = 0

proc hotspotListenerPort*(): int {.gcsafe.} =
  ## The port the hotspot listener answers on, 0 when there is none.
  withLock hotspotListenerLock:
    {.cast(gcsafe).}:
      result = activePort

proc hotspotCaptiveListenerPort*(): int {.gcsafe.} =
  ## The port of the redirect-only captive listener, 0 when none is bound.
  withLock hotspotListenerLock:
    {.cast(gcsafe).}:
      result = captivePort

proc stopHotspotListenerLocked(server: mummy.Server) =
  if activeListener != nil and server != nil:
    server.removeListener(activeListener)
  activeListener = nil
  activePort = 0
  if captiveListener != nil and server != nil:
    server.removeListener(captiveListener)
  captiveListener = nil
  captivePort = 0

proc stopHotspotListener*(server: mummy.Server) {.gcsafe.} =
  withLock hotspotListenerLock:
    {.cast(gcsafe).}:
      stopHotspotListenerLocked(server)

proc tryAddListener(server: mummy.Server, address: string): Listener =
  for port in hotspotListenerFirstPort .. hotspotListenerLastPort:
    try:
      return server.addListener(Port(port), address)
    except MummyError:
      continue
  nil

proc tryAddCaptiveListener(server: mummy.Server): Listener =
  ## 10.42.0.1:80, or every interface on :80 when the hotspot address is not
  ## up yet; nil when neither binds (no capability, port taken).
  for address in [hotspotAddress, "0.0.0.0"]:
    try:
      return server.addListener(Port(hotspotCaptivePort), address)
    except MummyError:
      continue
  nil

proc startHotspotListener*(server: mummy.Server, frameConfig: FrameConfig):
    tuple[port: int, address: string, captivePort: int] {.gcsafe.} =
  ## Adds the hotspot's listeners: the portal listener when the config needs
  ## one (`port` and `address`, 0 and "" when none was started: not needed,
  ## no server, or no free port) and the captive-portal redirect listener on
  ## port 80 (`captivePort`, 0 when it could not be bound). The portal URL
  ## does not depend on the captive one.
  withLock hotspotListenerLock:
    {.cast(gcsafe).}:
      stopHotspotListenerLocked(server)
      if server == nil:
        return (0, "", 0)
      captiveListener = tryAddCaptiveListener(server)
      captivePort = if captiveListener != nil: captiveListener.port.int else: 0
      result = (0, "", captivePort)
      if not hotspotNeedsOwnListener(frameConfig):
        return
      var address = hotspotAddress
      var listener = tryAddListener(server, address)
      if listener == nil:
        address = "0.0.0.0"
        listener = tryAddListener(server, address)
      if listener == nil:
        return
      activeListener = listener
      activePort = listener.port.int
      result = (activePort, address, captivePort)
