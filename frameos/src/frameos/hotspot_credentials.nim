## The setup hotspot's network name and password.
##
## The hotspot used to be `FrameOS-Setup` / `frame1234` on every frame, so
## anyone in radio range could join it and use the setup form. Now a frame
## with a screen makes up its own name and password the first time it needs
## them, keeps them in state/ (a backend deploy rewrites frame.json, never
## state/), and the hotspot scene shows both, with a QR code, on the screen.
## A name or password set explicitly in frame.json wins. A frame without a
## screen keeps the fixed default: it has nowhere to show anything else.
##
## "Not set" is an empty value or the old fixed default itself, which is what
## frame.json files, images and backend rows written before this carry.
##
## readConfig folds the result into every config it parses, so every reader
## (the portal, the hotspot scene, the setup page) sees the hotspot as it
## really is. Read from the runner and the HTTP workers alike: plain values
## under one lock.

import std/[json, locks, os, strutils, sysrand]

import frameos/hal/files
import frameos/local_access

const
  DefaultHotspotSsid* = "FrameOS-Setup"
  DefaultHotspotPassword* = "frame1234"
  # No 0/O, 1/I/l: the password is read off an e-ink screen and typed.
  SsidAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  PasswordAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  SsidSuffixLength = 4
  PasswordLength = 10

var
  credentialsLock: Lock
  generatedSsid: string
  generatedPassword: string
  generatedLoaded = false
  hotspotStatePath = "./state/hotspot.json"

initLock(credentialsLock)

proc randomFrom(alphabet: string, count: int): string =
  ## Rejection-sampled so every character is equally likely.
  let limit = 256 - (256 mod alphabet.len)
  result = newStringOfCap(count)
  while result.len < count:
    for value in urandom(count * 2):
      if value.int < limit and result.len < count:
        result.add(alphabet[value.int mod alphabet.len])

proc isSet(value, default: string): bool =
  let trimmed = value.strip()
  trimmed.len > 0 and trimmed != default

proc generatedCredentialsLocked(): tuple[ssid, password: string] =
  ## Caller holds credentialsLock. Made up once per device, then read back.
  if not generatedLoaded:
    generatedLoaded = true
    try:
      if storedFileExists(hotspotStatePath):
        let data = parseJson(readTextFile(hotspotStatePath))
        generatedSsid = data{"ssid"}.getStr("")
        generatedPassword = data{"password"}.getStr("")
    except CatchableError:
      discard
    if generatedSsid.len == 0 or generatedPassword.len < 8:
      generatedSsid = DefaultHotspotSsid & "-" & randomFrom(SsidAlphabet, SsidSuffixLength)
      generatedPassword = randomFrom(PasswordAlphabet, PasswordLength)
      # A write that fails still gives this run one stable pair.
      try:
        ensureParentDir(hotspotStatePath)
        writeTextFile(hotspotStatePath, $(%*{"ssid": generatedSsid, "password": generatedPassword}) & "\n")
        setFilePermissions(hotspotStatePath, {fpUserRead, fpUserWrite})
      except CatchableError:
        discard
  (generatedSsid, generatedPassword)

proc resolveHotspotCredentials*(device, ssid, password: string): tuple[ssid, password: string] =
  ## The hotspot this frame brings up, from frame.json's `device`,
  ## `network.wifiHotspotSsid` and `network.wifiHotspotPassword`.
  let ssidSet = isSet(ssid, DefaultHotspotSsid)
  let passwordSet = isSet(password, DefaultHotspotPassword)
  result.ssid = if ssidSet: ssid.strip() else: DefaultHotspotSsid
  result.password = if passwordSet: password else: DefaultHotspotPassword
  if (ssidSet and passwordSet) or not localAccessPanelDevice(device):
    return
  withLock credentialsLock:
    let generated = generatedCredentialsLocked()
    if not ssidSet: result.ssid = generated.ssid
    if not passwordSet: result.password = generated.password

when defined(testing):
  proc useHotspotStatePathForTest*(path: string) =
    withLock credentialsLock:
      hotspotStatePath = path
      generatedSsid = ""
      generatedPassword = ""
      generatedLoaded = false
