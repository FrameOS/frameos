## The setup hotspot's network name and password.
##
## A name or password set in frame.json is used as it is. Left blank (the
## default for new frames), a frame with a screen makes one up the first time
## it needs it, the way the ESP32 names and locks its setup network
## (embedded/esp32/main/fos_wifi.c): `FrameOS-XXXX` from the last two bytes of
## the Wi-Fi MAC, and ten characters from the same alphabet. It keeps them in
## state/ (a backend deploy rewrites frame.json, never state/), and the
## hotspot scene shows them, with a QR code, on the screen. A frame without a
## screen gets the name too, but has nowhere to show a made-up password and
## uses frame1234.
##
## readConfig folds the result into every config it parses, so the portal, the
## hotspot scene and the setup page all use the real pair. Read from the
## runner and the HTTP workers alike: plain values under one lock.

import std/[algorithm, json, locks, os, strutils, sysrand]

import frameos/hal/files
import frameos/local_access

const
  DefaultHotspotPassword* = "frame1234"
  # As the ESP32's AP_PSK_ALPHABET / AP_PSK_LENGTH: no 0/O, 1/l/I, since the
  # password is read off an e-ink screen and typed.
  PasswordAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  PasswordLength = 10

var
  credentialsLock: Lock
  generatedSsid: string
  generatedPassword: string
  generatedLoaded = false
  hotspotStatePath = "./state/hotspot.json"
  netClassRoot = "/sys/class/net"

initLock(credentialsLock)

proc randomFrom(alphabet: string, count: int): string =
  ## Rejection-sampled so every character is equally likely.
  let limit = 256 - (256 mod alphabet.len)
  result = newStringOfCap(count)
  while result.len < count:
    for value in urandom(count * 2):
      if value.int < limit and result.len < count:
        result.add(alphabet[value.int mod alphabet.len])

proc wifiMacSuffix(): string =
  ## "AB12" from the first Wi-Fi interface's MAC (…:ab:12), as the ESP32 uses
  ## its own; "" when there is no Wi-Fi interface to read.
  try:
    var interfaces: seq[string]
    for _, path in walkDir(netClassRoot):
      if dirExists(path / "wireless") or dirExists(path / "phy80211"):
        interfaces.add(path)
    interfaces.sort()
    for path in interfaces:
      let bytes = readFile(path / "address").strip().split(':')
      if bytes.len == 6 and (bytes[4] & bytes[5]).len == 4 and allCharsInSet(bytes[4] & bytes[5], HexDigits):
        return (bytes[4] & bytes[5]).toUpperAscii()
  except CatchableError:
    discard
  ""

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
      let suffix = wifiMacSuffix()
      generatedSsid = "FrameOS-" & (if suffix.len > 0: suffix else: randomFrom("0123456789ABCDEF", 4))
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
  withLock credentialsLock:
    let generated = generatedCredentialsLocked()
    if result.ssid.len == 0:
      result.ssid = generated.ssid
    if result.password.len == 0:
      result.password = if localAccessPanelDevice(device): generated.password else: DefaultHotspotPassword

when defined(testing):
  proc useHotspotStatePathForTest*(path: string, netClass = "/nonexistent") =
    withLock credentialsLock:
      hotspotStatePath = path
      netClassRoot = netClass
      generatedSsid = ""
      generatedPassword = ""
      generatedLoaded = false
