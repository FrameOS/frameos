## The frame's local network access switch and the local-presence ceremony that turns it
## on (docs/lan-access.md).

import std/[json, options, os, sequtils, strutils, times, unittest]

import frameos/config
import frameos/local_access

suite "local access challenge":
  ## Wrong codes are written to the state file (LocalAccessStatePath is
  ## relative), so each case runs in its own temp cwd.
  var previousDir = ""
  var sandbox = ""

  setup:
    previousDir = getCurrentDir()
    sandbox = getTempDir() / "frameos-local-access-challenge-" & $epochTime()
    createDir(sandbox)
    setCurrentDir(sandbox)
    clearLocalAccessChallenge()
    resetLocalAccessWrongCodes()

  teardown:
    clearLocalAccessChallenge()
    resetLocalAccessWrongCodes()
    setCurrentDir(previousDir)
    removeDir(sandbox)

  test "no code is on the panel until one is asked for":
    check activeLocalAccessCode() == ""
    check localAccessPanelText() == ""
    check localAccessChallengeSecondsLeft() == 0.0

  test "a challenge mints digits and puts them on the panel":
    let challenge = startLocalAccessChallenge()
    check challenge.code.len == LocalAccessCodeLength
    check challenge.code.allCharsInSet({'0'..'9'})
    check challenge.scope == LocalAccessScopeLocalNetwork
    check activeLocalAccessCode() == challenge.code
    check localAccessChallengeSecondsLeft() > 0.0

  test "a code lives five minutes: e-ink is slow to show it":
    check LocalAccessChallengeTtlSeconds == 300.0
    let before = epochTime()
    let challenge = startLocalAccessChallenge()
    check challenge.expiresAt >= before + 299.0
    check localAccessChallengeSecondsLeft() > 290.0

  test "the panel says what the code is for, on two lines":
    let lan = startLocalAccessChallenge()
    check localAccessPanelText() == "Local network access code\n" & lan.code
    let shell = startLocalAccessChallenge(LocalAccessScopeShellApps)
    check localAccessPanelText() == "Shell apps code\n" & shell.code

  test "successive challenges do not repeat":
    # Not a randomness proof, just a guard against a constant sneaking in.
    var seen: seq[string] = @[]
    for _ in 0 ..< 8:
      seen.add(startLocalAccessChallenge().code)
    check seen.deduplicate().len > 1

  test "the right code is accepted exactly once":
    let code = startLocalAccessChallenge().code
    check consumeLocalAccessCode(code).ok
    # Burned: a replay of the same code must not elevate again.
    let replay = consumeLocalAccessCode(code)
    check not replay.ok
    check replay.error == "code_expired"
    check activeLocalAccessCode() == ""

  test "surrounding whitespace is forgiven, wrong digits are not":
    let code = startLocalAccessChallenge().code
    check consumeLocalAccessCode("  " & code & "\n").ok

    discard startLocalAccessChallenge()
    let wrong = consumeLocalAccessCode("000000x")
    check not wrong.ok
    check wrong.error == "invalid_code"

  test "no code at all costs nothing and says so":
    let code = startLocalAccessChallenge().code
    for candidate in ["", "   "]:
      let verdict = consumeLocalAccessCode(candidate)
      check verdict.error == "code_required"
    # Still the whole set of tries left: the right code still works after
    # more empty submissions than there are lives.
    for _ in 0 .. LocalAccessMaxAttempts:
      discard consumeLocalAccessCode("")
    check consumeLocalAccessCode(code).ok

  test "guessing is capped and burns the challenge":
    let code = startLocalAccessChallenge().code
    let wrong = if code == "111111": "222222" else: "111111"
    for attempt in 1 ..< LocalAccessMaxAttempts:
      check consumeLocalAccessCode(wrong).error == "invalid_code"
      check activeLocalAccessCode() == code
    # The last life: the challenge is torn down, so even the real code fails.
    check consumeLocalAccessCode(wrong).error == "too_many_attempts"
    check activeLocalAccessCode() == ""
    check localAccessPanelText() == ""
    check consumeLocalAccessCode(code).error == "code_expired"

  test "wrong codes are capped across challenges, per hour":
    # A new challenge per five guesses must not be a guessing loop.
    for round in 0 ..< 2:
      let code = startLocalAccessChallenge().code
      let wrong = if code == "111111": "222222" else: "111111"
      for attempt in 1 ..< LocalAccessMaxAttempts:
        check consumeLocalAccessCode(wrong).error == "invalid_code"
      check consumeLocalAccessCode(wrong).error == "too_many_attempts"
    check LocalAccessWrongCodeLimit == 10
    check localAccessRateLimited()
    # Spent: even the right code of a fresh challenge is not looked at, and
    # the challenge is left as it was.
    let code = startLocalAccessChallenge().code
    let refused = consumeLocalAccessCode(code)
    check refused.error == "rate_limited"
    check refused.detail == "Too many wrong codes in the last hour. Try again later."
    check consumeLocalAccessCode("").error == "rate_limited"
    check activeLocalAccessCode() == code
    # An hour on, the budget is back.
    ageLocalAccessWrongCodesForTest(LocalAccessWrongCodeWindowSeconds)
    check not localAccessRateLimited()
    check consumeLocalAccessCode(code).ok

  test "a restart does not refill the wrong-code budget":
    # `restart_runtime` and `reboot` come from the same control plane that
    # asks for codes, so the budget lives in the state file.
    for round in 0 ..< 2:
      let code = startLocalAccessChallenge().code
      let wrong = if code == "111111": "222222" else: "111111"
      for attempt in 1 .. LocalAccessMaxAttempts:
        discard consumeLocalAccessCode(wrong)
    check localAccessRateLimited()
    let stored = parseJson(readFile(LocalAccessStatePath))["wrongCodes"]
    check stored["count"].getInt() == LocalAccessWrongCodeLimit
    forgetLocalAccessWrongCodes()
    check localAccessRateLimited()
    check consumeLocalAccessCode(startLocalAccessChallenge().code).error == "rate_limited"

  test "a right code gives no wrong codes back":
    var code = startLocalAccessChallenge().code
    var wrong = if code == "111111": "222222" else: "111111"
    for attempt in 1 .. LocalAccessMaxAttempts:
      discard consumeLocalAccessCode(wrong)
    code = startLocalAccessChallenge().code
    wrong = if code == "111111": "222222" else: "111111"
    for attempt in 1 .. 4:
      check consumeLocalAccessCode(wrong).error == "invalid_code"
    check consumeLocalAccessCode(code).ok
    check not localAccessRateLimited()
    code = startLocalAccessChallenge().code
    wrong = if code == "111111": "222222" else: "111111"
    # The tenth wrong code of the hour still gets its answer; the next asks wait.
    check consumeLocalAccessCode(wrong).error == "invalid_code"
    check localAccessRateLimited()
    check consumeLocalAccessCode(code).error == "rate_limited"

  test "a code for another scope or no code at all is not a wrong code":
    discard startLocalAccessChallenge(LocalAccessScopeShellApps)
    for _ in 0 ..< LocalAccessWrongCodeLimit + 2:
      discard consumeLocalAccessCode("123456", LocalAccessScopeLocalNetwork)
      discard consumeLocalAccessCode("", LocalAccessScopeShellApps)
    check not localAccessRateLimited()

  test "a code is only good for the scope it was shown for":
    let shell = startLocalAccessChallenge(LocalAccessScopeShellApps).code
    # Asking for the wrong scope is not a guess: no life is spent, and the
    # code stays up for the scope it belongs to.
    for _ in 0 .. LocalAccessMaxAttempts:
      check consumeLocalAccessCode(shell, LocalAccessScopeLocalNetwork).error == "code_expired"
    check activeLocalAccessCode() == shell
    check consumeLocalAccessCode(shell, LocalAccessScopeShellApps).ok

    let lan = startLocalAccessChallenge().code
    check consumeLocalAccessCode(lan, LocalAccessScopeShellApps).error == "code_expired"
    check consumeLocalAccessCode(lan, LocalAccessScopeLocalNetwork).ok

  test "a new challenge replaces the old code on the panel":
    let first = startLocalAccessChallenge()
    let firstText = localAccessPanelText()
    var second = startLocalAccessChallenge()
    while second.code == first.code:
      second = startLocalAccessChallenge()
    # The runner repaints when this text stops matching what it drew.
    check localAccessPanelText() != firstText
    check consumeLocalAccessCode(first.code).error == "invalid_code"

  test "clearing takes the code off the panel":
    discard startLocalAccessChallenge()
    clearLocalAccessChallenge()
    check activeLocalAccessCode() == ""
    check localAccessPanelText() == ""
    check consumeLocalAccessCode("123456").error == "code_expired"

  test "only a physical panel can show a code":
    for device in ["", "  ", "web_only", "http.upload", "wasm"]:
      check not localAccessPanelDevice(device)
    for device in ["framebuffer", "waveshare.EPD_7in5_V2", "pimoroni.inky_impression_7",
                   "pimoroni.hyperpixel2r", "pimoroni.inky_python"]:
      check localAccessPanelDevice(device)

  test "the scopes are the two the ceremony knows":
    check isLocalAccessScope("localNetwork")
    check isLocalAccessScope("shellApps")
    check not isLocalAccessScope("")
    check not isLocalAccessScope("LocalNetwork")

suite "the code and the image sinks":
  teardown:
    clearLocalAccessCodeOnPanel()

  test "a read is trusted only when no code was out before, after, or in between":
    clearLocalAccessCodeOnPanel()
    let clean = localAccessPanelMark()
    check not clean.shown
    check not localAccessCodeMayBeOnPanel(clean, localAccessPanelMark())

    markLocalAccessCodeOnPanel()
    let shown = localAccessPanelMark()
    check shown.shown
    check shown.epoch == clean.epoch + 1
    check localAccessCodeMayBeOnPanel(clean, shown)
    check localAccessCodeMayBeOnPanel(shown, shown)

    # A code that went out and came off again while the driver encoded:
    # the epoch moved, so what was read cannot be trusted either.
    clearLocalAccessCodeOnPanel()
    let after = localAccessPanelMark()
    check not after.shown
    check localAccessCodeMayBeOnPanel(clean, after)
    check not localAccessCodeMayBeOnPanel(after, localAccessPanelMark())

suite "Local network access is persisted outside frame.json":
  ## LocalAccessStatePath is relative, so each case runs in its own temp cwd.
  var previousDir = ""
  var sandbox = ""

  setup:
    previousDir = getCurrentDir()
    sandbox = getTempDir() / "frameos-local-access-" & $epochTime()
    createDir(sandbox)
    setCurrentDir(sandbox)
    forgetStoredLocalNetworkAccess()

  teardown:
    setCurrentDir(previousDir)
    removeDir(sandbox)
    forgetStoredLocalNetworkAccess()

  test "an untouched frame has no stored answer and is on":
    # A frame with no value anywhere predates the switch and reached its LAN.
    check storedLocalNetworkAccess().isNone
    check lanAccessEnabled()

  test "the stored answer is the answer, in both directions":
    persistLocalNetworkAccess(false)
    check storedLocalNetworkAccess() == some(false)
    check not lanAccessEnabled()
    persistLocalNetworkAccess(true)
    check lanAccessEnabled()

  test "the state file lands under state/ and says when it changed":
    persistLocalNetworkAccess(true)
    check fileExists(LocalAccessStatePath)
    let stored = parseJson(readFile(LocalAccessStatePath))
    check stored["allowLocalNetworkAccess"].getBool()
    check stored["updatedAt"].getStr().len > 0

  test "a corrupt state file reads as no answer":
    createDir("state")
    writeFile(LocalAccessStatePath, "{ this is not json")
    check storedLocalNetworkAccess().isNone

  test "a state file without the key is no answer either":
    createDir("state")
    writeFile(LocalAccessStatePath, """{"updatedAt": "whenever", "allowShellApps": true}""")
    check storedLocalNetworkAccess().isNone

  test "a first start stores the value set at creation":
    check seedLocalNetworkAccess(some(false)) == false
    check storedLocalNetworkAccess() == some(false)
    check parseJson(readFile(LocalAccessStatePath))["allowLocalNetworkAccess"].getBool() == false
    check not lanAccessEnabled()

  test "a frame from before the switch is seeded on":
    check seedLocalNetworkAccess(none(bool)) == true
    check parseJson(readFile(LocalAccessStatePath))["allowLocalNetworkAccess"].getBool() == true

  test "once stored, a later frame.json cannot change it":
    discard seedLocalNetworkAccess(some(false))
    # A deploy writes a fresh frame.json that says on: not a way in.
    check seedLocalNetworkAccess(some(true)) == false
    forgetStoredLocalNetworkAccess()
    check seedLocalNetworkAccess(some(true)) == false
    check not lanAccessEnabled()
    # Nor the other way round.
    persistLocalNetworkAccess(true)
    check seedLocalNetworkAccess(some(false)) == true

  test "seeding keeps the other fact in the file":
    persistAllowShellApps(true)
    forgetStoredLocalNetworkAccess()
    discard seedLocalNetworkAccess(some(false))
    let data = parseJson(readFile(LocalAccessStatePath))
    check data["allowShellApps"].getBool()
    check data["allowLocalNetworkAccess"].getBool() == false

  test "frame.json network.lanAccess is read with its presence":
    writeFile("frame.json", $(%*{"network": {"lanAccess": false}}))
    check frameJsonLanAccessSeed("frame.json") == some(false)
    writeFile("frame.json", $(%*{"network": {"lanAccess": true}}))
    check frameJsonLanAccessSeed("frame.json") == some(true)
    writeFile("frame.json", $(%*{"network": {"lanAccess": "false"}}))
    check frameJsonLanAccessSeed("frame.json") == some(false)
    writeFile("frame.json", $(%*{"network": {"lanAccess": 1}}))
    check frameJsonLanAccessSeed("frame.json") == some(true)
    writeFile("frame.json", $(%*{"network": {"lanAccess": "maybe"}}))
    check frameJsonLanAccessSeed("frame.json").isNone
    writeFile("frame.json", $(%*{"network": {"wifiHotspot": "disabled"}}))
    check frameJsonLanAccessSeed("frame.json").isNone
    writeFile("frame.json", $(%*{"name": "no network section"}))
    check frameJsonLanAccessSeed("frame.json").isNone
    check frameJsonLanAccessSeed("missing.json").isNone

  test "the legacy frame.json allowLocalNetworkAccess is noise, not a seed":
    # Settings saves wrote `false` here into many files without anyone
    # choosing it: such a frame predates the switch and stays on.
    writeFile("frame.json", $(%*{"network": {"allowLocalNetworkAccess": false}}))
    check frameJsonLanAccessSeed("frame.json").isNone
    check seedLocalNetworkAccess(frameJsonLanAccessSeed("frame.json")) == true
    check lanAccessEnabled()
    # ...and the old key does not break parsing the file.
    check readConfig("frame.json").network.networkCheck == false

  test "frame.json's local network access keys change nothing once a value is stored":
    # An old frame.json still carries `allowLocalNetworkAccess`: it parses
    # like any unknown key, and neither it nor the seed overrides the state.
    writeFile("frame.json", $(%*{"network": {"allowLocalNetworkAccess": true, "lanAccess": true}}))
    persistLocalNetworkAccess(false)
    check readConfig("frame.json").network.networkCheck == false
    check not lanAccessEnabled()
    check seedLocalNetworkAccess(frameJsonLanAccessSeed("frame.json")) == false
    check not lanAccessEnabled()
