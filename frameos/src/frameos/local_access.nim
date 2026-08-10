## Local-presence ceremony for the private-network elevation.
##
## `network.allowLocalNetworkAccess` is the one switch that undoes the
## default-deny protecting a cloud-managed frame's LAN
## (cloud/docs/cloud-frames.md, "sandbox posture"). Keeping it out of the cloud
## settings allowlist stops the *provider* from flipping it, but that alone
## does not prove whoever flipped it is standing in front of the frame — an
## admin session is a password on a LAN-reachable page, not presence.
##
## So the switch moved out of the bulk config save and behind a two-step
## ceremony: ask for a challenge, read the code off the panel, send it back.
## Someone who cannot see the screen cannot complete it.
##
## The state is process-local and deliberately not persisted: a pending
## challenge should not survive a reboot.

import std/[locks, os, strutils, times]

const
  LocalAccessCodeLength* = 6
  LocalAccessChallengeTtlSeconds* = 180.0
  LocalAccessMaxAttempts* = 5

type
  LocalAccessChallenge* = object
    code*: string       ## empty when no challenge is pending
    expiresAt*: float
    attemptsLeft*: int

var
  localAccessLock: Lock
  localAccessChallenge: LocalAccessChallenge

initLock(localAccessLock)

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

proc startLocalAccessChallenge*(): LocalAccessChallenge =
  ## Mint a code and show it on the panel. Replaces any pending challenge, so
  ## an admin who missed the last one can simply ask again.
  let code = randomDigits(LocalAccessCodeLength)
  withLock localAccessLock:
    localAccessChallenge = LocalAccessChallenge(
      code: code,
      expiresAt: epochTime() + LocalAccessChallengeTtlSeconds,
      attemptsLeft: LocalAccessMaxAttempts
    )
    result = localAccessChallenge

proc clearLocalAccessChallenge*() =
  withLock localAccessLock:
    localAccessChallenge = LocalAccessChallenge()

proc activeLocalAccessCode*(): string =
  ## What the renderer should be drawing right now, or "" for nothing.
  withLock localAccessLock:
    if localAccessChallenge.code.len > 0 and localAccessChallenge.expiresAt > epochTime():
      result = localAccessChallenge.code
    else:
      result = ""

proc localAccessChallengeSecondsLeft*(): float =
  withLock localAccessLock:
    if localAccessChallenge.code.len == 0:
      return 0.0
    result = max(0.0, localAccessChallenge.expiresAt - epochTime())

proc consumeLocalAccessCode*(candidate: string): tuple[ok: bool, detail: string] =
  ## Single use: right or wrong, a completed attempt burns the challenge (on
  ## success) or a life (on failure), so the code cannot be brute-forced in the
  ## three minutes it lives for.
  let trimmed = candidate.strip()
  withLock localAccessLock:
    if localAccessChallenge.code.len == 0:
      return (false, "No local access challenge is pending")
    if localAccessChallenge.expiresAt <= epochTime():
      localAccessChallenge = LocalAccessChallenge()
      return (false, "The code shown on the panel has expired")
    if not constantTimeEquals(trimmed, localAccessChallenge.code):
      dec localAccessChallenge.attemptsLeft
      if localAccessChallenge.attemptsLeft <= 0:
        localAccessChallenge = LocalAccessChallenge()
        return (false, "Too many wrong codes; request a new one")
      return (false, "That code does not match the one on the panel")
    localAccessChallenge = LocalAccessChallenge()
    return (true, "")
