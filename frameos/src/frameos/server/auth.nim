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

template adminAuthEnabled*(): bool =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"enabled"}.getBool(false) and
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

proc hasAdminSession*(request: Request): bool =
  {.gcsafe.}:
    if not adminAuthEnabled():
      return true
    if adminAuthUser().len == 0 or adminAuthPass().len == 0:
      return false
    let token = getCookieValue(request, ADMIN_SESSION_COOKIE)
    let expectedToken = $(hash(globalAdminSessionSalt & ":" & adminAuthUser() & ":" & adminAuthPass()))
    return token.len > 0 and token == expectedToken

proc hasAuthenticatedAdminSession*(request: Request): bool =
  {.gcsafe.}:
    adminAuthEnabled() and hasAdminSession(request)

proc hasAccess*(request: Request, accessType: AccessType): bool =
  {.gcsafe.}:
    if hasAuthenticatedAdminSession(request):
      return true
    let access = globalFrameConfig.frameAccess
    if access == "public" or (access == "protected" and accessType == Read):
      return true
    let accessKey = globalFrameConfig.frameAccessKey
    if accessKey == "":
      return false
    if request.queryParams.contains("k") and request.queryParams["k"] == accessKey:
      return true
    if getCookieValue(request, ACCESS_COOKIE) == accessKey:
      return true
    if request.httpMethod == "POST":
      return request.headers.contains(AUTH_HEADER) and request.headers[AUTH_HEADER] == AUTH_TYPE & " " & accessKey
    return false

proc canAccessFrameSecrets*(request: Request): bool =
  {.gcsafe.}:
    hasAccess(request, Write)

proc adminSessionCookieValue*(): string {.gcsafe.} =
  $(hash(globalAdminSessionSalt & ":" & adminAuthUser() & ":" & adminAuthPass()))

proc validateAdminCredentials*(username: string, password: string): bool {.gcsafe.} =
  username == adminAuthUser() and password == adminAuthPass() and username.len > 0
