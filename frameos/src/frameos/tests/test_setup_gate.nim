## The setup hotspot's local-presence gate (setup_gate.nim).

import std/[json, sequtils, strutils, unittest]

import frameos/setup_gate
import frameos/types

proc config(device = "", adminPass = ""): FrameConfig =
  result = FrameConfig(device: device)
  if adminPass.len > 0:
    result.frameAdminAuth = %*{"enabled": true, "user": "admin", "pass": adminPass}

suite "setup gate":
  setup:
    clearSetupCode()

  teardown:
    clearSetupCode()

  test "a frame with a panel asks for the code; a headless one for the admin password; a managed headless one is locked; a fresh one is open":
    check setupGateMode(config(device = "pimoroni.inky_impression_13"), controlPlaneConfigured = false) == sgPanelCode
    check setupGateMode(config(device = "framebuffer"), controlPlaneConfigured = true) == sgPanelCode
    check setupGateMode(config(device = "web_only", adminPass = "pw"), controlPlaneConfigured = false) == sgAdminPassword
    check setupGateMode(config(device = "http.upload", adminPass = "pw"), controlPlaneConfigured = true) == sgAdminPassword
    check setupGateMode(config(device = "web_only"), controlPlaneConfigured = true) == sgLocked
    check setupGateMode(config(device = ""), controlPlaneConfigured = true) == sgLocked
    check setupGateMode(config(device = "web_only"), controlPlaneConfigured = false) == sgOpen
    check setupGateMode(nil, controlPlaneConfigured = false) == sgOpen
    check deviceHasPanel("waveshare.EPD_7in3e")
    check not deviceHasPanel("wasm")

  test "no code until the hotspot is up, digits while it is, none after":
    check activeSetupCode() == ""
    check setupCodeLine() == ""
    let code = startSetupCode()
    check code.len == SetupCodeLength
    check code.allCharsInSet({'0'..'9'})
    check activeSetupCode() == code
    check setupCodeLine().contains(code)
    check setupGateAttemptsLeft() == SetupGateMaxAttempts
    clearSetupCode()
    check activeSetupCode() == ""
    check setupCodeLine() == ""

  test "successive hotspot sessions do not repeat the code":
    var seen: seq[string] = @[]
    for _ in 0 ..< 8:
      seen.add(startSetupCode())
    check seen.deduplicate().len > 1

  test "the right code passes once and is replaced; a wrong one costs an attempt":
    let code = startSetupCode()
    let wrong = checkSetupSecret("000000", sgPanelCode, adminPassword = "")
    check not wrong.ok
    check wrong.detail.contains("does not match")
    check not wrong.remint
    check setupGateAttemptsLeft() == SetupGateMaxAttempts - 1
    let right = checkSetupSecret(" " & code & " ", sgPanelCode, adminPassword = "")
    check right.ok
    check right.remint
    check activeSetupCode() != code
    check activeSetupCode().len == SetupCodeLength
    check setupGateAttemptsLeft() == SetupGateMaxAttempts
    # Single use: the code that was just accepted is gone.
    check not checkSetupSecret(code, sgPanelCode, adminPassword = "").ok

  test "five wrong codes mint a fresh one and say so":
    let code = startSetupCode()
    var last: tuple[ok: bool, detail: string, remint: bool]
    for _ in 0 ..< SetupGateMaxAttempts:
      last = checkSetupSecret("999999", sgPanelCode, adminPassword = "")
    check not last.ok
    check last.remint
    check last.detail.contains("new code")
    check activeSetupCode() != code
    check setupGateAttemptsLeft() == SetupGateMaxAttempts
    # The old code is worthless now, the new one works.
    check not checkSetupSecret(code, sgPanelCode, adminPassword = "").ok
    check checkSetupSecret(activeSetupCode(), sgPanelCode, adminPassword = "").ok

  test "the admin password opens the gate on a headless frame and on a panel whose code cannot be read":
    discard startSetupCode()
    check checkSetupSecret("hunter2", sgAdminPassword, adminPassword = "hunter2").ok
    check not checkSetupSecret("hunter2", sgAdminPassword, adminPassword = "hunter2").remint
    let viaPassword = checkSetupSecret("hunter2", sgPanelCode, adminPassword = "hunter2")
    check viaPassword.ok
    check not viaPassword.remint # the code on the panel stays
    let bad = checkSetupSecret("hunter3", sgAdminPassword, adminPassword = "hunter2")
    check not bad.ok
    check bad.detail.contains("admin password")
    # No password set means the password route is closed, not open.
    check not checkSetupSecret("", sgAdminPassword, adminPassword = "").ok
    check not checkSetupSecret("x", sgAdminPassword, adminPassword = "").ok

  test "five wrong passwords lock the gate until the hotspot is next brought up":
    discard startSetupCode()
    for _ in 0 ..< SetupGateMaxAttempts:
      discard checkSetupSecret("nope", sgAdminPassword, adminPassword = "hunter2")
    check setupGateLocked()
    let locked = checkSetupSecret("hunter2", sgAdminPassword, adminPassword = "hunter2")
    check not locked.ok
    check locked.detail.contains("Too many")
    discard startSetupCode()
    check not setupGateLocked()
    check checkSetupSecret("hunter2", sgAdminPassword, adminPassword = "hunter2").ok

  test "an empty submission is told what to type; open and locked frames need nothing or get nothing":
    discard startSetupCode()
    check checkSetupSecret("", sgPanelCode, adminPassword = "").detail.contains("setup code")
    check checkSetupSecret("", sgAdminPassword, adminPassword = "pw").detail.contains("admin password")
    check setupGateAttemptsLeft() == SetupGateMaxAttempts
    check checkSetupSecret("", sgOpen, adminPassword = "").ok
    let locked = checkSetupSecret(activeSetupCode(), sgLocked, adminPassword = "")
    check not locked.ok
    check locked.detail.contains("no display")
