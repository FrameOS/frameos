## Filesystem junk filtering.
##
## SD cards travel through Windows, macOS and NAS boxes before they are
## plugged into a frame, and every one of them leaves droppings behind:
## `.DS_Store`, `._IMG_1234.jpg` AppleDouble sidecars (named exactly like the
## real photo, but a few KB of binary metadata that fails to decode),
## `Thumbs.db`, `System Volume Information`, `@eaDir`, half-finished
## `.crdownload` transfers. None of these should ever end up in an image
## rotation, and none of them should clutter the asset browser.
##
## The rules here are mirrored in TypeScript for the assets panel:
## `frontend/src/utils/hiddenFiles.ts` — keep the two in sync.
##
## Filtering happens during ENUMERATION only. If a scene points the local
## image app at one exact file, that file is loaded no matter what it is
## called: explicit beats implicit.

import std/[os, strutils]

const
  ## Junk file basenames (compared lowercased).
  junkFileNames* = [
    "thumbs.db",
    "ehthumbs.db",
    "ehthumbs_vista.db",
    "desktop.ini",
  ]

  ## Junk directory basenames (compared lowercased). The dot-prefixed ones are
  ## already covered by the "hidden" rule below; they are listed for clarity.
  junkDirNames* = [
    "$recycle.bin",
    "recycler",
    "system volume information",
    "@eadir",
    "__macosx",
    ".appledouble",
    ".spotlight-v100",
    ".trashes",
    ".fseventsd",
    ".temporaryitems",
    ".documentrevisions-v100",
  ]

  ## Temporary / partial download extensions, plus Windows shortcuts. Only the
  ## trailing extension counts, so `photo.tmp.jpg` is a normal image.
  junkFileExtensions* = [
    ".tmp",
    ".temp",
    ".part",
    ".crdownload",
    ".download",
    ".lnk",
  ]

proc isHiddenName*(name: string): bool =
  ## Any basename starting with a dot. Covers `.DS_Store`, `.hidden`, and the
  ## nasty `._IMG_1234.jpg` AppleDouble sidecars.
  name.len > 0 and name[0] == '.'

proc isJunkDirName*(name: string): bool =
  ## True for directories a recursive walk must not descend into at all.
  if name.len == 0 or name == "." or name == "..":
    return true
  if isHiddenName(name):
    return true
  let lower = name.toLowerAscii()
  for junk in junkDirNames:
    if lower == junk:
      return true
  return false

proc isHiddenOrJunkFile*(name: string): bool =
  ## True for OS/temp droppings that must never enter a rotation or listing.
  if name.len == 0:
    return true
  if isHiddenName(name):
    return true
  if name[^1] == '~': # editor / backup leftovers
    return true
  let lower = name.toLowerAscii()
  for junk in junkFileNames:
    if lower == junk:
      return true
  for junk in junkDirNames:
    if lower == junk:
      return true
  for ext in junkFileExtensions:
    if lower.endsWith(ext):
      return true
  return false

proc hasJunkPathComponent*(path: string): bool =
  ## True when any component of a relative path is hidden/junk — the last
  ## component judged as a file, the leading ones as directories. Use this
  ## when a listing already exists and cannot be re-walked.
  let normalized = path.replace('\\', '/')
  var parts: seq[string] = @[]
  for part in normalized.split('/'):
    if part.len > 0:
      parts.add(part)
  if parts.len == 0:
    return false
  for i in 0 ..< parts.len - 1:
    if isJunkDirName(parts[i]):
      return true
  return isHiddenOrJunkFile(parts[^1])

iterator walkDirRecNoJunk*(dir: string, relative: bool = false): string =
  ## `walkDirRec` that prunes junk directories instead of descending into them
  ## (a Synology `@eaDir` can hold one sidecar per photo) and never yields a
  ## hidden or junk file. Like `walkDirRec`'s defaults it yields regular files
  ## only and follows regular directories only.
  var stack: seq[string] = @[""]
  while stack.len > 0:
    let subDir = stack.pop()
    let fullDir = if subDir.len == 0: dir else: dir / subDir
    for kind, name in walkDir(fullDir, relative = true):
      let relPath = if subDir.len == 0: name else: subDir / name
      case kind
      of pcDir:
        if not isJunkDirName(name):
          stack.add(relPath)
      of pcFile:
        if not isHiddenOrJunkFile(name):
          yield (if relative: relPath else: dir / relPath)
      else:
        discard
