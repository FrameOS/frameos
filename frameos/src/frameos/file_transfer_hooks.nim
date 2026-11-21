## Files between a frame's assets and the computer showing the frame
## (docs/scene-store.md "The Files app"): what a JS app reads and asks with
## `frameos.transfer(op, args)`. The Files sample scene is the app that uses
## it.
##
## Only the browser preview has a host (frameos/file_transfer_preview.nim,
## turned on by its worker): a picker and a download need a page, a person at
## it and a gesture there. A Pi, an ESP32 and a plane rendering a board leave
## the hook nil and the app reads null, so it shows no Upload or Download. The
## ESP32 has no bridge at all (`jsTransfer` is not in its image).

type
  FileTransfer* = proc (asker, op, arg: string): string {.nimcall, gcsafe, raises: [].}
    ## The answer as JSON text, handed to the app as it is: "" is null.
    ## `asker` is the scene asking: the host renders it again when a transfer
    ## is done.
    ##
    ## - "read": the facts: {upload: files can be added, download: a file can
    ##   be saved, busy: "upload" or "download" while the page waits for the
    ##   person, done: the last one that worked or "", count: the files it
    ##   moved, error: the last one's refusal code ("cancelled", "too_big",
    ##   "failed") or "", seq: moves by one at every answer}.
    ## - "upload" (`arg` the absolute folder the files go into, inside the
    ##   assets the app may write), "download" (`arg` the absolute file):
    ##   asked of the page, "true". A new one replaces one still waiting.
    ##   js_runtime/app_runtime.nim resolves the path against the app's
    ##   sandbox first; a host never sees a path the app could not write or
    ##   read itself.

var fileTransfer*: FileTransfer
