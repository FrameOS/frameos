import unittest
import json
import std/os

import ../../types
import ../state
import ../auth

proc configureAdmin(enabled: bool, user: string, pass: string) =
  globalFrameConfig = FrameConfig(
    frameAdminAuth: %*{
      "enabled": enabled,
      "user": user,
      "pass": pass,
    },
    frameAccess: "public",
    frameAccessKey: "",
  )

suite "Server auth helpers":
  test "admin auth enabled requires full config":
    configureAdmin(true, "admin", "secret")
    check adminAuthEnabled()

    configureAdmin(false, "admin", "secret")
    check not adminAuthEnabled()

    configureAdmin(true, "", "secret")
    check not adminAuthEnabled()

  test "admin credentials validate":
    configureAdmin(true, "admin", "secret")
    check validateAdminCredentials("admin", "secret")
    check not validateAdminCredentials("admin", "nope")

  test "admin cookie hash is deterministic":
    configureAdmin(true, "admin", "secret")
    globalAdminSessionSalt = "salt-one"
    let first = adminSessionCookieValue()
    let second = adminSessionCookieValue()
    check first == second

    globalAdminSessionSalt = "salt-two"
    check first != adminSessionCookieValue()

  test "session salt can be persisted to disk":
    let tempDir = getTempDir() / "frameos-auth-tests"
    createDir(tempDir)
    let configPath = tempDir / "config.json"
    let secretPath = configPath & ".admin_session_salt"
    if fileExists(secretPath):
      removeFile(secretPath)

    let generated = getOrCreateAdminSessionSalt(configPath)
    check generated.len > 0
    check fileExists(secretPath)

    let reused = getOrCreateAdminSessionSalt(configPath)
    check reused == generated

    removeFile(secretPath)
