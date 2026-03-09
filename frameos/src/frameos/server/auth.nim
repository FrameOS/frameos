import json
import std/[os, hashes, random, strutils, tables]
import times
import mummy
import frameos/types
import ./state

const AUTH_HEADER* = "authorization"
const AUTH_TYPE* = "Bearer"
const ACCESS_COOKIE* = "frame_access_key"
const ADMIN_SESSION_COOKIE* = "frame_admin_session"
const ADMIN_SESSION_TTL_SECONDS* = 60 * 60 * 24

type
  AccessType* = enum
    Read
    Write

proc getCookieValue*(request: Request, name: string): string =
  if not request.headers.contains("cookie"):
    return ""
  let cookieHeader = request.headers["cookie"]
  for cookie in cookieHeader.split(";"):
    let parts = cookie.strip().split("=", 1)
    if parts.len == 2 and parts[0] == name:
      return parts[1]
  return ""

template adminAuthUser(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"user"}.getStr("")

template adminAuthPass(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"pass"}.getStr("")

template adminAuthPermissions(): JsonNode =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"permissions"}

template adminAuthProvider(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"provider"}.getStr("local")

template frameAccessMode(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAccess

template frameAccessKeyValue*(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAccessKey

template adminAuthPermissionEnabled*(permission: string, defaultValue = true): bool =
  let permissions = adminAuthPermissions()
  if permissions != nil and permissions.kind == JObject and permissions.hasKey(permission):
    return permissions{permission}.getBool(defaultValue)
  defaultValue

proc hasWriteAccessPermission*(): bool {.gcsafe.} =
  adminAuthPermissionEnabled("writeAccess", true)

proc hasAssetsAccessPermission*(): bool {.gcsafe.} =
  adminAuthPermissionEnabled("accessAssets", true)

proc hasModifyScenesPermission*(): bool {.gcsafe.} =
  adminAuthPermissionEnabled("modifyScenes", true)

proc hasControlFramePermission*(): bool {.gcsafe.} =
  adminAuthPermissionEnabled("controlFrame", true)

template adminPanelEnabled*(): bool =
  {.gcsafe.}:
    let enabled = globalFrameConfig.frameAdminAuth{"enabled"}.getBool(false)
    let authEnabled = globalFrameConfig.frameAdminAuth{"authEnabled"}
    if authEnabled == nil:
      enabled and adminAuthProvider() == "local" and adminAuthUser().len > 0 and adminAuthPass().len > 0
    else:
      enabled

template adminAuthEnabled*(): bool =
  {.gcsafe.}:
    let authEnabled = globalFrameConfig.frameAdminAuth{"authEnabled"}
    adminPanelEnabled() and
      (if authEnabled == nil: true else: authEnabled.getBool(false)) and
      adminAuthProvider() == "local" and
      globalFrameConfig.frameAdminAuth{"user"}.getStr("").len > 0 and
      globalFrameConfig.frameAdminAuth{"pass"}.getStr("").len > 0

proc getOrCreateAdminSessionSalt*(configPath: string): string =
  let envSecret = getEnv("FRAMEOS_ADMIN_SESSION_SALT")
  if envSecret.len > 0:
    return envSecret

  let secretPath = configPath & ".admin_session_salt"
  try:
    if fileExists(secretPath):
      let existing = readFile(secretPath).strip()
      if existing.len > 0:
        return existing
  except CatchableError:
    discard

  randomize()
  let generated = $(hash($epochTime() & ":" & $rand(1_000_000_000) & ":" & configPath))
  try:
    writeFile(secretPath, generated & "\n")
  except CatchableError:
    discard
  return generated

template hasAdminSession*(request: Request): bool =
  {.gcsafe.}:
    block:
      if not adminPanelEnabled():
        false
      elif not adminAuthEnabled():
        true
      elif adminAuthUser().len == 0 or adminAuthPass().len == 0:
        false
      else:
        let token = getCookieValue(request, ADMIN_SESSION_COOKIE)
        let expectedToken = $(hash(adminSessionSalt() & ":" & adminAuthUser() & ":" & adminAuthPass()))
        token.len > 0 and token == expectedToken

template hasAuthenticatedAdminSession*(request: Request): bool =
  {.gcsafe.}:
    adminAuthEnabled() and hasAdminSession(request)

template hasAccess*(request: Request, accessType: AccessType): bool =
  {.gcsafe.}:
    block:
      if hasAuthenticatedAdminSession(request):
        true
      elif accessType == Write and not hasWriteAccessPermission():
        false
      else:
        let access = frameAccessMode()
        if access == "public" or (access == "protected" and accessType == Read):
          true
        else:
          let accessKey = frameAccessKeyValue()
          if accessKey == "":
            false
          elif request.queryParams.contains("k") and request.queryParams["k"] == accessKey:
            true
          elif getCookieValue(request, ACCESS_COOKIE) == accessKey:
            true
          elif request.httpMethod == "POST":
            request.headers.contains(AUTH_HEADER) and request.headers[AUTH_HEADER] == AUTH_TYPE & " " & accessKey
          else:
            false

proc hasAdminAccess*(request: Request, accessType: AccessType): bool =
  {.gcsafe.}:
    hasAdminSession(request) and hasAccess(request, accessType)

proc canAccessFrameSecrets*(request: Request): bool =
  {.gcsafe.}:
    hasAccess(request, Write)

proc adminSessionCookieValue*(): string {.gcsafe.} =
  $(hash(adminSessionSalt() & ":" & adminAuthUser() & ":" & adminAuthPass()))

proc validateAdminCredentials*(username: string, password: string): bool {.gcsafe.} =
  username == adminAuthUser() and password == adminAuthPass() and username.len > 0
