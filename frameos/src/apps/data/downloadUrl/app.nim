import std/json
import frameos/apps
import frameos/spool
import frameos/types
import frameos/utils/http_client
import frameos/utils/memory

type
  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

const
  MinSpoolThresholdBytes = 256 * 1024
    ## Below this a body is never worth a file: the syscalls and the flash wear
    ## cost more than the memory does.
  MaxSpoolThresholdBytes = 8 * 1024 * 1024
    ## And above it, a host with gigabytes free should still not sit on an
    ## unbounded body just because it can.

proc spoolThreshold*(): int =
  ## How large a body may get before it goes to storage instead of memory.
  ##
  ## Derived from live memory rather than fixed, because the same number is
  ## wrong at both ends: a quarter of what a device can still allocate is
  ## generous on a host and appropriately mean on an ESP32 whose PSRAM is
  ## already carrying a canvas. `availableRenderBytes` returns 0 when it does
  ## not know, which means "no spooling" — the same behaviour as before.
  let available = availableRenderBytes()
  if available <= 0:
    return 0
  clamp(available div 4, MinSpoolThresholdBytes, MaxSpoolThresholdBytes)

proc get*(self: App, context: ExecutionContext): Spool =
  let url = self.appConfig.url
  try:
    let body = boundedGetContent(url, maxBytes = self.maxHttpResponseBytes())
    # The response still arrives whole from the HTTP client; what changes here
    # is what the graph carries afterwards. A big body lands in a file and the
    # edge holds a window, so a consumer that folds (icalJson) never needs the
    # document resident and the copy the interpreter would otherwise keep alive
    # for the length of the render goes away.
    let threshold = spoolThreshold()
    if threshold <= 0 or body.len <= threshold:
      return newMemorySpool(body)
    var writer = initSpoolWriter(threshold, self.spoolDir())
    writer.add(body, "downloadUrl-" & $self.nodeId.int & ".tmp")
    let reachedStorage = writer.spilled()
    let spooled = writer.finish()
    self.log(%*{
      "event": "spool",
      "bytes": spooled.len,
      "thresholdBytes": threshold,
      # The tier that was actually reached. A storage probe can fail — no SD
      # card, a full filesystem — and the honest answer is then "memory", which
      # is what this app always did.
      "tier": (if reachedStorage: "storage" else: "memory"),
      "path": spooled.path()
    })
    spooled
  except CatchableError as e:
    self.logError e.msg
    newMemorySpool(e.msg)
