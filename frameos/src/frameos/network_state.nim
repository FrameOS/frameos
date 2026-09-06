## The outcome of the last internet connectivity check, readable from any
## thread. `checkNetwork` / the portal's `connectToWifi` run on the main
## thread and own `FrameOS.network`; the status screen (system/index) renders
## on the scene thread with only a FrameConfig in hand, and the setup portal's
## "Saved!" page polls it over HTTP — so the result lives here, behind a lock,
## the way render_stats keeps its numbers.

import locks
import strutils
import times
import frameos/types

type
  NetworkCheckResult* = object
    status*: NetworkStatus ## `idle` until a check has run
    detail*: string        ## why it failed ("timed out after 30 s", "HTTP 503", …); empty on success
    checkedAt*: float      ## epoch seconds of the last update, 0 when never

var networkStateLock: Lock
initLock(networkStateLock)
var lastResult: NetworkCheckResult

proc noteNetworkCheck*(status: NetworkStatus, detail = "") {.gcsafe.} =
  {.cast(gcsafe).}:
    withLock networkStateLock:
      lastResult = NetworkCheckResult(status: status, detail: detail.strip(), checkedAt: epochTime())

proc lastNetworkCheck*(): NetworkCheckResult {.gcsafe.} =
  {.cast(gcsafe).}:
    withLock networkStateLock:
      result = lastResult

proc resetNetworkCheckForTest*() =
  withLock networkStateLock:
    lastResult = NetworkCheckResult()

proc internetLine*(check: NetworkCheckResult): string =
  ## One status-screen row under "Network": the LAN address says the network
  ## is up, this says whether the internet is reachable through it.
  const maxDetail = 72
  var detail = check.detail
  if detail.len > maxDetail:
    detail = detail[0 ..< maxDetail - 1] & "…"
  case check.status
  of NetworkStatus.connected: "connected"
  of NetworkStatus.connecting: "checking…"
  of NetworkStatus.timeout, NetworkStatus.error:
    if detail.len > 0: "no internet — " & detail else: "no internet"
  of NetworkStatus.idle: "not checked"
