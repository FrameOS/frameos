## The browser preview's host for `frameos.transfer` (file_transfer_preview.nim),
## with the page answered by hand: the facts it hands the app, the request it
## hands the page, the answer that names the scene to draw again, and an
## answer to a request a newer one replaced.

import std/[json, unittest]
import ../file_transfer_hooks
import ../file_transfer_preview

var sent: seq[JsonNode]

proc fakePage(request: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      sent.add(parseJson(request))
    except Exception:
      discard

proc facts(): JsonNode =
  parseJson(fileTransfer("asset-browser", "read", ""))

suite "files to and from the computer in the browser preview":
  setup:
    resetFileTransferPreviewForTests()
    sent = @[]

  test "answers nothing until the preview turns it on":
    check fileTransfer.isNil
    enableFileTransferPreview(fakePage)
    let f = facts()
    check f["upload"].getBool()
    check f["download"].getBool()
    check f["busy"].getStr() == ""
    check f["done"].getStr() == ""
    check f["seq"].getInt() == 0
    disableFileTransferPreview()
    check fileTransfer.isNil

  test "hands the page an upload, and draws the scene that asked when the files are in":
    enableFileTransferPreview(fakePage)
    check fileTransfer("asset-browser", "upload", "/srv/assets/photos") == "true"
    check sent.len == 1
    check sent[0]["op"].getStr() == "upload"
    check sent[0]["path"].getStr() == "/srv/assets/photos"
    let id = sent[0]["id"].getInt()
    check id > 0
    check facts()["busy"].getStr() == "upload"
    check fileTransferDone(id, true, 3, "") == "asset-browser"
    let f = facts()
    check f["busy"].getStr() == ""
    check f["done"].getStr() == "upload"
    check f["count"].getInt() == 3
    check f["error"].getStr() == ""
    check f["seq"].getInt() == 1
    # Answered once.
    check fileTransferDone(id, true, 3, "") == ""
    check facts()["seq"].getInt() == 1

  test "a download given up says so, and moves seq":
    enableFileTransferPreview(fakePage)
    check fileTransfer("asset-browser", "download", "/srv/assets/notes.txt") == "true"
    let id = sent[^1]["id"].getInt()
    check sent[^1]["op"].getStr() == "download"
    check fileTransferDone(id, false, 0, "cancelled") == "asset-browser"
    let f = facts()
    check f["done"].getStr() == ""
    check f["error"].getStr() == "cancelled"
    check f["count"].getInt() == 0
    check f["seq"].getInt() == 1

  test "a new request replaces one still waiting, and the old one's answer is nobody's":
    enableFileTransferPreview(fakePage)
    discard fileTransfer("asset-browser", "upload", "/srv/assets")
    let first = sent[^1]["id"].getInt()
    discard fileTransfer("other-scene", "download", "/srv/assets/a.png")
    let second = sent[^1]["id"].getInt()
    check second != first
    check facts()["busy"].getStr() == "download"
    check fileTransferDone(first, true, 1, "") == ""
    check facts()["seq"].getInt() == 0
    check fileTransferDone(second, true, 1, "") == "other-scene"
    check facts()["done"].getStr() == "download"

  test "a failure without a reason is a failure, and nothing is asked without a path":
    enableFileTransferPreview(fakePage)
    check fileTransfer("asset-browser", "upload", "") == "false"
    check fileTransfer("asset-browser", "rename", "/srv/assets/a") == "false"
    check sent.len == 0
    discard fileTransfer("asset-browser", "upload", "/srv/assets")
    check fileTransferDone(sent[^1]["id"].getInt(), false, 0, "") == "asset-browser"
    check facts()["error"].getStr() == "failed"
