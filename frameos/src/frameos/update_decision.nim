## The update decision (docs/auto-updates.md): given the update manifest
## (docs/update-manifest.json) and a frame — the version it runs, its platform
## and target, its cohort key, its channel — which version may it install now?
##
## The Linux runtime's port, for a frame with no control plane
## (auto_updater.nim). The rule is backend/app/utils/update_decision.py; the
## cloud's port is cloud/apps/auth-web/src/lib/update-decision.ts. All three
## replay docs/update-decision-fixtures.json
## (frameos/src/frameos/tests/test_update_decision.nim here): change the three
## and the corpus together.
##
## Pure: no I/O, no globals, safe on any thread.

import std/[json, math, options, strutils, times]
import checksums/sha2

const
  UpdateChannels* = ["stable", "early"]
  UpdateBuckets* = 10000

type VersionTriple* = array[3, int]

proc parseUpdateVersion*(value: string): Option[VersionTriple] =
  ## `2026.11.13` (a leading `v` and a `+build` suffix allowed) as a triple,
  ## or none for anything else ("dev", "unknown", two fields).
  var text = value.strip()
  if text.startsWith("v"):
    text = text[1 .. ^1]
  let plus = text.find('+')
  if plus >= 0:
    text = text[0 ..< plus]
  let parts = text.split('.')
  if parts.len != 3:
    return none(VersionTriple)
  var triple: VersionTriple
  for i, part in parts:
    if part.len == 0 or part.len > 9:
      return none(VersionTriple)
    for ch in part:
      if ch notin {'0' .. '9'}:
        return none(VersionTriple)
    triple[i] = parseInt(part)
  some(triple)

proc parseUpdateVersion*(node: JsonNode): Option[VersionTriple] =
  if node == nil or node.kind != JString:
    return none(VersionTriple)
  parseUpdateVersion(node.getStr())

proc versionText*(v: VersionTriple): string =
  $v[0] & "." & $v[1] & "." & $v[2]

proc cmpVersion(a, b: VersionTriple): int =
  for i in 0 .. 2:
    if a[i] < b[i]: return -1
    if a[i] > b[i]: return 1
  0

proc digitsAt(text: string, pos, count: int, value: var int): bool =
  if pos + count > text.len:
    return false
  var acc = 0
  for i in pos ..< pos + count:
    if text[i] notin {'0' .. '9'}:
      return false
    acc = acc * 10 + (ord(text[i]) - ord('0'))
  value = acc
  true

proc parseUpdateTime*(value: string): Option[float] =
  ## An ISO 8601 time (`Z` or an offset; a bare one is UTC) as unix seconds.
  ## What Python's datetime.fromisoformat reads for the shapes a manifest
  ## uses: `YYYY-MM-DD`, then `T` or a space and `HH:MM[:SS[.frac]]`, then
  ## `Z` or `±HH:MM` / `±HHMM`.
  let text = value.strip()
  if text.len < 10:
    return none(float)
  var year, month, day, hour, minute, second = 0
  var frac = 0.0
  if not digitsAt(text, 0, 4, year) or text[4] != '-' or not digitsAt(text, 5, 2, month) or
      text[7] != '-' or not digitsAt(text, 8, 2, day):
    return none(float)
  var pos = 10
  var offsetSeconds = 0
  if pos < text.len:
    if text[pos] notin {'T', 't', ' '}:
      return none(float)
    inc pos
    if not digitsAt(text, pos, 2, hour):
      return none(float)
    pos += 2
    if pos < text.len and text[pos] == ':':
      if not digitsAt(text, pos + 1, 2, minute):
        return none(float)
      pos += 3
      if pos < text.len and text[pos] == ':':
        if not digitsAt(text, pos + 1, 2, second):
          return none(float)
        pos += 3
        if pos < text.len and text[pos] in {'.', ','}:
          inc pos
          let start = pos
          var scale = 0.1
          while pos < text.len and text[pos] in {'0' .. '9'}:
            frac += float(ord(text[pos]) - ord('0')) * scale
            scale /= 10.0
            inc pos
          if pos == start:
            return none(float)
    if pos < text.len:
      if text[pos] in {'Z', 'z'} and pos + 1 == text.len:
        pos = text.len
      elif text[pos] in {'+', '-'}:
        let sign = if text[pos] == '-': -1 else: 1
        var oh, om = 0
        if not digitsAt(text, pos + 1, 2, oh):
          return none(float)
        var rest = pos + 3
        if rest < text.len and text[rest] == ':':
          inc rest
        if not digitsAt(text, rest, 2, om) or rest + 2 != text.len:
          return none(float)
        offsetSeconds = sign * (oh * 3600 + om * 60)
        pos = text.len
      else:
        return none(float)
  if month < 1 or month > 12 or day < 1 or day > getDaysInMonth(Month(month), year) or
      hour > 23 or minute > 59 or second > 59:
    return none(float)
  try:
    let dt = dateTime(year, Month(month), MonthdayRange(day), HourRange(hour),
                      MinuteRange(minute), SecondRange(second), zone = utc())
    some(float(dt.toTime().toUnix()) + frac - float(offsetSeconds))
  except CatchableError:
    none(float)

proc parseUpdateTime*(node: JsonNode): Option[float] =
  if node == nil or node.kind != JString:
    return none(float)
  parseUpdateTime(node.getStr())

proc cohortBucket*(frameKey, version: string): int =
  ## 0 … 9999: where this frame stands in the rollout of `version`. Salted by
  ## the version, so the first tenth of one release is not the first tenth of
  ## the next.
  var hasher = initSha_256()
  hasher.update(frameKey & "/" & version)
  let hex = ($hasher.digest()).toLowerAscii()
  int(fromHex[uint32](hex[0 ..< 8]) mod uint32(UpdateBuckets))

proc cohortThreshold*(percent: float): int =
  ## The buckets below this are in a rollout at `percent`.
  int(floor(percent * float(UpdateBuckets) / 100.0 + 0.5))

proc patternMatches*(pattern, key: string): bool =
  if pattern.len == 0:
    return false
  if pattern.endsWith("*"):
    return key.startsWith(pattern[0 ..< ^1])
  pattern == key

proc isNumber(node: JsonNode): bool =
  node != nil and node.kind in {JInt, JFloat}

proc rolloutPercent*(release, defaultRollout: JsonNode, now: float): float =
  ## How far the release's rollout has come at `now`: the largest stage
  ## percent whose time has come, frozen at `pausedAt`. No stages = 100.
  var stages = release{"rollout"}
  if stages == nil or stages.kind != JArray:
    stages = if defaultRollout != nil and defaultRollout.kind == JArray: defaultRollout else: newJArray()
  let start = parseUpdateTime(release{"at"})
  if start.isNone:
    return 0.0
  var moment = now
  let pausedAt = parseUpdateTime(release{"pausedAt"})
  if pausedAt.isSome and pausedAt.get < moment:
    moment = pausedAt.get
  if moment < start.get:
    return 0.0
  if stages.len == 0:
    return 100.0
  var percent = 0.0
  for stage in stages.items:
    if stage.kind != JObject:
      continue
    let after = if stage.hasKey("afterHours"): stage["afterHours"] else: %0
    let value = if stage.hasKey("percent"): stage["percent"] else: %0
    if not after.isNumber or not value.isNumber:
      continue
    if start.get + after.getFloat() * 3600.0 <= moment:
      percent = max(percent, value.getFloat())
  max(0.0, min(100.0, percent))

proc blockedReason(release: JsonNode, key: string): string =
  let blocked = release{"blocked"}
  if blocked != nil:
    if blocked.kind == JString and blocked.getStr().len > 0:
      return blocked.getStr()
    if blocked.kind == JBool and blocked.getBool():
      return "blocked"
  let targets = release{"blockedTargets"}
  if targets != nil and targets.kind == JObject:
    for pattern, reason in targets.pairs:
      if patternMatches(pattern, key):
        return if reason.kind == JString and reason.getStr().len > 0: reason.getStr()
               else: "blocked for this target"
  ""

proc visible(release: JsonNode, key, channel: string): bool =
  let channels = release{"channels"}
  if channels != nil and channels.kind == JArray:
    var found = false
    for item in channels.items:
      if item.kind == JString and item.getStr() == channel:
        found = true
    if not found:
      return false
  let targets = release{"targets"}
  if targets != nil and targets.kind == JArray:
    var found = false
    for item in targets.items:
      if item.kind == JString and patternMatches(item.getStr(), key):
        found = true
    if not found:
      return false
  true

proc strField(node: JsonNode, key: string): string =
  let value = node{key}
  if value == nil: return ""
  case value.kind
  of JString: value.getStr()
  of JNull: ""
  of JBool: (if value.getBool(): "True" else: "")
  of JInt: (if value.getInt() == 0: "" else: $value.getInt())
  else: $value

proc formatPercent(percent: float): string =
  if percent == floor(percent): $int(percent) else: $percent

proc decideUpdate*(manifest, request: JsonNode): JsonNode =
  ## The decision for one frame. `request`: current, platform, target,
  ## frameKey, channel ("stable" | "early"; anything else is stable), manual
  ## (an owner asked: the rollout is skipped, blocks and stepping stones are
  ## not), now (ISO time), maxVersion (a ceiling). The answer:
  ## {version, reason, latest, held: {version, why, detail} | null}.
  let manifest = if manifest != nil and manifest.kind == JObject: manifest else: newJObject()
  let request = if request != nil and request.kind == JObject: request else: newJObject()
  let releasesRaw = if manifest{"releases"} != nil and manifest["releases"].kind == JArray:
                      manifest["releases"] else: newJArray()
  let key = strField(request, "platform") & "/" & strField(request, "target")
  let channelNode = request{"channel"}
  let channel =
    if channelNode != nil and channelNode.kind == JString and channelNode.getStr() in UpdateChannels:
      channelNode.getStr()
    else: "stable"
  let manualNode = request{"manual"}
  let manual = manualNode != nil and (
    (manualNode.kind == JBool and manualNode.getBool()) or
    (manualNode.kind == JInt and manualNode.getInt() != 0) or
    (manualNode.kind == JString and manualNode.getStr().len > 0))
  let frameKey = strField(request, "frameKey")
  let nowParsed = parseUpdateTime(request{"now"})
  let now = if nowParsed.isSome: nowParsed.get else: epochTime()
  let ceiling =
    if strField(request, "maxVersion").len > 0: parseUpdateVersion(request{"maxVersion"})
    else: none(VersionTriple)

  var releases: seq[(VersionTriple, JsonNode)] = @[]
  var seen: seq[VersionTriple] = @[]
  for release in releasesRaw.items:
    if release.kind != JObject:
      continue
    let parsed = parseUpdateVersion(release{"version"})
    if parsed.isNone or parsed.get in seen:
      continue
    if ceiling.isSome and cmpVersion(parsed.get, ceiling.get) > 0:
      continue
    if not visible(release, key, channel):
      continue
    seen.add(parsed.get)
    releases.add((parsed.get, release))
  # Insertion sort: a manifest holds a few dozen releases.
  for i in 1 ..< releases.len:
    var j = i
    while j > 0 and cmpVersion(releases[j - 1][0], releases[j][0]) > 0:
      swap(releases[j - 1], releases[j])
      dec j

  let latestText = if releases.len > 0: %versionText(releases[^1][0]) else: newJNull()
  let current = parseUpdateVersion(request{"current"})

  proc answer(version: string, reason: string, held: JsonNode = newJNull()): JsonNode =
    %*{"version": (if version.len > 0: %version else: newJNull()), "reason": reason,
       "latest": latestText, "held": held}

  if current.isNone:
    return answer("", "unknown_version")
  if releases.len == 0 or cmpVersion(releases[^1][0], current.get) <= 0:
    return answer("", "up_to_date")
  let paused = manifest{"paused"}
  if paused != nil and paused.kind == JString and paused.getStr().len > 0:
    return answer("", "paused", %*{"version": latestText, "why": "paused", "detail": paused.getStr()})

  proc minFrom(index: int): Option[VersionTriple] =
    var floorVersion = parseUpdateVersion(releases[index][1]{"minFrom"})
    for k in 0 ..< index:
      let (earlier, other) = releases[k]
      let stone = other{"steppingStone"}
      if stone != nil and stone.kind == JBool and stone.getBool() and
          (floorVersion.isNone or cmpVersion(earlier, floorVersion.get) > 0):
        floorVersion = some(earlier)
    floorVersion

  proc hold(index: int): JsonNode =
    let (parsed, release) = releases[index]
    let text = versionText(parsed)
    let blocked = blockedReason(release, key)
    if blocked.len > 0:
      return %*{"version": text, "why": "blocked", "detail": blocked}
    let start = parseUpdateTime(release{"at"})
    if start.isNone or start.get > now:
      let at = if release{"at"} != nil: $release["at"] else: "None"
      return %*{"version": text, "why": "scheduled", "detail": "rolls out from " & at}
    if not manual and channel != "early":
      let percent = rolloutPercent(release, manifest{"defaultRollout"}, now)
      let inCohort = percent >= 100.0 or
        (frameKey.len > 0 and cohortBucket(frameKey, text) < cohortThreshold(percent))
      if not inCohort:
        return %*{"version": text, "why": "rollout",
                  "detail": "rolling out to " & formatPercent(percent) &
                            "% of frames; this one is in a later stage"}
    let floorVersion = minFrom(index)
    if floorVersion.isSome and cmpVersion(current.get, floorVersion.get) < 0:
      return %*{"version": text, "why": "needs", "detail": "needs " & versionText(floorVersion.get) & " first"}
    nil

  let latestHold = hold(releases.len - 1)
  if latestHold == nil:
    return answer(latestText.getStr(), "latest")
  var index = releases.len - 2
  while index >= 0:
    if cmpVersion(releases[index][0], current.get) <= 0:
      break
    if hold(index) == nil:
      let reason = if latestHold["why"].getStr() == "needs": "stepping_stone" else: "held_back"
      return answer(versionText(releases[index][0]), reason, latestHold)
    dec index
  answer("", "held", latestHold)
