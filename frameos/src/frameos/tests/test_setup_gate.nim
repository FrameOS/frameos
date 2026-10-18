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
    check setupGateMode(config(device = "wasm", adminPass = "pw"), controlPlaneConfigured = false) == sgAdminPassword
    check setupGateMode(config(device = "web_only"), controlPlaneConfigured = true) == sgLocked
    check setupGateMode(config(device = ""), controlPlaneConfigured = true) == sgLocked
    check setupGateMode(config(device = "web_only"), controlPlaneConfigured = false) == sgOpen
    check setupGateMode(nil, controlPlaneConfigured = false) == sgOpen

  test "no code until the hotspot is up, digits while it is, none after":
    check activeSetupCode() == ""
    check setupCodePanelText() == ""
    let code = startSetupCode()
    check code.len == SetupCodeLength
    check code.allCharsInSet({'0'..'9'})
    check activeSetupCode() == code
    check setupCodePanelText() == SetupCodePanelLabel & " " & code
    clearSetupCode()
    check activeSetupCode() == ""
    check setupCodePanelText() == ""

  test "successive hotspot sessions do not repeat the code":
    var seen: seq[string] = @[]
    for _ in 0 ..< 8:
      seen.add(startSetupCode())
    check seen.deduplicate().len > 1

  test "the right code passes once and is replaced; a wrong one is refused":
    let code = startSetupCode()
    check setupSecretProblem("000000", sgPanelCode, adminPassword = "").contains("does not match")
    check setupSecretProblem(" " & code & " ", sgPanelCode, adminPassword = "") == ""
    check activeSetupCode() != code
    check activeSetupCode().len == SetupCodeLength
    # Single use: the code that was just accepted is gone.
    check setupSecretProblem(code, sgPanelCode, adminPassword = "") != ""
    check setupSecretProblem(activeSetupCode(), sgPanelCode, adminPassword = "") == ""

  test "the admin password opens the gate on a headless frame and on a panel whose code cannot be read":
    let code = startSetupCode()
    check setupSecretProblem("hunter2", sgAdminPassword, adminPassword = "hunter2") == ""
    check setupSecretProblem("hunter2", sgPanelCode, adminPassword = "hunter2") == ""
    check activeSetupCode() == code # the code on the panel stays
    check setupSecretProblem("hunter3", sgAdminPassword, adminPassword = "hunter2").contains("admin password")
    # The code is the panel's proof; a headless frame does not take it.
    check setupSecretProblem(code, sgAdminPassword, adminPassword = "hunter2") != ""
    # No password set means the password route is closed, not open.
    check setupSecretProblem("", sgAdminPassword, adminPassword = "") != ""
    check setupSecretProblem("x", sgAdminPassword, adminPassword = "") != ""

  test "ten wrong answers shut the gate until the hotspot next comes up, the right ones included":
    for mode in [sgPanelCode, sgAdminPassword]:
      let code = startSetupCode()
      for _ in 0 ..< SetupGateMaxWrong - 1:
        check not setupSecretProblem("999999", mode, adminPassword = "hunter2").contains("Too many")
      check not setupGateLocked()
      check setupSecretProblem("999999", mode, adminPassword = "hunter2").contains("Too many")
      check setupGateLocked()
      check setupSecretProblem("hunter2", mode, adminPassword = "hunter2").contains("Too many")
      check setupSecretProblem(code, mode, adminPassword = "hunter2").contains("Too many")
      discard startSetupCode()
      check not setupGateLocked()
      check setupSecretProblem("hunter2", mode, adminPassword = "hunter2") == ""

  test "an empty submission is told what to type and costs nothing; open and locked frames need nothing or get nothing":
    discard startSetupCode()
    for _ in 0 ..< SetupGateMaxWrong:
      check setupSecretProblem("", sgPanelCode, adminPassword = "").contains("setup code")
    check setupSecretProblem("", sgAdminPassword, adminPassword = "pw").contains("admin password")
    check not setupGateLocked()
    check setupSecretProblem("", sgOpen, adminPassword = "") == ""
    check setupSecretProblem(activeSetupCode(), sgLocked, adminPassword = "").contains("no display")
