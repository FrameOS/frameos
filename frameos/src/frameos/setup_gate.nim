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
## So the hotspot mints a six-digit code when it comes up, and the runner
## draws it on the panel the way it draws the local network access code:
## after the render is stored, so it never leaves the frame as an image
## (runner.nim, drawLocalAccessCode). The form asks for it before any of the
## gated fields are applied (portal.nim, `setupGateProblem`). A frame that
## has no panel to show the code on accepts its admin password instead, and
## a headless frame that is already managed and has no admin password
## refuses the gated fields outright: there is nothing on it a stranger
## should be able to change from the hotspot, and the owner changes those
## settings from the control plane that manages it. A fresh frame — no
## panel, no admin password, no control plane — is open, as it was: there is
## nothing on it yet to protect, and it cannot be set up otherwise.
##
## Same rules as the local network access ceremony (local_access.nim):
## digits from /dev/urandom, constant-time compare, single use. Ten wrong
## codes or passwords shut the gate until the hotspot next comes up.
## Process-local, never persisted.

import std/[json, locks, strutils]

import frameos/local_access
import frameos/types

const
  SetupCodeLength* = 6
  SetupGateMaxWrong* = 10
    ## Wrong codes or passwords per hotspot session. Ten guesses at six
    ## digits is a one in 100,000 chance; a fresh code after every few wrong
    ## ones would have made a brute force a matter of time instead.
  SetupCodePanelLabel* = "Setup code"
  SetupCodeStripFraction* = 0.12
    ## The bottom of the panel the runner draws the setup code into. The
    ## hotspot scene leaves it free: its split's last row
    ## (system/wifiHotspot, height_ratios "45 43 12").

type
  SetupGateMode* = enum
    sgOpen = "open"                   ## fresh frame: no panel, no admin password, no control plane
    sgPanelCode = "panelCode"         ## the code on the panel (the admin password also works)
    sgAdminPassword = "adminPassword" ## headless: the frame's admin password
    sgLocked = "locked"               ## headless and managed, no admin password: refused

var
  gateLock: Lock
  activeCode: string          ## "" while no hotspot is up
  wrongCount: int

initLock(gateLock)

proc adminPasswordOf(frameConfig: FrameConfig): string =
  if frameConfig == nil or frameConfig.frameAdminAuth == nil or frameConfig.frameAdminAuth.kind != JObject:
    return ""
  frameConfig.frameAdminAuth{"pass"}.getStr("")

proc setupGateMode*(frameConfig: FrameConfig, controlPlaneConfigured: bool): SetupGateMode =
  ## Which proof the gated fields need on this frame. `controlPlaneConfigured`
  ## is the caller's (portal.nim knows about queued claims and link codes).
  if frameConfig != nil and localAccessPanelDevice(frameConfig.device):
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
      wrongCount = 0
      result = activeCode

proc clearSetupCode*() {.gcsafe.} =
  ## The hotspot went down: nothing to type any more.
  {.cast(gcsafe).}:
    withLock gateLock:
      activeCode = ""
      wrongCount = 0

proc activeSetupCode*(): string {.gcsafe.} =
  {.cast(gcsafe).}:
    withLock gateLock:
      result = activeCode

proc setupCodePanelText*(): string {.gcsafe.} =
  ## What the runner draws along the bottom of the panel, "" for nothing.
  ## The runner repaints whenever this changes: the hotspot came up, the
  ## code was spent, the hotspot went down.
  let code = activeSetupCode()
  if code.len == 0: "" else: SetupCodePanelLabel & " " & code

proc setupGateLocked*(): bool {.gcsafe.} =
  {.cast(gcsafe).}:
    withLock gateLock:
      result = wrongCount >= SetupGateMaxWrong

proc setupSecretProblem*(candidate: string, mode: SetupGateMode, adminPassword: string): string {.gcsafe.} =
  ## "" when what the form typed opens the gate, otherwise what to tell the
  ## person. Both secrets are checked in panel mode: a panel whose code
  ## cannot be read (an unplugged HDMI monitor) still has the admin
  ## password, and the password is a LAN-reachable secret already.
  let typed = candidate.strip()
  {.cast(gcsafe).}:
    withLock gateLock:
      case mode
      of sgOpen:
        return ""
      of sgLocked:
        return "This frame has no display to show a setup code and no admin password. " &
          "Only the Wi-Fi settings can be changed here; manage the rest from its control plane."
      of sgPanelCode, sgAdminPassword:
        discard
      if wrongCount >= SetupGateMaxWrong:
        return "Too many wrong attempts. Restart the frame to try again."
      if typed.len == 0:
        if mode == sgPanelCode:
          return "Enter the setup code shown on the frame's display."
        return "Enter the frame's admin password."
      if mode == sgPanelCode and activeCode.len > 0 and constantTimeEquals(typed, activeCode):
        # Single use: the submission that carried the code is the one it
        # authorizes. The hotspot's PSK is public knowledge, so a neighbour
        # who captured the handshake can read the form off the air; what
        # they read is spent by then. The runner repaints the new one.
        activeCode = randomDigits(SetupCodeLength)
        return ""
      if adminPassword.len > 0 and constantTimeEquals(typed, adminPassword):
        return ""
      inc wrongCount
      if wrongCount >= SetupGateMaxWrong:
        return "Too many wrong attempts. Restart the frame to try again."
      result =
        if mode == sgPanelCode: "That code does not match the one on the frame's display."
        else: "That is not the frame's admin password."
