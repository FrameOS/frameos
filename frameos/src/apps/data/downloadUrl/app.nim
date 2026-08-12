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
