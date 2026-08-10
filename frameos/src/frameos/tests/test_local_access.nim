## The local-presence ceremony guarding the private-network elevation.

import std/[sequtils, strutils, unittest]

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
