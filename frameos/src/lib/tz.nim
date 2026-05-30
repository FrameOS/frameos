import chrono
import os
import system
import strutils

var timeZoneDataLoaded = false

proc initTimeZone*() =
  if timeZoneDataLoaded:
    return
  # TODO: allow users to only load the timezones and years that matter
  const tzData = staticRead("../../assets/compiled/tz/tzdata.json")
  loadTzData(tzData)
  timeZoneDataLoaded = true


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

  initTimeZone()
  # check if result is a valid timezone
  if not valid(findTimeZone(result)):
    echo "FrameOS warning: timezone not recognized, using UTC instead of ", result
    return "UTC"
