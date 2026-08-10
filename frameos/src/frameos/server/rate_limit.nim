## Per-client request throttling for the frame's HTTP server.
##
## The frame runs 1-4 mummy worker threads (see workers.nim), so a handful of
## slow requests is the whole server. Several routes are necessarily open — the
## cloud login handoff happens before anyone is logged in — and one of them
## turns a single anonymous LAN request into an authenticated call to the cloud
## provider. Without a cap, any device on the network can amplify against the
## provider, brute-force the admin password, or simply hold every worker.
##
## Fixed windows, counted in memory: a frame is a single process with no shared
## store, and the limits only need to stop floods, not to be exact. Keys are the
## client address plus a bucket name, so one noisy client cannot spend another's
## budget.
##
## Behind the frame's own TLS proxy every request arrives from 127.0.0.1, which
## collapses all clients into one bucket. That is deliberate: the limits below
## are generous enough for a single admin UI, and failing closed on a shared
## key is better than not limiting at all.

import std/[locks, tables, times]
import mummy

type RateWindow = object
  count: int
  resetAt: float

const
  MaxRateLimitEntries = 512
  ## Cheap memory bound. Rotating source addresses would otherwise grow this
  ## table without limit; a reset costs everyone one free window.

var
  rateLimitLock: Lock
  rateWindows: Table[string, RateWindow]

initLock(rateLimitLock)

proc clientKey(request: Request): string =
  let address = request.remoteAddress
  if address.len > 0: address else: "unknown"

proc rateLimitExceeded*(request: Request, bucket: string, limit: int,
                        windowSeconds: float): bool {.gcsafe.} =
  ## Counts this request and reports whether the caller is over `limit` within
  ## the current window. Call once per request, before doing any real work.
  if limit <= 0 or windowSeconds <= 0:
    return false
  let key = bucket & "|" & clientKey(request)
  let now = epochTime()
  {.gcsafe.}:
    withLock rateLimitLock:
      if rateWindows.len >= MaxRateLimitEntries and not rateWindows.hasKey(key):
        rateWindows.clear()
      var window = rateWindows.getOrDefault(key, RateWindow(count: 0, resetAt: 0.0))
      if window.resetAt <= now:
        window = RateWindow(count: 0, resetAt: now + windowSeconds)
      window.count += 1
      rateWindows[key] = window
      return window.count > limit

proc retryAfterSeconds*(request: Request, bucket: string): int {.gcsafe.} =
  let key = bucket & "|" & clientKey(request)
  let now = epochTime()
  {.gcsafe.}:
    withLock rateLimitLock:
      if rateWindows.hasKey(key):
        let remaining = rateWindows[key].resetAt - now
        if remaining > 0:
          return max(1, int(remaining + 0.999))
  1

proc resetRateLimits*() {.gcsafe.} =
  ## Test seam.
  {.gcsafe.}:
    withLock rateLimitLock:
      rateWindows.clear()
