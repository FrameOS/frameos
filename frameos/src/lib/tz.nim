import chrono
import json
import locks
import os
import system
import strutils
import tables

var timeZoneDataLoaded = false
var timeZoneAliasDataLoaded = false
var timeZoneDataLoadedFromOverride = false
var timeZoneAliases: Table[string, string]
var timeZoneDataLock: Lock
initLock(timeZoneDataLock)

proc timeZoneDataPath*(assetsPath: string): string =
  assetsPath / ".frameos" / "tz" / "tzdata.json"

proc timeZoneHashPath*(assetsPath: string): string =
  assetsPath / ".frameos" / "tz" / "tzdata.sha256"

proc loadedTimeZoneDataSource*(): string =
  if timeZoneDataLoadedFromOverride:
    "override"
  elif timeZoneDataLoaded:
    "embedded"
  else:
    ""

proc loadTimeZoneData*(tzData: string, fromOverride = false) {.gcsafe.} =
  withLock timeZoneDataLock:
    {.cast(gcsafe).}:
      loadTzData(tzData)
    timeZoneDataLoaded = true
    timeZoneDataLoadedFromOverride = fromOverride

proc loadTimeZoneDataFile*(path: string) =
  loadTimeZoneData(readFile(path), fromOverride = true)

proc initTimeZone*(assetsPath = "") =
  if assetsPath.len > 0:
    let overridePath = timeZoneDataPath(assetsPath)
    if fileExists(overridePath) and not timeZoneDataLoadedFromOverride:
      try:
        loadTimeZoneDataFile(overridePath)
        return
      except CatchableError as e:
        echo "FrameOS warning: failed to load timezone data override " & overridePath & ": " & e.msg

  if timeZoneDataLoaded:
    return
  # TODO: allow users to only load the timezones and years that matter
  const tzData = staticRead("../../assets/compiled/tz/tzdata.json")
  loadTimeZoneData(tzData)

proc initTimeZoneAliases() =
  if timeZoneAliasDataLoaded:
    return
  const aliasData = staticRead("../../assets/compiled/tz/timezone_aliases.json")
  let aliases = parseJson(aliasData)
  if aliases.kind == JObject:
    for alias, target in aliases:
      if target.kind == JString:
        timeZoneAliases[alias] = target.getStr()
  timeZoneAliasDataLoaded = true

proc canonicalTimeZone*(timeZone: string): string =
  result = timeZone.strip()
  if result.len == 0:
    return
  initTimeZoneAliases()
  if timeZoneAliases.hasKey(result):
    return timeZoneAliases[result]


proc detectSystemTimeZone*(): string =
  ## Returns e.g. "Europe/Brussels"; never raises.
  const zoneinfoPrefixes = [
    "/usr/share/zoneinfo/",
    "/etc/zoneinfo/",
    "/var/db/timezone/zoneinfo/"
  ]
  const relativeZoneinfoPrefixes = [
    "usr/share/zoneinfo/",
    "etc/zoneinfo/",
    "var/db/timezone/zoneinfo/"
  ]
  try:
    # Works whenever /etc/localtime is a symlink (systemd-managed distros)
    let tgt = expandSymlink("/etc/localtime")
    for prefix in zoneinfoPrefixes:
      if tgt.startsWith(prefix):
        result = tgt[prefix.len .. ^1] # strip the prefix
        break
    if result.len == 0:
      for prefix in relativeZoneinfoPrefixes:
        let index = tgt.find(prefix)
        if index >= 0:
          result = tgt[index + prefix.len .. ^1]
          break

    if result.len == 0:
      echo "Unknown timezone path: " & tgt
  except OSError: discard

  # Debian/Raspberry-Pi fallback: /etc/timezone is a plain text copy
  if result.len == 0 and fileExists("/etc/timezone"):
    result = readFile("/etc/timezone").strip()

  # Last-ditch: stay explicit
  if result.len == 0:
    return "UTC"

  let lc = result.toLowerAscii()
  if lc in ["etc/utc", "utc", "uct", "universal", "zulu", "z"]:
    return "UTC"

  result = canonicalTimeZone(result)
  initTimeZone()
  # check if result is a valid timezone
  if not valid(findTimeZone(result)):
    echo "FrameOS warning: timezone not recognized, using UTC instead of ", result
    return "UTC"
