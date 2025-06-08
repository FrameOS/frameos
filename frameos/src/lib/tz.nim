import chrono
import os
import system
import strutils

proc initTimeZone*() =
  # TODO: allow users to only load the timezones and years that matter
  const tzData = staticRead("../../assets/compiled/tz/tzdata.json")
  loadTzData(tzData)


proc detectSystemTimeZone*(): string =
  ## Returns e.g. "Europe/Brussels"; never raises.
  const zoneinfoPrefix = "/usr/share/zoneinfo/"
  try:
    # Works whenever /etc/localtime is a symlink (systemd-managed distros)
    let tgt = expandSymlink("/etc/localtime")
    if tgt.startsWith(zoneinfoPrefix):
      result = tgt[zoneinfoPrefix.len .. ^1] # strip the prefix
  except OSError: discard

  # Debian/Raspberry-Pi fallback: /etc/timezone is a plain text copy
  if result.len == 0 and fileExists("/etc/timezone"):
    result = readFile("/etc/timezone").strip()

  # Last-ditch: stay explicit
  if result.len == 0:
    result = "UTC"

  # check if result is a valid timezone
  if not valid(findTimeZone(result)):
    echo "Warning: Detected timezone is not valid: ", result
    result = "UTC"
