import std/json
import frameos/apps
import frameos/spool
import frameos/types
import frameos/utils/http_client

type
  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Spool =
  let url = self.appConfig.url
  try:
    # The body never exists whole in memory on the way in: on hosts it streams
    # off the socket into the spool writer, on embedded a body the C side
    # already spilled to storage is adopted as the spool's backing file, and
    # PSRAM-chunked bodies window into the writer. A consumer that folds
    # (icalJson) then never needs the document resident; peak memory on this
    # edge is the window, not the download.
    let threshold = spoolThreshold()
    let spooled = boundedGetSpool(url,
      maxBytes = self.maxHttpResponseBytes(),
      spoolThresholdBytes = threshold,
      spoolDir = self.spoolDir(),
      spoolName = "downloadUrl-" & $self.nodeId.int & ".tmp")
    if spooled.isFileBacked() or (threshold > 0 and spooled.len > threshold):
      self.log(%*{
        "event": "spool",
        "bytes": spooled.len,
        "thresholdBytes": threshold,
        # The tier that was actually reached. A storage probe can fail — no SD
        # card, a full filesystem — and the honest answer is then "memory",
        # which is what this app always did.
        "tier": (if spooled.isFileBacked(): "storage" else: "memory"),
        "path": spooled.path()
      })
    spooled
  except CatchableError as e:
    self.logError e.msg
    newMemorySpool(e.msg)
