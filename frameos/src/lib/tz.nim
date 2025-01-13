import chrono
import os
import system
import strutils

proc initTimeZone*() =
  # TODO: allow users to only load the timezones and years that matter
  const tzData = staticRead("../../assets/compiled/tz/tzdata.json")
  loadTzData(tzData)

proc findSystemTimeZone*(): string =
  let filename = "/etc/timezone"

  try:
    if fileExists(filename):
      let line = readFile(filename).strip()
      if line != "":
        return line
  except:
    discard
  return "UTC"
