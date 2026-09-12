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
import std/locks
import mummy
from std/net import Port
import frameos/types
import ./listeners

const
  hotspotAddress* = "10.42.0.1"
  hotspotListenerFirstPort = 8000
  hotspotListenerLastPort = 8099

var hotspotListenerLock: Lock
initLock(hotspotListenerLock)
var activeListener: Listener = nil
var activePort = 0

proc hotspotListenerPort*(): int {.gcsafe.} =
  ## The port the hotspot listener answers on, 0 when there is none.
  withLock hotspotListenerLock:
    {.cast(gcsafe).}:
      result = activePort

proc stopHotspotListenerLocked(server: mummy.Server) =
  if activeListener != nil and server != nil:
    server.removeListener(activeListener)
  activeListener = nil
  activePort = 0

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

proc startHotspotListener*(server: mummy.Server, frameConfig: FrameConfig): tuple[port: int, address: string] {.gcsafe.} =
  ## Adds the hotspot listener when the config needs one. Returns the port
  ## and address it listens on, or port 0 when none was started (not needed,
  ## no server, or no free port).
  withLock hotspotListenerLock:
    {.cast(gcsafe).}:
      stopHotspotListenerLocked(server)
      if server == nil or not hotspotNeedsOwnListener(frameConfig):
        return (0, "")
      var address = hotspotAddress
      var listener = tryAddListener(server, address)
      if listener == nil:
        address = "0.0.0.0"
        listener = tryAddListener(server, address)
      if listener == nil:
        return (0, "")
      activeListener = listener
      activePort = listener.port.int
      result = (activePort, address)
