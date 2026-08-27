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

const TimeZoneStateFolder = "state" / "tz"

proc timeZoneDataPath*(): string =
  TimeZoneStateFolder / "tzdata.json"

proc timeZoneHashPath*(): string =
  TimeZoneStateFolder / "tzdata.sha256"

proc timeZoneEtagPath*(): string =
  TimeZoneStateFolder / "tzdata.etag"

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

proc initTimeZone*() =
  let overridePath = timeZoneDataPath()
  if fileExists(overridePath) and not timeZoneDataLoadedFromOverride:
    try:
      loadTimeZoneDataFile(overridePath)
      return
    except CatchableError as e:
      echo "FrameOS warning: failed to load timezone data override " & overridePath & ": " & e.msg

  if timeZoneDataLoaded:
    return
  when defined(frameosEmbedded):
    # The full tzdata.json is ~1.4MB — too big for the 3MB OTA app partitions
    # next to QuickJS and pixie. The embedded build runs in UTC; an override
    # file can still be loaded from /state/tz/tzdata.json above. (Baking the
    # frame's own zone at firmware build time is a follow-up.)
    timeZoneDataLoaded = true
  else:
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


# ---------------------------------------------------------------------------
# Per-zone slices (ESP32). The full tzdata.json is ~1.4 MB; a board with one
# zone needs that zone's transitions from last year onward — about 1.5 KB in
# the same {"timezones","dstChanges"} shape, so chrono loads it unchanged.
# Producers: ../tz (dist/zone/<Zone>.json), the backend (embedded settings
# poll + baked firmware default) and the cloud (set_settings timezone_data).
# The C side (fos_tz.c) keeps the slice in /state/tz.json and installs the
# POSIX rule derived here so newlib, QuickJS Date and the schedule agree with
# chrono.

proc loadTimeZoneSlice*(sliceJson: string): bool {.gcsafe.} =
  ## Loads a per-zone slice into chrono. False (and the old data kept) when
  ## the payload is not a slice.
  try:
    let parsed = parseJson(sliceJson)
    if parsed.kind != JObject or not parsed.hasKey("timezones") or not parsed.hasKey("dstChanges") or
        parsed["timezones"].kind != JArray or parsed["dstChanges"].kind != JArray or
        parsed["timezones"].len == 0:
      return false
    loadTimeZoneData(sliceJson, fromOverride = true)
    true
  except CatchableError:
    false

proc tzAbbreviation(name: string, offsetSeconds: int): string =
  ## POSIX wants ≥3 alphabetic chars or a <quoted> name; chrono's names are
  ## abbreviations ("CET") or numeric ("+04"), so quote anything odd.
  var alpha = true
  for ch in name:
    if ch notin {'a'..'z', 'A'..'Z'}:
      alpha = false
      break
  if alpha and name.len >= 3:
    return name
  let total = abs(offsetSeconds) div 60
  let sign = if offsetSeconds < 0: "-" else: "+"
  result = "<" & sign & align($(total div 60), 2, '0')
  if total mod 60 != 0:
    result.add(align($(total mod 60), 2, '0'))
  result.add(">")

proc posixOffset(offsetSeconds: int): string =
  ## POSIX offsets are west-positive: UTC+1 is "-1".
  let total = abs(offsetSeconds)
  result = (if offsetSeconds > 0: "-" else: "")
  result.add($(total div 3600))
  let minutes = (total mod 3600) div 60
  if minutes != 0:
    result.add(":" & align($minutes, 2, '0'))

proc posixRuleDate(localEpoch: float): string =
  ## "Mm.w.d/h" for a transition, in the wall clock in force BEFORE it —
  ## the way POSIX expects. Week 5 means "last", which is what the EU/US
  ## "last Sunday" / "first Sunday" rules need.
  let cal = Timestamp(localEpoch).calendar()
  let daysInMonth = cal.daysInMonth()
  let week = if cal.day + 7 > daysInMonth: 5 else: (cal.day - 1) div 7 + 1
  let weekday = cal.weekday # 0 = Monday in chrono
  let posixWeekday = (weekday + 1) mod 7 # 0 = Sunday
  result = "M" & $cal.month & "." & $week & "." & $posixWeekday
  if cal.hour != 2 or cal.minute != 0:
    result.add("/" & $cal.hour)
    if cal.minute != 0:
      result.add(":" & align($cal.minute, 2, '0'))

proc utcOffsetSeconds*(timeZone: string, epoch: float): int =
  ## The zone's UTC offset (seconds east, DST folded in) at `epoch` from the
  ## loaded chrono data; 0 for UTC and for zones that are not loaded. The
  ## wasm preview routes QuickJS's Date through this so JS clocks follow the
  ## frame's zone like the Nim side does.
  let name = canonicalTimeZone(timeZone)
  if name.len == 0 or name.toLowerAscii() in ["utc", "etc/utc", "uct", "universal", "zulu", "z"]:
    return 0
  initTimeZone()
  let tz = findTimeZone(name)
  if not tz.valid:
    return 0
  result = 0
  for change in findDstChanges(tz):
    if change.start > epoch:
      break
    result = change.offset.int

proc posixTzRule*(timeZone: string, nowEpoch: float): string =
  ## The POSIX TZ rule matching the loaded chrono data at `nowEpoch`:
  ## "STD-1DST,Mm.w.d,Mm.w.d" when the zone alternates over the coming year,
  ## plain "STD-1" otherwise. Empty when the zone is not loaded. Valid until
  ## the rule itself changes — the next slice refresh replaces it.
  let tz = findTimeZone(timeZone)
  if not tz.valid:
    return ""
  var changes: seq[DstChange] = @[]
  for change in findDstChanges(tz):
    changes.add(change)
  if changes.len == 0:
    return ""
  var current = changes[0]
  var currentIdx = 0
  for idx, change in changes:
    if change.start > nowEpoch:
      break
    current = change
    currentIdx = idx
  # The next two transitions tell us whether DST alternates.
  if currentIdx + 2 >= changes.len:
    return tzAbbreviation(current.name, current.offset) & posixOffset(current.offset)
  let next = changes[currentIdx + 1]
  let after = changes[currentIdx + 2]
  if after.offset != current.offset or next.offset == current.offset or
      next.start - current.start > 370 * 86400.0:
    return tzAbbreviation(current.name, current.offset) & posixOffset(current.offset)
  # Which of the two is standard time? The smaller offset.
  var std = current
  var dst = next
  var stdStart = after.start # standard time resumes at `after`
  var dstStart = next.start
  if current.offset > next.offset:
    std = next
    dst = current
    stdStart = next.start
    dstStart = after.start
  result = tzAbbreviation(std.name, std.offset) & posixOffset(std.offset) &
    tzAbbreviation(dst.name, dst.offset)
  if dst.offset - std.offset != 3600:
    result.add(posixOffset(dst.offset))
  # Start of DST is expressed in standard wall time, its end in DST wall time.
  result.add("," & posixRuleDate(dstStart + std.offset.float))
  result.add("," & posixRuleDate(stdStart + dst.offset.float))
