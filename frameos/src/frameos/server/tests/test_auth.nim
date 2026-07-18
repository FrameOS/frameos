import unittest
import json
import std/os
import mummy

import ../../types
import ../state
import ../auth
import ../routes/cloud_api_routes

let missingConfigPath = getTempDir() / ("frameos-auth-tests-missing-frame-" & $getCurrentProcessId() & ".json")

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
  setup:
    clearAdminSessions()
    if fileExists(missingConfigPath):
      removeFile(missingConfigPath)
    putEnv("FRAMEOS_CONFIG", missingConfigPath)

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

  test "cloud callback origin follows the external proxy scheme and host":
    check localOrigin(makeRequest(headers = @[("host", "frame.local:8787")])) ==
      "http://frame.local:8787"
    check localOrigin(makeRequest(headers = @[
      ("host", "frame.example:8443"),
      ("x-forwarded-proto", "https"),
    ])) == "https://frame.example:8443"
    check localOrigin(makeRequest(headers = @[
      ("host", "frame.example"),
      ("x-forwarded-proto", "https, http"),
    ])) == "https://frame.example"

  test "legacy provider field does not affect admin auth":
    globalFrameConfig = FrameConfig(
      frameAdminAuth: %*{
        "enabled": true,
        "provider": "oauth",
        "user": "admin",
        "pass": "secret",
      },
      frameAccess: "public",
      frameAccessKey: "",
    )

    check adminPanelEnabled()
    check adminAuthEnabled()

  test "persisted admin auth is used if live runtime auth is missing":
    let tempDir = getTempDir() / "frameos-auth-persisted-config"
    createDir(tempDir)
    let configPath = tempDir / "frame.json"
    writeFile(configPath, $(%*{
      "frameAdminAuth": {
        "enabled": true,
        "user": "admin",
        "pass": "secret",
      },
    }))
    putEnv("FRAMEOS_CONFIG", configPath)

    globalFrameConfig = FrameConfig(
      frameAdminAuth: %*{},
      frameAccess: "public",
      frameAccessKey: "",
    )

    check adminPanelEnabled()
    check adminAuthEnabled()
    check validateAdminCredentials("admin", "secret")

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

  test "admin sessions use unique signed tokens":
    configureAdmin(true, "admin", "secret")
    setGlobalAdminSessionSalt("salt-one")
    let first = createAdminSession()
    let second = createAdminSession()
    check first.len > 0
    check second.len > 0
    check first != second
    check hasAdminSession(makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & first)]))
    check hasAdminSession(makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & second)]))

  test "admin sessions expire from signed expiry":
    configureAdmin(true, "admin", "secret")
    let expired = createAdminSession(ttlSeconds = -1)
    check not hasAdminSession(makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & expired)]))

  test "admin sessions reject tampered tokens":
    configureAdmin(true, "admin", "secret")
    setGlobalAdminSessionSalt("salt-one")
    let token = createAdminSession()
    check hasAdminSession(makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & token)]))

    let tampered = token[0 ..< token.high] & (if token[token.high] == '0': "1" else: "0")
    check not hasAdminSession(makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & tampered)]))

  test "admin sessions survive process restart session clear":
    configureAdmin(true, "admin", "secret")
    setGlobalAdminSessionSalt("salt-one")
    let token = createAdminSession()
    let request = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & token)])
    check hasAdminSession(request)

    clearAdminSessions()
    check hasAdminSession(request)

  test "admin sessions are invalidated when credentials change":
    configureAdmin(true, "admin", "secret")
    let token = createAdminSession()
    let request = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & token)])
    check hasAdminSession(request)

    globalFrameConfig.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "new-secret",
    }
    check not hasAdminSession(request)

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

  test "installed release session salt is shared across release config paths":
    let tempDir = getTempDir() / "frameos-auth-shared-salt"
    if dirExists(tempDir):
      removeDir(tempDir)
    createDir(tempDir / "releases" / "release_old")
    createDir(tempDir / "releases" / "release_new")
    let oldConfigPath = tempDir / "releases" / "release_old" / "frame.json"
    let newConfigPath = tempDir / "releases" / "release_new" / "frame.json"
    writeFile(oldConfigPath, "{}")
    writeFile(newConfigPath, "{}")

    let hadFrameosDir = existsEnv("FRAMEOS_DIR")
    let oldFrameosDir = if hadFrameosDir: getEnv("FRAMEOS_DIR") else: ""
    let hadSalt = existsEnv("FRAMEOS_ADMIN_SESSION_SALT")
    let oldSalt = if hadSalt: getEnv("FRAMEOS_ADMIN_SESSION_SALT") else: ""
    let hadSaltFile = existsEnv("FRAMEOS_ADMIN_SESSION_SALT_FILE")
    let oldSaltFile = if hadSaltFile: getEnv("FRAMEOS_ADMIN_SESSION_SALT_FILE") else: ""
    try:
      putEnv("FRAMEOS_DIR", tempDir)
      delEnv("FRAMEOS_ADMIN_SESSION_SALT")
      delEnv("FRAMEOS_ADMIN_SESSION_SALT_FILE")
      let first = getOrCreateAdminSessionSalt(oldConfigPath)
      let second = getOrCreateAdminSessionSalt(newConfigPath)
      check first.len > 0
      check second == first
      check fileExists(tempDir / "state" / "admin_session_salt")
      check not fileExists(newConfigPath & ".admin_session_salt")
    finally:
      if hadFrameosDir:
        putEnv("FRAMEOS_DIR", oldFrameosDir)
      else:
        delEnv("FRAMEOS_DIR")
      if hadSalt:
        putEnv("FRAMEOS_ADMIN_SESSION_SALT", oldSalt)
      else:
        delEnv("FRAMEOS_ADMIN_SESSION_SALT")
      if hadSaltFile:
        putEnv("FRAMEOS_ADMIN_SESSION_SALT_FILE", oldSaltFile)
      else:
        delEnv("FRAMEOS_ADMIN_SESSION_SALT_FILE")
      if dirExists(tempDir):
        removeDir(tempDir)

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

    let adminReq = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & createAdminSession())])
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

    let adminReq = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & createAdminSession())])
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
    let token = createAdminSession()
    let valid = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=" & token)])
    let invalid = makeRequest(headers = @[("cookie", ADMIN_SESSION_COOKIE & "=bad-token")])
    check hasAdminSession(valid)
    check not hasAdminSession(invalid)
