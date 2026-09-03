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

import std/[algorithm, locks, tables, times]
import mummy

type RateWindow = object
  count: int
  resetAt: float

const
  MaxRateLimitEntries = 512
  ## Cheap memory bound. Rotating source addresses would otherwise grow this
  ## table without limit. When it fills, expired windows go first and then
  ## the windows closest to expiry — never the whole table, which used to
  ## hand every client a free window each time a rotating flood filled it.
  EvictBatch = MaxRateLimitEntries div 8

var
  rateLimitLock: Lock
  rateWindows: Table[string, RateWindow]

initLock(rateLimitLock)

proc clientKey(request: Request): string =
  let address = request.remoteAddress
  if address.len > 0: address else: "unknown"

proc evictForInsert(now: float) =
  ## Called with the lock held, when the table is full and a new key needs a
  ## slot. Expired windows are free to drop; if none have expired, the
  ## EvictBatch windows that expire soonest go — they have the least budget
  ## left to lose, and a batch keeps this O(n log n) scan off every request.
  var expired: seq[string] = @[]
  for key, window in rateWindows.pairs:
    if window.resetAt <= now:
      expired.add(key)
  for key in expired:
    rateWindows.del(key)
  if rateWindows.len < MaxRateLimitEntries:
    return
  var byExpiry: seq[(float, string)] = @[]
  for key, window in rateWindows.pairs:
    byExpiry.add((window.resetAt, key))
  byExpiry.sort(proc(a, b: (float, string)): int = cmp(a[0], b[0]))
  for index in 0 ..< min(EvictBatch, byExpiry.len):
    rateWindows.del(byExpiry[index][1])

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
        evictForInsert(now)
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

proc rateLimitEntryCount*(): int {.gcsafe.} =
  ## Test seam.
  {.gcsafe.}:
    withLock rateLimitLock:
      result = rateWindows.len
