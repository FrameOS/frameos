## The setup hotspot's local-presence gate.
##
## While the `FrameOS-Setup` hotspot is up, `POST /setup` is reachable by
## anyone in radio range who knows the well-known default PSK, and the form
## can re-enroll the frame, point it at another server, turn the admin UI on
## with a password of the visitor's choosing, or make every rendered image
## POST to a URL of theirs (`httpUploadUrl`). The Wi-Fi fields have to stay
## open — joining a network is what the hotspot is for — but the rest is
## owner business, and the proof of ownership is the same as everywhere else
## on the device: being able to read the panel.
##
## So the hotspot mints a six-digit code when it comes up and draws it on the
## hotspot scene; the form asks for it before any of the gated fields are
## applied (portal.nim, `setupGateProblem`). A frame that has no panel to
## show the code on accepts its admin password instead, and a headless frame
## that is already managed and has no admin password refuses the gated
## fields outright: there is nothing on it a stranger should be able to
## change from the hotspot, and the owner changes those settings from the
## control plane that manages it. A fresh frame — no panel, no admin
## password, no control plane — is open, as it was: there is nothing on it
## yet to protect, and it cannot be set up otherwise.
##
## Same rules as the private-network ceremony (local_access.nim): digits
## from /dev/urandom, constant-time compare, five attempts. The code lives as
## long as the hotspot does; five wrong codes mint a fresh one (the scene is
## told to redraw), five wrong passwords lock the gate until the hotspot is
## next brought up. Process-local, never persisted.

import std/[json, locks, strutils]

import frameos/local_access
import frameos/types

const
  SetupCodeLength* = 6
  SetupGateMaxAttempts* = 5

type
  SetupGateMode* = enum
    sgOpen = "open"                   ## fresh frame: no panel, no admin password, no control plane
    sgPanelCode = "panelCode"         ## the code on the hotspot scene (the admin password also works)
    sgAdminPassword = "adminPassword" ## headless: the frame's admin password
    sgLocked = "locked"               ## headless and managed, no admin password: refused

var
  gateLock: Lock
  activeCode: string          ## "" while no hotspot is up
  attemptsLeft: int
  passwordLocked: bool

initLock(gateLock)

proc deviceHasPanel*(device: string): bool =
  ## Whether this frame draws somewhere a person in front of it can read.
  ## The same list as the cursor's (runner.nim cursorCanShow): an upload
  ## target, the browser-only device and the wasm preview have no panel.
  let d = device.strip()
  d.len > 0 and d notin ["web_only", "http.upload", "wasm"]

proc adminPasswordOf(frameConfig: FrameConfig): string =
  if frameConfig == nil or frameConfig.frameAdminAuth == nil or frameConfig.frameAdminAuth.kind != JObject:
    return ""
  frameConfig.frameAdminAuth{"pass"}.getStr("")

proc setupGateMode*(frameConfig: FrameConfig, controlPlaneConfigured: bool): SetupGateMode =
  ## Which proof the gated fields need on this frame. `controlPlaneConfigured`
  ## is the caller's (portal.nim knows about queued claims and link codes).
  if frameConfig != nil and deviceHasPanel(frameConfig.device):
    return sgPanelCode
  if adminPasswordOf(frameConfig).len > 0:
    return sgAdminPassword
  if controlPlaneConfigured:
    return sgLocked
  sgOpen

proc startSetupCode*(): string {.gcsafe.} =
  ## Mint the code for this hotspot session (the hotspot just came up).
  let code = randomDigits(SetupCodeLength)
  {.cast(gcsafe).}:
    withLock gateLock:
      activeCode = code
      attemptsLeft = SetupGateMaxAttempts
      passwordLocked = false
      result = activeCode

proc clearSetupCode*() {.gcsafe.} =
  ## The hotspot went down: nothing to type any more.
  {.cast(gcsafe).}:
    withLock gateLock:
      activeCode = ""
      attemptsLeft = 0
      passwordLocked = false

proc activeSetupCode*(): string {.gcsafe.} =
  ## What the hotspot scene draws, "" for nothing.
  {.cast(gcsafe).}:
    withLock gateLock:
      result = activeCode

proc setupGateAttemptsLeft*(): int {.gcsafe.} =
  {.cast(gcsafe).}:
    withLock gateLock:
      result = attemptsLeft

proc setupGateLocked*(): bool {.gcsafe.} =
  {.cast(gcsafe).}:
    withLock gateLock:
      result = passwordLocked

proc checkSetupSecret*(candidate: string, mode: SetupGateMode, adminPassword: string):
    tuple[ok: bool, detail: string, remint: bool] {.gcsafe.} =
  ## Verify what the form typed against the panel code and/or the admin
  ## password. `remint` is true when the attempts ran out in panel mode and a
  ## fresh code was minted: the caller redraws the scene.
  ##
  ## Both secrets are checked in both modes that have them: a panel whose
  ## code cannot be read (an unplugged HDMI monitor) still has the admin
  ## password, and the password is a LAN-reachable secret already.
  let typed = candidate.strip()
  {.cast(gcsafe).}:
    withLock gateLock:
      if mode == sgOpen:
        return (true, "", false)
      if mode == sgLocked:
        return (false, "This frame has no display to show a setup code and no admin password. " &
          "Only the Wi-Fi settings can be changed here; manage the rest from its control plane.", false)
      if passwordLocked:
        return (false, "Too many wrong attempts. Restart the frame to try again.", false)
      if typed.len == 0:
        return (false, (if mode == sgPanelCode: "Enter the setup code shown on the frame's display."
                        else: "Enter the frame's admin password."), false)
      if mode == sgPanelCode and activeCode.len > 0 and constantTimeEquals(typed, activeCode):
        # Single use, like the private-network ceremony: the submission that
        # carried the code is the one it authorizes. The hotspot's PSK is
        # public knowledge, so a neighbour who captured the handshake can
        # read the form off the air; what they read is spent by then.
        activeCode = randomDigits(SetupCodeLength)
        attemptsLeft = SetupGateMaxAttempts
        return (true, "", true)
      if adminPassword.len > 0 and constantTimeEquals(typed, adminPassword):
        return (true, "", false)
      dec attemptsLeft
      if attemptsLeft <= 0:
        if mode == sgPanelCode:
          activeCode = randomDigits(SetupCodeLength)
          attemptsLeft = SetupGateMaxAttempts
          return (false, "Too many wrong codes. A new code is on the frame's display.", true)
        passwordLocked = true
        return (false, "Too many wrong attempts. Restart the frame to try again.", false)
      result = (false, (if mode == sgPanelCode: "That code does not match the one on the frame's display."
                        else: "That is not the frame's admin password."), false)

proc setupCodeLine*(): string =
  ## The hotspot scene's third step, "" while no code is up (the scene's
  ## text is one `fmt` expression, so this is the hook it calls).
  let code = activeSetupCode()
  if code.len == 0:
    return ""
  "\n3. When asked, enter the setup code ^(underline)" & code & "^(no-underline)."
