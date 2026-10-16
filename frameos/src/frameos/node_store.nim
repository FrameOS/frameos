## What a scene's nodes keep on storage between runs: the node cache's last
## value (interpreter.nim, `withCache`) and what a JS app keeps with
## `frameos.remember` (js_runtime/app_runtime.nim). Both used to live in RAM
## only, so a restart, a scene reload or an ESP32's deep sleep (every wake is
## a fresh boot) forgot them, and a battery frame re-fetched everything on
## every wake with nothing to fall back on when the network was gone.
##
## One file per node and kind, never one file per scene: a cached value can be
## a whole forecast or a feed, and the scene's state file (scenes.nim) is
## rewritten on every render. Files live flat in one folder, named
## `<fnv32 of the scene id>-<node id>[m].json`, because the ESP32's state
## partition is SPIFFS: no directories, and every name (the folder included)
## must fit in 31 characters.
##
##   Linux   ./state/node-cache  (the release's `state` is /srv/frameos/state)
##   ESP32   /state/nc           (the state partition; factory reset wipes it)
##   wasm    nowhere: the preview recomputes, so an edit is seen at once
##
## Every write is best effort: over the size cap, short of free space or
## failing, the value stays in memory only, as before, and the caller logs why.

import std/[os, strutils, tables, times]
when defined(frameosEmbedded):
  from frameos/spool import spoolHeadroomShortfall
else:
  import frameos/utils/system

  const HostFreeMarginBytes = 100 * 1024 * 1024
    ## What a write must leave free on a host's card, the margin saveAsset and
    ## writeAsset already keep.

proc renameEntry(source, destination: cstring): cint {.importc: "rename", header: "<stdio.h>".}
  ## libc's rename, not std/os moveFile: moveFile's copy fallback handles
  ## symlinks, and ESP-IDF's newlib has no `symlink` to link against.

const
  NodeStoreFileMaxBytes* = when defined(frameosEmbedded): 512 * 1024 else: 32 * 1024 * 1024
    ## The largest file one node may keep. On the ESP32 it is the same ceiling
    ## as a node's `frameos.remember` budget; the state partition also holds
    ## the scene store, and the free-space check below keeps its margin.
  SaneClockEpoch* = 1704067200.0
    ## 2024-01-01. Before the clock is set (an ESP32's cold boot ahead of
    ## SNTP) the time says 1970: a value stored then would look 50 years old
    ## the moment the clock is right, and one loaded then could never expire.

var nodeStoreDirOverride* = ""
  ## Tests point the store at a scratch folder; `-d:testing` builds have no
  ## store until they do, so no other test writes into ./state.

proc nodeStoreDir*(): string =
  ## The folder, or "" when this build keeps nothing on storage.
  when defined(frameosWasm):
    ""
  elif defined(testing):
    nodeStoreDirOverride
  elif defined(frameosEmbedded):
    if nodeStoreDirOverride.len > 0: nodeStoreDirOverride else: "/state/nc"
  else:
    if nodeStoreDirOverride.len > 0: nodeStoreDirOverride else: "./state/node-cache"

proc fnv1a32Hex(text: string): string =
  var hash = 2166136261'u32
  for ch in text:
    hash = (hash xor uint32(ord(ch))) * 16777619'u32
  hash.toHex(8).toLowerAscii()

proc fnv1a64Hex*(parts: varargs[string]): string =
  ## A fingerprint of several strings (each length-prefixed, so ("ab", "c")
  ## and ("a", "bc") differ). Not a security boundary: it only has to change
  ## when what produced a value changes.
  var hash = 14695981039346656037'u64
  for part in parts:
    for ch in $part.len & ":" & part:
      hash = (hash xor uint64(ord(ch))) * 1099511628211'u64
  hash.toHex(16).toLowerAscii()

proc sceneStoreKey*(sceneId: string): string =
  fnv1a32Hex(sceneId)

proc nodeStorePath*(sceneId: string, nodeId: int, suffix = ""): string =
  ## Where one node's file goes; "" when there is no store. `suffix` tells a
  ## node's kinds apart ("" for the cache, "m" for remembered values).
  let dir = nodeStoreDir()
  if dir.len == 0 or sceneId.len == 0:
    return ""
  dir / (sceneStoreKey(sceneId) & "-" & $nodeId & suffix & ".json")

proc clockIsSane*(): bool =
  epochTime() >= SaneClockEpoch

proc ensureStoreDir(dir: string): bool =
  ## The leaf only, then trust the write: on SPIFFS a slash is part of a file
  ## name and no directory ever exists (see spool.usableScratchDir).
  try:
    if dirExists(dir):
      return true
    when defined(frameosEmbedded):
      try:
        discard existsOrCreateDir(dir)
      except CatchableError:
        discard
    else:
      createDir(dir)
    true
  except CatchableError:
    false

proc storeShortfall(dir: string, bytes: int): string =
  when defined(frameosEmbedded):
    spoolHeadroomShortfall(dir, bytes)
  else:
    let free = getAvailableDiskSpace(dir)
    if free >= 0 and free < bytes.int64 + HostFreeMarginBytes:
      return $(free div (1024 * 1024)) & " MB free under " & dir &
        " is not enough to keep " & $(bytes div 1024) & " KB and leave " &
        $(HostFreeMarginBytes div (1024 * 1024)) & " MB"
    ""

proc writeNodeStoreFile*(path, contents: string): string =
  ## Writes `contents` to `path` through a temporary file. Returns "" when it
  ## was kept, otherwise why not (for the caller's log line). Never raises.
  if path.len == 0:
    return "no node store on this frame"
  if contents.len > NodeStoreFileMaxBytes:
    return $(contents.len div 1024) & " KB is over the " &
      $(NodeStoreFileMaxBytes div 1024) & " KB a node may keep"
  let dir = path.parentDir()
  if not ensureStoreDir(dir):
    return "cannot create " & dir
  let previous = try: (if fileExists(path): getFileSize(path).int else: 0) except CatchableError: 0
  let shortfall = storeShortfall(dir, max(0, contents.len - previous))
  if shortfall.len > 0:
    return shortfall
  let temp = path.changeFileExt("tmp")
  try:
    writeFile(temp, contents)
    when defined(frameosEmbedded):
      # SPIFFS will not rename onto an existing name.
      if fileExists(path):
        removeFile(path)
    if renameEntry(temp.cstring, path.cstring) != 0:
      raise newException(OSError, osErrorMsg(osLastError()))
    ""
  except CatchableError as e:
    try:
      if fileExists(temp):
        removeFile(temp)
    except CatchableError:
      discard
    "write failed: " & e.msg

proc readNodeStoreFile*(path: string): string =
  ## The file's contents, or "" when it is missing, unreadable or larger than
  ## any node may keep (a file this runtime did not write). Never raises.
  if path.len == 0:
    return ""
  try:
    if not fileExists(path):
      return ""
    if getFileSize(path) > NodeStoreFileMaxBytes:
      removeFile(path)
      return ""
    readFile(path)
  except CatchableError:
    ""

proc removeNodeStoreFile*(path: string) =
  if path.len == 0:
    return
  try:
    if fileExists(path):
      removeFile(path)
  except CatchableError:
    discard

proc sweepNodeStore*(keepSceneIds: openArray[string]): int =
  ## Deletes the files of every scene not in `keepSceneIds`, and any leftover
  ## temporary file: run when a runtime installs its scene set, so an
  ## uninstalled scene's values do not sit on the card forever. Returns the
  ## number of files removed; never raises.
  let dir = nodeStoreDir()
  if dir.len == 0:
    return 0
  var keep = initTable[string, bool]()
  for sceneId in keepSceneIds:
    keep[sceneStoreKey(sceneId)] = true
  try:
    if not dirExists(dir):
      when not defined(frameosEmbedded):
        return 0
    for kind, path in walkDir(dir):
      if kind != pcFile:
        continue
      let (_, name, ext) = splitFile(path)
      let dash = name.find('-')
      let owner = if dash > 0: name[0 ..< dash] else: ""
      if ext == ".tmp" or owner.len == 0 or not keep.hasKey(owner):
        try:
          removeFile(path)
          inc result
        except CatchableError:
          discard
  except CatchableError:
    discard
