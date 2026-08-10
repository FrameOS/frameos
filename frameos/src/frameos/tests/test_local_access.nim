## The local-presence ceremony guarding the private-network elevation.

import std/[json, options, os, sequtils, strutils, times, unittest]

import frameos/local_access

suite "local access challenge":
  setup:
    clearLocalAccessChallenge()

  teardown:
    clearLocalAccessChallenge()

  test "no code is on the panel until one is asked for":
    check activeLocalAccessCode() == ""
    check localAccessChallengeSecondsLeft() == 0.0

  test "a challenge mints digits and puts them on the panel":
    let challenge = startLocalAccessChallenge()
    check challenge.code.len == LocalAccessCodeLength
    check challenge.code.allCharsInSet({'0'..'9'})
    check activeLocalAccessCode() == challenge.code
    check localAccessChallengeSecondsLeft() > 0.0

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
    check replay.detail.contains("No local access challenge")
    check activeLocalAccessCode() == ""

  test "surrounding whitespace is forgiven, wrong digits are not":
    let code = startLocalAccessChallenge().code
    check consumeLocalAccessCode("  " & code & "\n").ok

    discard startLocalAccessChallenge()
    check not consumeLocalAccessCode("000000x").ok

  test "guessing is capped and burns the challenge":
    let code = startLocalAccessChallenge().code
    let wrong = if code == "111111": "222222" else: "111111"
    for attempt in 1 ..< LocalAccessMaxAttempts:
      check not consumeLocalAccessCode(wrong).ok
      check activeLocalAccessCode() == code
    # The last life: the challenge is torn down, so even the real code fails.
    check not consumeLocalAccessCode(wrong).ok
    check activeLocalAccessCode() == ""
    check not consumeLocalAccessCode(code).ok

  test "clearing takes the code off the panel":
    discard startLocalAccessChallenge()
    clearLocalAccessChallenge()
    check activeLocalAccessCode() == ""
    check not consumeLocalAccessCode("123456").ok

suite "local access is persisted outside frame.json":
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

  test "an untouched frame has no stored answer and defers to frame.json":
    check storedLocalNetworkAccess().isNone
    # The legacy fallback: frames elevated before the setting moved keep it.
    check resolveLocalNetworkAccess(true)
    check not resolveLocalNetworkAccess(false)

  test "the stored answer overrides frame.json in both directions":
    persistLocalNetworkAccess(true)
    check storedLocalNetworkAccess() == some(true)
    # This is the whole point: a deploy that rewrites frame.json without the
    # field (the backend's get_frame_json omits it) must not revoke it.
    check resolveLocalNetworkAccess(false)

    persistLocalNetworkAccess(false)
    check not resolveLocalNetworkAccess(true)

  test "the state file lands under state/ and says when it changed":
    persistLocalNetworkAccess(true)
    check fileExists(LocalAccessStatePath)
    let stored = parseJson(readFile(LocalAccessStatePath))
    check stored["allowLocalNetworkAccess"].getBool()
    check stored["updatedAt"].getStr().len > 0

  test "a corrupt state file is not read as elevated":
    createDir("state")
    writeFile(LocalAccessStatePath, "{ this is not json")
    check storedLocalNetworkAccess().isNone
    check not resolveLocalNetworkAccess(false)

  test "a state file without the key does not elevate either":
    createDir("state")
    writeFile(LocalAccessStatePath, """{"updatedAt": "whenever"}""")
    check storedLocalNetworkAccess().isNone
    check not resolveLocalNetworkAccess(false)
