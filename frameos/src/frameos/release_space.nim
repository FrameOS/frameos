## Old releases, and the room the next upgrade needs.
##
## Every upgrade and every deploy installs a new release directory under
## /srv/frameos/releases (~110 MB on a Pi) and switches `current` to it. The
## backend's deploy kept the newest ten (frame_deploy_workflow.py,
## `_cleanup_release_artifacts`); the frame's own upgrade path (cloud OTA,
## `frameos upgrade`, the admin page) kept everything. On a 2 GB data
## partition that is a frame guaranteed to stop upgrading after about fifteen
## releases — Cloud-W sat on 2026.9.17 for a week, every attempt refused with
## "Not enough free disk space", while its metrics said the disk was 10% full.
##
## The rule, run by `frameos setup` after every activation and by the upgrade
## before it gives up for space:
## - `current` and the release before it are never touched (the rollback);
## - releases that never finished installing (no `frameos` binary) go first;
## - at most `MaxKeptReleases` complete releases stay, like the backend;
## - and older ones go, oldest first, until the partition has room for the
##   next upgrade (`upgradeHeadroomBytes`).
## Space is the hard guarantee; the count only bounds clutter.

import std/[algorithm, os, strutils, times]
import frameos/utils/system

const
  MaxKeptReleases* = 10
    ## Complete releases kept at most, `current` included — the backend
    ## deploy's number, so both control planes leave a frame the same way.
  UpgradeHeadroomFactor* = 2
    ## The next upgrade needs about twice a release's size free: the download
    ## (~0.6x) and its extraction (~1.2x, upgrade.nim ReleaseExtractSpaceFactor
    ## over the archive), with the new release written into the same space.

proc frameosInstallDir*(): string =
  getEnv("FRAMEOS_DIR", "/srv/frameos").strip(leading = false, trailing = true, chars = {'/'})

proc frameosRemoteInstallDir*(): string =
  getEnv("FRAMEOS_REMOTE_DIR", getEnv("FRAMEOS_AGENT_DIR", frameosInstallDir() / "remote")).strip(
    leading = false,
    trailing = true,
    chars = {'/'},
  )

type
  ReleaseEntry* = object
    name*: string
    bytes*: int64
    complete*: bool  ## has a `frameos` binary: it finished installing
    installedAt*: float ## when its binary was written; the order to prune in

proc upgradeHeadroomBytes*(releaseBytes: int64): int64 =
  ## Free bytes to keep for the next upgrade, from the size of a release.
  if releaseBytes <= 0: 0'i64 else: releaseBytes * UpgradeHeadroomFactor

proc planReleasePrune*(entries: seq[ReleaseEntry], currentName: string, availableBytes, neededBytes: int64,
                       maxKept = MaxKeptReleases, protect: seq[string] = @[]): seq[string] =
  ## Which releases to delete, oldest first. Pure: the caller measured the
  ## entries and the free space. Never plans anything without a `current`.
  if currentName.len == 0:
    return @[]
  var protected = protect
  protected.add(currentName)
  # The rollback: the newest complete release that is not current.
  var previous = ""
  var previousAt = -1.0
  for entry in entries:
    if entry.complete and entry.name != currentName and entry.installedAt > previousAt:
      previous = entry.name
      previousAt = entry.installedAt
  if previous.len > 0:
    protected.add(previous)

  var available = availableBytes
  for entry in entries:
    if not entry.complete and entry.name notin protected:
      result.add(entry.name)
      available += entry.bytes

  var candidates: seq[ReleaseEntry]
  var kept = 0
  for entry in entries:
    if entry.complete:
      inc kept
      if entry.name notin protected:
        candidates.add(entry)
  candidates.sort(proc(a, b: ReleaseEntry): int = cmp(a.installedAt, b.installedAt))
  for entry in candidates:
    # availableBytes < 0: statvfs could not answer, so only the count applies.
    let short = availableBytes >= 0 and available < neededBytes
    if kept <= maxKept and not short:
      break
    result.add(entry.name)
    available += entry.bytes
    dec kept

proc directoryBytes*(path: string): int64 =
  ## Bytes of the regular files under `path`, symlinks not followed.
  for kind, file in walkDir(path):
    case kind
    of pcFile:
      try:
        result += getFileSize(file)
      except CatchableError:
        discard
    of pcDir:
      result += directoryBytes(file)
    else:
      discard

proc currentReleaseName*(installDir: string): string =
  ## The release `installDir/current` points at, "" when it does not resolve
  ## to a directory under `installDir/releases`.
  try:
    let target = expandFilename(installDir / "current")
    let releases = expandFilename(installDir / "releases")
    if parentDir(target) == releases and dirExists(target):
      return lastPathPart(target)
  except CatchableError:
    discard
  ""

proc readReleaseEntries*(releasesDir: string, measure = true): seq[ReleaseEntry] =
  ## The release directories under `releasesDir`. Hidden entries (the
  ## upgrade's `.install-*` work directory) and symlinks are not releases.
  for kind, path in walkDir(releasesDir):
    if kind != pcDir:
      continue
    let name = lastPathPart(path)
    if name.startsWith("."):
      continue
    var entry = ReleaseEntry(name: name, complete: fileExists(path / "frameos"))
    try:
      entry.installedAt =
        if entry.complete: getLastModificationTime(path / "frameos").toUnixFloat()
        else: getLastModificationTime(path).toUnixFloat()
    except CatchableError:
      entry.installedAt = 0.0
    if measure:
      entry.bytes = directoryBytes(path)
    result.add(entry)

proc pruneReleases*(installDir: string, remoteInstallDir = "", neededBytes = -1'i64,
                    protect: seq[string] = @[], log: proc(message: string) = nil): seq[string] =
  ## Applies planReleasePrune to `installDir/releases` and deletes the same
  ## names under `remoteInstallDir/releases` (never its own `current`).
  ## `neededBytes` < 0 means "room for the next upgrade", measured from the
  ## current release. A directory that cannot be removed (not root on a
  ## root-owned release) is logged and skipped; nothing here raises.
  proc note(message: string) =
    if not log.isNil:
      log(message)
  let releasesDir = installDir / "releases"
  let currentName = currentReleaseName(installDir)
  if currentName.len == 0 or not dirExists(releasesDir):
    return @[]
  let entries = readReleaseEntries(releasesDir)
  var currentBytes = 0'i64
  for entry in entries:
    if entry.name == currentName:
      currentBytes = entry.bytes
  let needed = if neededBytes >= 0: neededBytes else: upgradeHeadroomBytes(currentBytes)
  let available = getAvailableDiskSpace(releasesDir)
  let plan = planReleasePrune(entries, currentName, available, needed, protect = protect)
  let remoteCurrent = if remoteInstallDir.len > 0: currentReleaseName(remoteInstallDir) else: ""
  for name in plan:
    try:
      removeDir(releasesDir / name)
      result.add(name)
    except CatchableError as error:
      note("FrameOS releases: could not remove " & name & ": " & error.msg)
      continue
    if remoteInstallDir.len > 0 and name != remoteCurrent and dirExists(remoteInstallDir / "releases" / name):
      try:
        removeDir(remoteInstallDir / "releases" / name)
      except CatchableError as error:
        note("FrameOS releases: could not remove remote " & name & ": " & error.msg)
  if result.len > 0:
    note("FrameOS releases: removed " & $result.len & " old release(s); " &
      $getAvailableDiskSpace(releasesDir) & " bytes free, " & $needed & " kept for the next upgrade")
