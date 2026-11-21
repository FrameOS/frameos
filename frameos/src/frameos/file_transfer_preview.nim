## The browser preview's host for `frameos.transfer` (file_transfer_hooks.nim):
## Upload and Download in the Files scene, between the preview's assets folder
## (/srv/assets, the browser's IndexedDB: tools/wasm/preview-worker.js) and
## the visitor's computer.
##
## A file picker and a download start in the page, from a person's gesture.
## So a request is handed to the page (`send`, through the worker) as JSON
## {id, op, path}; the page opens the picker or saves the file, the worker
## writes what was picked into `path`, and the answer comes back through
## `fileTransferDone`, which says which scene to draw again. Only the
## browser's preview worker turns it on (wasm/wasm_main.nim,
## `frameos_wasm_set_file_transfer`): a plane rendering a board or a virtual
## frame has no page to ask.

import std/json
import frameos/file_transfer_hooks

type
  FileTransferSend* = proc (request: string) {.nimcall, gcsafe, raises: [].}
    ## Hands the page a request: {id, op: "upload" | "download", path}.

var
  sendRequest: FileTransferSend
  nextId = 0
  waiting = 0 ## the request the page has, 0 for none
  waitingOp = ""
  waitingAsker = ""
  lastDone = ""
  lastCount = 0
  lastError = ""
  answers = 0

proc facts(): string =
  $(%*{"upload": true, "download": true, "busy": (if waiting > 0: waitingOp else: ""),
    "done": lastDone, "count": lastCount, "error": lastError, "seq": answers})

proc previewTransfer(asker, op, arg: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    case op
    of "read":
      result = facts()
    of "upload", "download":
      if sendRequest.isNil or arg.len == 0:
        return "false"
      inc nextId
      waiting = nextId
      waitingOp = op
      waitingAsker = asker
      lastDone = ""
      lastCount = 0
      lastError = ""
      sendRequest($(%*{"id": nextId, "op": op, "path": arg}))
      result = "true"
    else:
      result = "false"

proc fileTransferDone*(id: int, ok: bool, count: int, error: string): string =
  ## The page's answer to request `id`: the scene that asked, to draw again,
  ## or "" for an answer to a request a newer one replaced (or none at all).
  if id <= 0 or id != waiting:
    return ""
  result = waitingAsker
  lastDone = if ok: waitingOp else: ""
  lastCount = if ok: max(count, 0) else: 0
  lastError = if ok: "" elif error.len > 0: error else: "failed"
  inc answers
  waiting = 0
  waitingOp = ""
  waitingAsker = ""

proc enableFileTransferPreview*(send: FileTransferSend) =
  ## The hook answers from now on, handing requests to `send`.
  sendRequest = send
  fileTransfer = previewTransfer

proc disableFileTransferPreview*() =
  sendRequest = nil
  fileTransfer = nil
  waiting = 0
  waitingOp = ""
  waitingAsker = ""

proc resetFileTransferPreviewForTests*() =
  disableFileTransferPreview()
  nextId = 0
  lastDone = ""
  lastCount = 0
  lastError = ""
  answers = 0
