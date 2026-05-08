import json
import std/[hashes, locks, os, random, strutils, tables]
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

  AdminSessionKey = array[64, char]
  AdminSession = object
    token: AdminSessionKey
    expiresAt: float
    credentialFingerprint: Hash
  AdminSessionNode = ptr object
    next: AdminSessionNode
    value: AdminSession

var globalAdminSessions: AdminSessionNode
var globalAdminSessionsLock: Lock
var adminSessionStoreInitialized = false

proc ensureAdminSessionStoreInitialized() =
  if not adminSessionStoreInitialized:
    initLock(globalAdminSessionsLock)
    adminSessionStoreInitialized = true

proc secureRandomBytes(byteCount: int): string =
  result = newString(max(byteCount, 0))
  if result.len == 0:
    return

  var source: File
  if open(source, "/dev/urandom", fmRead):
    let bytesRead = source.readBuffer(addr result[0], result.len)
    close(source)
    if bytesRead == result.len:
      return

  randomize()
  for i in 0 ..< result.len:
    result[i] = char(rand(255))

proc secureRandomToken(byteCount = 32): string =
  let bytes = secureRandomBytes(byteCount)
  result = newStringOfCap(bytes.len * 2)
  for value in bytes:
    result.add(toHex(ord(value), 2))
  result = result.toLowerAscii()

proc getHeaderValue(request: Request, name: string): string =
  for (headerName, value) in request.headers:
    if cmpIgnoreCase(headerName, name) == 0:
      return value
  ""

proc getCookieValue*(request: Request, name: string): string =
  let cookieHeader = getHeaderValue(request, "cookie")
  if cookieHeader.len == 0:
    return ""
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

template frameAccessMode(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAccess

template frameAccessKeyValue*(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAccessKey

template adminPanelEnabled*(): bool =
  {.gcsafe.}:
    globalFrameConfig.frameAdminAuth{"enabled"}.getBool(false) and
      adminAuthUser().len > 0 and
      adminAuthPass().len > 0

template adminAuthEnabled*(): bool =
  {.gcsafe.}:
    adminPanelEnabled()

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

  let generated = secureRandomToken()
  try:
    writeFile(secretPath, generated & "\n")
  except CatchableError:
    discard
  return generated

proc adminSessionFingerprint(): Hash =
  hash(adminSessionSalt() & ":" & adminAuthUser() & ":" & adminAuthPass())

proc tokenToKey(token: string, key: var AdminSessionKey): bool =
  if token.len != key.len:
    return false
  for i in 0 ..< key.len:
    key[i] = token[i]
  true

proc freeAdminSessionsLocked() =
  var current = globalAdminSessions
  while current != nil:
    let next = current.next
    deallocShared(current)
    current = next
  globalAdminSessions = nil

proc clearAdminSessions*() =
  ensureAdminSessionStoreInitialized()
  withLock globalAdminSessionsLock:
    freeAdminSessionsLocked()

proc createAdminSession*(ttlSeconds = ADMIN_SESSION_TTL_SECONDS): string {.gcsafe.} =
  ensureAdminSessionStoreInitialized()
  let expiresAt = epochTime() + float(ttlSeconds)
  let credentialFingerprint = adminSessionFingerprint()

  while true:
    let token = secureRandomToken()
    var key: AdminSessionKey
    if not tokenToKey(token, key):
      continue
    var inserted = false
    withLock globalAdminSessionsLock:
      var current = globalAdminSessions
      while current != nil:
        if current.value.token == key:
          break
        current = current.next

      if current == nil:
        let node = cast[AdminSessionNode](allocShared0(sizeof(current[])))
        node.value = AdminSession(
          token: key,
          expiresAt: expiresAt,
          credentialFingerprint: credentialFingerprint,
        )
        node.next = globalAdminSessions
        globalAdminSessions = node
        inserted = true
    if inserted:
      return token

proc invalidateAdminSessionToken(token: string) =
  if token.len == 0:
    return
  ensureAdminSessionStoreInitialized()
  var key: AdminSessionKey
  if tokenToKey(token, key):
    withLock globalAdminSessionsLock:
      var previous: AdminSessionNode = nil
      var current = globalAdminSessions
      while current != nil:
        if current.value.token == key:
          if previous == nil:
            globalAdminSessions = current.next
          else:
            previous.next = current.next
          deallocShared(current)
          break
        previous = current
        current = current.next

proc invalidateAdminSession*(request: Request) =
  invalidateAdminSessionToken(getCookieValue(request, ADMIN_SESSION_COOKIE))

proc hasAdminSession*(request: Request): bool {.gcsafe.} =
  if not adminPanelEnabled():
    return false

  let token = getCookieValue(request, ADMIN_SESSION_COOKIE)
  if token.len == 0:
    return false

  ensureAdminSessionStoreInitialized()
  var key: AdminSessionKey
  if not tokenToKey(token, key):
    return false

  let now = epochTime()
  let fingerprint = adminSessionFingerprint()
  withLock globalAdminSessionsLock:
    var previous: AdminSessionNode = nil
    var current = globalAdminSessions
    while current != nil:
      let next = current.next
      if current.value.expiresAt <= now or current.value.credentialFingerprint != fingerprint:
        if previous == nil:
          globalAdminSessions = next
        else:
          previous.next = next
        deallocShared(current)
        current = next
        continue

      if current.value.token == key:
        return true

      previous = current
      current = next

proc hasAuthenticatedAdminSession*(request: Request): bool {.gcsafe.} =
  hasAdminSession(request)

proc allowUnauthenticatedStaticAssets*(): bool =
  {.gcsafe.}:
    let access = frameAccessMode()
    adminPanelEnabled() or access == "public" or access == "protected"

template hasAccess*(request: Request, accessType: AccessType): bool =
  {.gcsafe.}:
    block:
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
          getHeaderValue(request, AUTH_HEADER) == AUTH_TYPE & " " & accessKey
        else:
          false

proc hasAdminAccess*(request: Request): bool =
  {.gcsafe.}:
    hasAdminSession(request)

proc canAccessFrameSecrets*(request: Request): bool =
  {.gcsafe.}:
    hasAdminSession(request)

proc adminSessionCookieValue*(): string {.gcsafe.} =
  createAdminSession()

proc shouldUseSecureCookie*(request: Request): bool {.gcsafe.} =
  let forwardedProto = getHeaderValue(request, "x-forwarded-proto").split(",", 1)[0].strip().toLowerAscii()
  if forwardedProto == "https":
    return true

  let forwarded = getHeaderValue(request, "forwarded").toLowerAscii()
  "proto=https" in forwarded

proc accessCookieHeader*(request: Request, accessKey: string): string {.gcsafe.} =
  ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax" &
    (if shouldUseSecureCookie(request): "; Secure" else: "")

proc adminSessionCookieHeader*(request: Request, token: string, maxAge = ADMIN_SESSION_TTL_SECONDS): string {.gcsafe.} =
  ADMIN_SESSION_COOKIE & "=" & token &
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" & $maxAge &
    (if shouldUseSecureCookie(request): "; Secure" else: "")

proc clearAdminSessionCookieHeader*(request: Request): string {.gcsafe.} =
  ADMIN_SESSION_COOKIE & "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" &
    (if shouldUseSecureCookie(request): "; Secure" else: "")

proc validateAdminCredentials*(username: string, password: string): bool {.gcsafe.} =
  username == adminAuthUser() and password == adminAuthPass() and username.len > 0
