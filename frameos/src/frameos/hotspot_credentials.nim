## The setup hotspot's network name and password.
##
## A name or password set in frame.json is used as it is. Left blank (the
## default for new frames), a frame with a screen makes one up the first time
## it needs it, keeps it in state/ (a backend deploy rewrites frame.json, never
## state/), and the hotspot scene shows it, with a QR code, on the screen. A
## frame without a screen has nowhere to show a made-up one and uses
## FrameOS-Setup / frame1234.
##
## readConfig folds the result into every config it parses, so the portal, the
## hotspot scene and the setup page all use the real pair. Read from the
## runner and the HTTP workers alike: plain values under one lock.

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
  result = (ssid.strip(), password)
  if result.ssid.len > 0 and result.password.len > 0:
    return
  if not localAccessPanelDevice(device):
    if result.ssid.len == 0: result.ssid = DefaultHotspotSsid
    if result.password.len == 0: result.password = DefaultHotspotPassword
    return
  withLock credentialsLock:
    let generated = generatedCredentialsLocked()
    if result.ssid.len == 0: result.ssid = generated.ssid
    if result.password.len == 0: result.password = generated.password

when defined(testing):
  proc useHotspotStatePathForTest*(path: string) =
    withLock credentialsLock:
      hotspotStatePath = path
      generatedSsid = ""
      generatedPassword = ""
      generatedLoaded = false
