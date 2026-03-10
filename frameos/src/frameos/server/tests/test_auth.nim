import unittest
import json
import std/os
import mummy

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

proc makeRequest(
    httpMethod = "GET",
    query: seq[(string, string)] = @[],
    headers: seq[(string, string)] = @[]
  ): Request =
  let request = create(RequestObj)
  request.httpMethod = httpMethod
  request.queryParams = emptyQueryParams()
  for (key, value) in query:
    request.queryParams[key] = value
  for (key, value) in headers:
    request.headers[key] = value
  result = request

suite "Server auth helpers":
  test "admin auth enabled requires full config":
    configureAdmin(true, "admin", "secret")
    check adminPanelEnabled()
    check adminAuthEnabled()

    configureAdmin(false, "admin", "secret")
    check not adminPanelEnabled()
    check not adminAuthEnabled()

    configureAdmin(true, "", "secret")
    check not adminPanelEnabled()
    check not adminAuthEnabled()

  test "legacy auth toggle no longer bypasses admin credentials":
    globalFrameConfig = FrameConfig(
      frameAccess: "private",
      frameAccessKey: "test-key",
      frameAdminAuth: %*{
        "enabled": true,
        "authEnabled": false,
      },
    )

    let request = makeRequest()
    check not adminAuthEnabled()
    check not adminPanelEnabled()
    check not hasAdminSession(request)
    check not hasAuthenticatedAdminSession(request)
    check not hasAccess(request, Read)
    check not hasAccess(request, Write)
    check not hasAdminAccess(request)

  test "admin credentials validate":
    configureAdmin(true, "admin", "secret")
    check validateAdminCredentials("admin", "secret")
    check not validateAdminCredentials("admin", "nope")

  test "admin cookie hash is deterministic":
    configureAdmin(true, "admin", "secret")
    setGlobalAdminSessionSalt("salt-one")
    let first = adminSessionCookieValue()
    let second = adminSessionCookieValue()
    check first == second

    setGlobalAdminSessionSalt("salt-two")
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

  test "getCookieValue parses existing cookies":
    let request = makeRequest(headers = @[("cookie", "a=1;frame_access_key=abc;z=9")])
    check getCookieValue(request, "frame_access_key") == "abc"
    check getCookieValue(request, "missing") == ""

    let noCookieHeader = makeRequest()
    check getCookieValue(noCookieHeader, "frame_access_key") == ""

  test "hasAccess accepts query cookie and bearer paths":
    globalFrameConfig = FrameConfig(
      frameAccess: "private",
      frameAccessKey: "test-key",
      frameAdminAuth: %*{},
    )

    let none = makeRequest()
    check not hasAccess(none, Read)
    check not hasAccess(none, Write)

    let queryReq = makeRequest(query = @[("k", "test-key")])
    check hasAccess(queryReq, Read)
    check hasAccess(queryReq, Write)

    let cookieReq = makeRequest(headers = @[("cookie", ACCESS_COOKIE & "=test-key")])
    check hasAccess(cookieReq, Read)
    check hasAccess(cookieReq, Write)

    let bearerReq = makeRequest(
      httpMethod = "POST",
      headers = @[(AUTH_HEADER, AUTH_TYPE & " test-key")]
    )
    check hasAccess(bearerReq, Write)

  test "authenticated admin session stays separate from frame access":
    setGlobalAdminSessionSalt("salt")
    globalFrameConfig = FrameConfig(
      frameAccess: "private",
      frameAccessKey: "test-key",
      frameAdminAuth: %*{
        "enabled": true,
        "user": "admin",
        "pass": "secret",
      },
    )

    let adminReq = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & adminSessionCookieValue())])
    check hasAuthenticatedAdminSession(adminReq)
    check not hasAccess(adminReq, Read)
    check not hasAccess(adminReq, Write)
    check canAccessFrameSecrets(adminReq)

    globalFrameConfig.frameAdminAuth = %*{}
    check not hasAuthenticatedAdminSession(adminReq)
    check not hasAccess(adminReq, Read)
    check not hasAccess(adminReq, Write)

  test "frame secrets require authenticated admin session instead of generic write access":
    setGlobalAdminSessionSalt("salt")
    globalFrameConfig = FrameConfig(
      frameAccess: "public",
      frameAccessKey: "test-key",
      frameAdminAuth: %*{
        "enabled": true,
        "user": "admin",
        "pass": "secret",
      },
    )

    let publicReq = makeRequest()
    check hasAccess(publicReq, Read)
    check hasAccess(publicReq, Write)
    check not canAccessFrameSecrets(publicReq)

    let adminReq = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & adminSessionCookieValue())])
    check hasAuthenticatedAdminSession(adminReq)
    check canAccessFrameSecrets(adminReq)

  test "hasAccess respects public and protected modes":
    globalFrameConfig = FrameConfig(
      frameAccess: "public",
      frameAccessKey: "",
      frameAdminAuth: %*{},
    )
    check hasAccess(makeRequest(), Read)
    check hasAccess(makeRequest(), Write)

    globalFrameConfig = FrameConfig(
      frameAccess: "protected",
      frameAccessKey: "key",
      frameAdminAuth: %*{},
    )
    check hasAccess(makeRequest(), Read)
    check not hasAccess(makeRequest(), Write)

  test "static asset auth policy follows admin enablement and frame access mode":
    globalFrameConfig = FrameConfig(
      frameAccess: "private",
      frameAccessKey: "key",
      frameAdminAuth: %*{},
    )
    check not allowUnauthenticatedStaticAssets()

    globalFrameConfig.frameAccess = "protected"
    check allowUnauthenticatedStaticAssets()

    globalFrameConfig.frameAccess = "public"
    check allowUnauthenticatedStaticAssets()

    globalFrameConfig.frameAccess = "private"
    globalFrameConfig.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    check allowUnauthenticatedStaticAssets()

  test "hasAdminSession validates cookie only when admin auth enabled":
    configureAdmin(false, "admin", "secret")
    setGlobalAdminSessionSalt("salt")
    check not hasAdminSession(makeRequest())

    configureAdmin(true, "admin", "secret")
    setGlobalAdminSessionSalt("salt")
    let token = adminSessionCookieValue()
    let valid = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & token)])
    let invalid = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=bad-token")])
    check hasAdminSession(valid)
    check not hasAdminSession(invalid)
