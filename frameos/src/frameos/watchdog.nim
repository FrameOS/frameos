import std/[os, posix, times]

## Minimal sd_notify client (no libsystemd dependency). Every proc is a no-op
## unless systemd set NOTIFY_SOCKET in the environment, so tests and manual
## runs are unaffected.

const WatchdogPingIntervalSeconds = 5.0

var lastWatchdogPing: float

proc sdNotify*(state: string) =
  if state.len == 0:
    return
  let socketPath = getEnv("NOTIFY_SOCKET")
  if socketPath.len == 0 or socketPath[0] notin {'/', '@'}:
    return
  var sa: Sockaddr_un
  sa.sun_family = TSa_Family(AF_UNIX)
  if socketPath.len >= sa.sun_path.len:
    return
  copyMem(addr sa.sun_path[0], unsafeAddr socketPath[0], socketPath.len)
  if socketPath[0] == '@': # abstract socket namespace
    sa.sun_path[0] = '\0'
  let fd = socket(AF_UNIX, SOCK_DGRAM, 0)
  if fd.cint < 0:
    return
  let saLen = SockLen(offsetOf(Sockaddr_un, sun_path) + socketPath.len)
  discard sendto(fd, unsafeAddr state[0], state.len, 0,
                 cast[ptr SockAddr](addr sa), saLen)
  discard close(fd)

proc notifyReady*() =
  ## Tell systemd (Type=notify) that startup finished.
  sdNotify("READY=1")

proc notifyWatchdog*() =
  ## Rate-limited WATCHDOG=1 heartbeat; cheap enough to call from a hot loop.
  ## Call it only from the thread whose liveness should keep the service
  ## alive (the runner thread), so a hang there triggers a systemd restart.
  let now = epochTime()
  if now - lastWatchdogPing < WatchdogPingIntervalSeconds:
    return
  lastWatchdogPing = now
  sdNotify("WATCHDOG=1")
