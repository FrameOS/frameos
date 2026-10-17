## The frame's local network access switch, and the local-presence ceremony that turns
## it on (docs/lan-access.md).
##
## Local network access decides whether scenes may reach private and local addresses
## (utils/http_client.nim, the private-network deny): off, the deny applies on
## every frame, standalone, backend-managed and cloud-managed alike. The value
## is chosen when the frame is created (frame.json `network.lanAccess`, read
## once as a seed, see seedLocalNetworkAccess) and can be turned off by any
## control plane at any time. Turning it ON for a frame that has it off takes
## more than an admin session, which is only a password on a LAN-reachable
## page, or a control plane, which is only an account: ask for a challenge,
## read the code off the panel, send it back. Someone who cannot see the
## screen cannot complete it.
##
## The challenge is process-local and deliberately not persisted: a pending
## challenge should not survive a reboot. Every value here is read from the
## runner, the HTTP workers and the hub thread, so it is kept as plain values
## under one lock, never as a ref (AGENTS.md, "Refs do not cross threads").

import std/[json, locks, options, os, strutils, times]

import frameos/hal/files

const
  LocalAccessCodeLength* = 6
  # Five minutes: a seven-color e-ink panel takes most of a minute to show
  # the code, and the person still has to walk to the panel and back.
  LocalAccessChallengeTtlSeconds* = 300.0
  LocalAccessMaxAttempts* = 5
  # Across challenges: five tries each would otherwise be a loop of "new
  # challenge, five guesses" for whoever holds a session or the backend's key.
  # At most this many wrong codes per window; while they are spent, neither a
  # new challenge nor a code is taken (`rate_limited`). A right code does not
  # give any back.
  LocalAccessWrongCodeLimit* = 10
  LocalAccessWrongCodeWindowSeconds* = 3600.0

  ## The facts the ceremony can unlock. `localNetwork` is local network access, the only
  ## one a control plane's verbs ever ask for; `shellApps` lets
  ## chromiumScreenshot run Chromium unsandboxed where FrameOS runs as root.
  LocalAccessScopeLocalNetwork* = "localNetwork"
  LocalAccessScopeShellApps* = "shellApps"

  LocalAccessStatePath* = "./state/local_access.json"
    ## Deliberately NOT frame.json. A backend deploy uploads a freshly
    ## generated frame.json over SSH — it never round-trips the device's copy
    ## — so a setting stored there is reset by the next unrelated deploy, or,
    ## worse, turned on by one: the backend's `network.lanAccess` is only the
    ## value chosen when the frame was created (seedLocalNetworkAccess).
    ##
    ## Putting it under state/ also says the right thing about what it is.
    ## Once the frame runs, this is a device-local fact: turning it on was
    ## established by someone physically present, and fleet configuration has
    ## no business overriding it.

type
  LocalAccessChallenge* = object
    code*: string       ## empty when no challenge is pending
    scope*: string      ## which fact a matching code unlocks (LocalAccessScope*)
    expiresAt*: float
    attemptsLeft*: int

  LocalAccessVerdict* = object
    ## What one code check came to. `error` is "" when the code matched, and
    ## otherwise the token the control planes answer with
    ## (docs/cloud-frames-contract.json, `lan_access_set`): `code_required`,
    ## `code_expired`, `invalid_code` or `too_many_attempts`.
    ok*: bool
    error*: string
    detail*: string

  LocalAccessPanelMark* = object
    ## Whether the panel holds a code, as far as the image sinks are
    ## concerned. `epoch` grows every time a code is sent to the panel, so a
    ## reader that sampled the mark before and after a read learns whether a
    ## code could have gone out in between (localAccessCodeMayBeOnPanel).
    shown*: bool
    epoch*: int

var
  localAccessLock: Lock
  localAccessChallenge: LocalAccessChallenge
  # Set by the runner around every driver render (markLocalAccessCodeOnPanel,
  # clearLocalAccessCodeOnPanel), read by `GET /image` on the HTTP workers.
  localAccessPanel: LocalAccessPanelMark
  # The wrong-code budget (LocalAccessWrongCodeLimit): when the current window
  # began (wall clock), and how many wrong codes it has seen. Unlike the
  # challenge it is kept in the state file: the same control plane that asks
  # for codes can send `restart_runtime` or `reboot`, and a budget that a
  # restart refills is no budget. (The ESP32 keeps it in RTC memory.)
  wrongCodeWindowStart = 0.0
  wrongCodeCount = 0
  wrongCodeBudgetLoaded = false
  # The hub thread re-reads the elevation every couple of seconds; boot_guard
  # learned the same lesson, so this is cached rather than parsed each time.
  # A hand-edited state file is picked up on restart, not live.
  persistedAccessCache: Option[bool]
  persistedAccessCacheLoaded = false
  # Same file, same ceremony, second fact: may chromiumScreenshot run its
  # browser unsandboxed when FrameOS runs as root (the `shellApps` scope)?
  # Off unless someone at the panel said yes. Until 2026.10.16 it also let
  # store-origin scenes run the process-spawning apps at all (spawn_guard.nim).
  persistedShellAppsCache: Option[bool]
  persistedShellAppsCacheLoaded = false

initLock(localAccessLock)

proc readStateFile(): JsonNode =
  ## The state file as an object, or an empty object when absent/corrupt.
  try:
    if storedFileExists(LocalAccessStatePath):
      let data = parseJson(readTextFile(LocalAccessStatePath))
      if data.kind == JObject:
        return data
  except CatchableError:
    discard
  %*{}

proc writeStateFile(update: JsonNode) =
  ## Merge `update` into the file so the two facts do not overwrite each other.
  var data = readStateFile()
  for key, value in update.pairs:
    data[key] = value
  data["updatedAt"] = %now().format("yyyy-MM-dd'T'HH:mm:sszzz")
  ensureParentDir(LocalAccessStatePath)
  when defined(frameosEmbedded):
    writeTextFile(LocalAccessStatePath, $data & "\n")
  else:
    # Written aside and renamed into place: a power cut mid-write must not
    # leave a truncated file, which reads as no answer and would be seeded
    # afresh at the next start (seedLocalNetworkAccess).
    let staging = LocalAccessStatePath & ".tmp"
    writeTextFile(staging, $data & "\n")
    moveFile(staging, LocalAccessStatePath)

proc storedLocalNetworkAccess*(): Option[bool] =
  ## What the state file says, or none() when nothing was ever stored: a frame
  ## from before the switch, until seedLocalNetworkAccess has run.
  withLock localAccessLock:
    if persistedAccessCacheLoaded:
      return persistedAccessCache
    persistedAccessCache = none(bool)
    persistedAccessCacheLoaded = true
    # An unreadable or corrupt state file reads as an empty object, never as
    # "elevated".
    let data = readStateFile()
    if data.hasKey("allowLocalNetworkAccess"):
      persistedAccessCache = some(data{"allowLocalNetworkAccess"}.getBool(false))
    result = persistedAccessCache

proc persistLocalNetworkAccess*(enabled: bool) =
  ## Raises on write failure: the caller is an admin request that must not
  ## report success for a change the next reboot would forget.
  writeStateFile(%*{"allowLocalNetworkAccess": enabled})
  withLock localAccessLock:
    persistedAccessCache = some(enabled)
    persistedAccessCacheLoaded = true

proc storedAllowShellApps*(): bool =
  ## Whether chromiumScreenshot may run Chromium unsandboxed on a frame where
  ## FrameOS runs as root. False until the on-panel ceremony has said
  ## otherwise; never read from frame.json (a backend deploy must not be able
  ## to grant it).
  withLock localAccessLock:
    if not persistedShellAppsCacheLoaded:
      persistedShellAppsCache = none(bool)
      persistedShellAppsCacheLoaded = true
      let data = readStateFile()
      if data.hasKey("allowShellApps"):
        persistedShellAppsCache = some(data{"allowShellApps"}.getBool(false))
    result = persistedShellAppsCache.isSome and persistedShellAppsCache.get()

proc persistAllowShellApps*(enabled: bool) =
  writeStateFile(%*{"allowShellApps": enabled})
  withLock localAccessLock:
    persistedShellAppsCache = some(enabled)
    persistedShellAppsCacheLoaded = true

proc forgetStoredLocalNetworkAccess*() =
  ## Test seam; also the right call if the state file is ever edited in place.
  withLock localAccessLock:
    persistedAccessCache = none(bool)
    persistedAccessCacheLoaded = false
    persistedShellAppsCache = none(bool)
    persistedShellAppsCacheLoaded = false

proc seedLocalNetworkAccess*(frameJsonSeed: Option[bool]): bool =
  ## Runs once per runtime start, single-threaded, before anything computes
  ## the policy (frameos.nim, startFrameOS). A frame whose state file has no
  ## answer yet gets one: the value chosen when it was created (frame.json
  ## `network.lanAccess`, config.frameJsonLanAccessSeed) when frame.json has
  ## it, and `true` when it does not, because a frame with no value anywhere
  ## predates the switch and reached its LAN until now. After that the state
  ## file is the only truth, so a later deploy's frame.json cannot turn it on.
  ##
  ## The older frame.json `network.allowLocalNetworkAccess` is not a seed:
  ## settings saves wrote `false` into many files without anyone choosing it.
  ##
  ## A state file that cannot be written leaves the seeded value in memory for
  ## this run (and the next start tries again). Returns the effective value.
  let stored = storedLocalNetworkAccess()
  if stored.isSome:
    return stored.get()
  result = if frameJsonSeed.isSome: frameJsonSeed.get() else: true
  try:
    persistLocalNetworkAccess(result)
  except CatchableError:
    withLock localAccessLock:
      persistedAccessCache = some(result)
      persistedAccessCacheLoaded = true

proc lanAccessEnabled*(): bool =
  ## The frame's local network access, the one value every reader goes through: the
  ## policy (hub_client.refreshLocalNetworkPolicy), readConfig, the admin API
  ## and the hub's `hardware.lanAccess`. Unknown means on, for the same reason
  ## seedLocalNetworkAccess seeds `true`.
  let stored = storedLocalNetworkAccess()
  if stored.isSome: stored.get() else: true

proc randomDigits(count: int): string =
  ## Rejection-sampled so every digit is uniform; a plain `byte mod 10` would
  ## make 0-5 slightly likelier, and this code is an authentication factor.
  result = newStringOfCap(count)
  var source: File
  let opened = open(source, "/dev/urandom", fmRead)
  defer:
    if opened: close(source)
  var buffer: array[64, uint8]
  var available = 0
  var offset = 0
  while result.len < count:
    if offset >= available:
      if opened:
        available = source.readBuffer(addr buffer[0], buffer.len)
        offset = 0
      if not opened or available <= 0:
        # No entropy source: refuse rather than mint a guessable code.
        raise newException(IOError, "Cannot read entropy for the local access code")
    let value = buffer[offset]
    inc offset
    if value >= 250'u8: # 250 = 25 * 10; the tail would bias the digit
      continue
    result.add(chr(ord('0') + (value.int mod 10)))

proc constantTimeEquals(first, second: string): bool =
  if first.len != second.len:
    return false
  var diff = 0
  for i in 0 ..< first.len:
    diff = diff or (ord(first[i]) xor ord(second[i]))
  diff == 0

proc isLocalAccessScope*(scope: string): bool =
  scope == LocalAccessScopeLocalNetwork or scope == LocalAccessScopeShellApps

proc localAccessPanelDevice*(device: string): bool =
  ## Whether what the runner draws reaches a physical panel someone can stand
  ## in front of. The device names the whole output: `web_only` and a frame
  ## with no device at all have none, `http.upload` POSTs the image to a URL,
  ## and the browser preview is a browser. A panel driver never sits next to
  ## one of those (backend drivers.py, drivers_for_frame: one device, one
  ## output driver; evdev and gpioButton only read). Such a frame cannot show
  ## a code and refuses the challenge with `no_panel`, and the runner never
  ## draws one there, so the code cannot ride an upload either.
  let name = device.strip()
  not (name.len == 0 or name == "web_only" or name == "http.upload" or name == "wasm")

const LocalAccessRateLimitedDetail* = "Too many wrong codes in the last hour. Try again later."

proc loadWrongCodeBudgetLocked() =
  ## Caller holds localAccessLock. The budget as the last run left it.
  if wrongCodeBudgetLoaded:
    return
  wrongCodeBudgetLoaded = true
  let budget = readStateFile(){"wrongCodes"}
  if budget != nil and budget.kind == JObject:
    wrongCodeWindowStart = budget{"windowStart"}.getFloat(0.0)
    wrongCodeCount = max(0, budget{"count"}.getInt(0))

proc wrongCodeBudgetSpentLocked(now: float): bool =
  ## Caller holds localAccessLock.
  loadWrongCodeBudgetLocked()
  if wrongCodeCount > 0 and now - wrongCodeWindowStart >= LocalAccessWrongCodeWindowSeconds:
    wrongCodeCount = 0
  wrongCodeCount >= LocalAccessWrongCodeLimit

proc noteWrongCodeLocked(now: float) =
  ## Caller holds localAccessLock. Persisted on every wrong code (they are
  ## rare); a write that fails still counts for this run.
  loadWrongCodeBudgetLocked()
  if wrongCodeCount == 0 or now - wrongCodeWindowStart >= LocalAccessWrongCodeWindowSeconds:
    wrongCodeWindowStart = now
    wrongCodeCount = 0
  inc wrongCodeCount
  try:
    writeStateFile(%*{"wrongCodes": {"windowStart": wrongCodeWindowStart, "count": wrongCodeCount}})
  except CatchableError:
    discard

proc localAccessRateLimited*(): bool =
  ## True while the wrong-code budget is spent: a new challenge is refused
  ## (server/api.nim, startLanAccessChallenge) and so is any code.
  withLock localAccessLock:
    result = wrongCodeBudgetSpentLocked(epochTime())

proc resetLocalAccessWrongCodes*() =
  ## Test seam: an empty budget, and the state file's copy left unread.
  withLock localAccessLock:
    wrongCodeWindowStart = 0.0
    wrongCodeCount = 0
    wrongCodeBudgetLoaded = true

proc forgetLocalAccessWrongCodes*() =
  ## Test seam: the next check reads the budget from the state file, as after
  ## a restart.
  withLock localAccessLock:
    wrongCodeWindowStart = 0.0
    wrongCodeCount = 0
    wrongCodeBudgetLoaded = false

when defined(testing):
  proc ageLocalAccessWrongCodesForTest*(seconds: float) =
    ## Moves the wrong-code window `seconds` into the past.
    withLock localAccessLock:
      wrongCodeWindowStart -= seconds

proc startLocalAccessChallenge*(scope = LocalAccessScopeLocalNetwork): LocalAccessChallenge =
  ## Mint a code and show it on the panel. Replaces any pending challenge, so
  ## an admin who missed the last one can simply ask again; the runner notices
  ## the new code (localAccessPanelText) and repaints. The caller validates
  ## `scope` and checks the frame has a panel first (server/api.nim,
  ## startLanAccessChallenge).
  let code = randomDigits(LocalAccessCodeLength)
  withLock localAccessLock:
    localAccessChallenge = LocalAccessChallenge(
      code: code,
      scope: scope,
      expiresAt: epochTime() + LocalAccessChallengeTtlSeconds,
      attemptsLeft: LocalAccessMaxAttempts
    )
    result = localAccessChallenge

proc clearLocalAccessChallenge*() =
  withLock localAccessLock:
    localAccessChallenge = LocalAccessChallenge()

proc activeLocalAccessCode*(): string =
  ## The code that should be on the panel right now, or "" for nothing.
  withLock localAccessLock:
    if localAccessChallenge.code.len > 0 and localAccessChallenge.expiresAt > epochTime():
      result = localAccessChallenge.code
    else:
      result = ""

proc localAccessPanelText*(): string =
  ## What the runner draws over the scene: a label and the digits on two
  ## lines, or "" for nothing. The runner also compares it with what it last
  ## drew, which is how every end of a challenge — the right code, the fifth
  ## wrong one, expiry, a new challenge — takes the old code off the panel
  ## without anyone having to ask for a render.
  withLock localAccessLock:
    if localAccessChallenge.code.len > 0 and localAccessChallenge.expiresAt > epochTime():
      let label =
        if localAccessChallenge.scope == LocalAccessScopeShellApps: "Shell apps code"
        else: "Local network access code"
      result = label & "\n" & localAccessChallenge.code
    else:
      result = ""

proc localAccessChallengeSecondsLeft*(): float =
  withLock localAccessLock:
    if localAccessChallenge.code.len == 0:
      return 0.0
    result = max(0.0, localAccessChallenge.expiresAt - epochTime())

proc consumeLocalAccessCode*(candidate: string,
                             scope = LocalAccessScopeLocalNetwork): LocalAccessVerdict =
  ## Single use: right or wrong, a completed attempt burns the challenge (on
  ## success) or a life (on failure), so the code cannot be brute-forced in the
  ## five minutes it lives for. A code is only good for the scope it was shown
  ## for: a pending `shellApps` code does not turn local network access on, and asking
  ## for the wrong one costs no life (there is no code for it to guess).
  ##
  ## Every wrong code also counts against the budget across challenges
  ## (LocalAccessWrongCodeLimit). While it is spent the answer is
  ## `rate_limited`, before the pending challenge is looked at at all.
  let trimmed = candidate.strip()
  withLock localAccessLock:
    let now = epochTime()
    if wrongCodeBudgetSpentLocked(now):
      return LocalAccessVerdict(error: "rate_limited", detail: LocalAccessRateLimitedDetail)
    if trimmed.len == 0:
      return LocalAccessVerdict(error: "code_required",
        detail: "Enter the code shown on the frame")
    if localAccessChallenge.code.len == 0 or localAccessChallenge.scope != scope:
      return LocalAccessVerdict(error: "code_expired",
        detail: "No code is showing on the frame; ask for a new one")
    if localAccessChallenge.expiresAt <= now:
      localAccessChallenge = LocalAccessChallenge()
      return LocalAccessVerdict(error: "code_expired",
        detail: "The code shown on the frame has expired; ask for a new one")
    if not constantTimeEquals(trimmed, localAccessChallenge.code):
      noteWrongCodeLocked(now)
      dec localAccessChallenge.attemptsLeft
      if localAccessChallenge.attemptsLeft <= 0:
        localAccessChallenge = LocalAccessChallenge()
        return LocalAccessVerdict(error: "too_many_attempts",
          detail: "Too many wrong codes; ask for a new one")
      return LocalAccessVerdict(error: "invalid_code",
        detail: "That code does not match the one on the frame")
    localAccessChallenge = LocalAccessChallenge()
    return LocalAccessVerdict(ok: true)

# ---- the code and the image sinks -------------------------------------------
# The code is drawn after the render is stored (runner.nim), so the stored last
# image, scene snapshots and `image_get` never see it. One sink does: the
# e-ink drivers' own PNG (drivers.toPng), which they build from the pixels they
# last sent to the panel, and which `GET /image` prefers. The runner marks the
# panel around every driver render; `GET /image` skips the driver's PNG while
# the mark is up, or when it moved during the read.

proc markLocalAccessCodeOnPanel*() =
  ## Before a driver render that carries a code: from here until a render
  ## without one has finished, the driver's own copy may hold the digits.
  withLock localAccessLock:
    localAccessPanel.shown = true
    inc localAccessPanel.epoch

proc clearLocalAccessCodeOnPanel*() =
  ## After a driver render without a code returned: the panel, and the
  ## driver's copy of it, are clean again.
  withLock localAccessLock:
    localAccessPanel.shown = false

proc localAccessPanelMark*(): LocalAccessPanelMark =
  withLock localAccessLock:
    result = localAccessPanel

proc localAccessCodeMayBeOnPanel*(before, after: LocalAccessPanelMark): bool =
  ## For a reader of the driver's own image: true when a code was on the panel
  ## when it started (`before`), when it finished (`after`), or went out in
  ## between (the epoch moved), i.e. whenever what it read cannot be shown to
  ## someone who is not standing at the frame.
  before.shown or after.shown or before.epoch != after.epoch
