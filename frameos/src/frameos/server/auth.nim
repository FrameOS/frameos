import checksums/sha2
import json
import std/[locks, os, random, strutils, tables]
import times
import mummy
import frameos/types
from frameos/config import getConfigFilename
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

  SignedAdminSession = object
    expiresAt: int64
    nonce: string
    signature: string

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

proc secureRandomToken*(byteCount = 32): string =
  let bytes = secureRandomBytes(byteCount)
  result = newStringOfCap(bytes.len * 2)
  for value in bytes:
    result.add(toHex(ord(value), 2))
  result = result.toLowerAscii()

proc sha256Hex(data: string): string =
  var hasher = initSha_256()
  hasher.update(data)
  result = ($hasher.digest()).toLowerAscii()

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

var
  adminAuthCacheLock: Lock
  cachedAdminAuthPath: string
  cachedAdminAuthMtime: float
  cachedAdminAuthSize: BiggestInt
  cachedAdminAuth: JsonNode
  cachedAdminAuthValid: bool

initLock(adminAuthCacheLock)

proc invalidateFrameAdminAuthCache*() {.gcsafe.} =
  {.gcsafe.}:
    withLock adminAuthCacheLock:
      cachedAdminAuthValid = false
      cachedAdminAuth = nil

proc persistedFrameAdminAuth(): JsonNode {.gcsafe.} =
  ## Reads `frameAdminAuth` out of frame.json, memoized on the file's mtime and
  ## size. One admin auth check asks for this three times (panel enabled, user,
  ## pass), and it runs before the 401 on every request — so an unauthenticated
  ## flood used to cost three full JSON parses per request. The stat keeps the
  ## on-disk copy authoritative, so settings edits still apply without a restart.
  let path = getConfigFilename()
  var info: FileInfo
  try:
    info = getFileInfo(path)
  except CatchableError:
    invalidateFrameAdminAuthCache()
    return nil
  let mtime = info.lastWriteTime.toUnixFloat()

  {.gcsafe.}:
    withLock adminAuthCacheLock:
      if cachedAdminAuthValid and cachedAdminAuthPath == path and
          cachedAdminAuthMtime == mtime and cachedAdminAuthSize == info.size:
        return cachedAdminAuth

  var parsed: JsonNode = nil
  try:
    let data = parseFile(path)
    if data != nil and data.kind == JObject and data{"frameAdminAuth"} != nil and
        data{"frameAdminAuth"}.kind == JObject:
      parsed = data["frameAdminAuth"]
  except CatchableError:
    parsed = nil

  {.gcsafe.}:
    withLock adminAuthCacheLock:
      cachedAdminAuthPath = path
      cachedAdminAuthMtime = mtime
      cachedAdminAuthSize = info.size
      cachedAdminAuth = parsed
      cachedAdminAuthValid = true
  parsed

proc frameAdminAuthSnapshot*(): JsonNode {.gcsafe.} =
  let persistedAuth = persistedFrameAdminAuth()
  if persistedAuth != nil:
    return persistedAuth
  {.gcsafe.}:
    if globalFrameConfig != nil and globalFrameConfig.frameAdminAuth != nil:
      return globalFrameConfig.frameAdminAuth
  %*{}

proc adminAuthUser(): string {.gcsafe.} =
  frameAdminAuthSnapshot(){"user"}.getStr("")

proc adminAuthPass(): string {.gcsafe.} =
  frameAdminAuthSnapshot(){"pass"}.getStr("")

template frameAccessMode(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAccess

template frameAccessKeyValue*(): string =
  {.gcsafe.}:
    globalFrameConfig.frameAccessKey

template frameServerApiKeyValue(): string =
  {.gcsafe.}:
    (if globalFrameConfig.isNil: "" else: globalFrameConfig.serverApiKey)

proc adminPanelEnabled*(): bool {.gcsafe.} =
  let adminAuth = frameAdminAuthSnapshot()
  adminAuth{"enabled"}.getBool(false) and
    adminAuth{"user"}.getStr("").len > 0 and
    adminAuth{"pass"}.getStr("").len > 0

proc adminAuthEnabled*(): bool {.gcsafe.} =
  adminPanelEnabled()

proc getOrCreateAdminSessionSalt*(configPath: string): string =
  let envSecret = getEnv("FRAMEOS_ADMIN_SESSION_SALT")
  if envSecret.len > 0:
    return envSecret

  let legacySecretPath = configPath & ".admin_session_salt"
  let configuredSecretPath = getEnv("FRAMEOS_ADMIN_SESSION_SALT_FILE").strip()
  let frameosDir = getEnv("FRAMEOS_DIR", "/srv/frameos").strip(leading = false, trailing = true, chars = {'/'})
  var secretPath = legacySecretPath

  if configuredSecretPath.len > 0:
    secretPath = configuredSecretPath
  elif frameosDir.len > 0:
    let absoluteConfigPath =
      try:
        absolutePath(configPath)
      except CatchableError:
        configPath
    let absoluteFrameosDir =
      try:
        absolutePath(frameosDir)
      except CatchableError:
        frameosDir
    if absoluteConfigPath == absoluteFrameosDir / "current" / "frame.json" or
        absoluteConfigPath.startsWith(absoluteFrameosDir / "releases" / ""):
      secretPath = absoluteFrameosDir / "state" / "admin_session_salt"

  for path in [secretPath, legacySecretPath]:
    try:
      if path.len > 0 and fileExists(path):
        let existing = readFile(path).strip()
        if existing.len > 0:
          if path != secretPath:
            try:
              createDir(parentDir(secretPath))
              writeFile(secretPath, existing & "\n")
            except CatchableError:
              discard
          return existing
    except CatchableError:
      discard

  let generated = secureRandomToken()
  try:
    createDir(parentDir(secretPath))
    writeFile(secretPath, generated & "\n")
  except CatchableError:
    try:
      writeFile(legacySecretPath, generated & "\n")
    except CatchableError:
      discard
  return generated

proc adminSessionCredentialFingerprint(): string =
  sha256Hex(adminSessionSalt() & ":" & adminAuthUser() & ":" & adminAuthPass())

proc adminSessionSignature(expiresAt: int64, nonce: string): string =
  sha256Hex(adminSessionSalt() & ":" & adminSessionCredentialFingerprint() & ":" & $expiresAt & ":" & nonce)

proc constantTimeEquals(first, second: string): bool =
  if first.len != second.len:
    return false
  var diff = 0
  for i in 0 ..< first.len:
    diff = diff or (ord(first[i]) xor ord(second[i]))
  diff == 0

proc parseSignedAdminSession(token: string): SignedAdminSession =
  let parts = token.split(".")
  if parts.len != 4 or parts[0] != "v1":
    raise newException(ValueError, "Invalid admin session token")
  result.expiresAt = parseBiggestInt(parts[1]).int64
  result.nonce = parts[2]
  result.signature = parts[3]
  if result.nonce.len == 0 or result.signature.len == 0:
    raise newException(ValueError, "Invalid admin session token")

proc clearAdminSessions*() =
  # Admin sessions are signed, expiring cookies. Server startup still calls
  # this for compatibility with the old in-memory session store, but there is
  # no runtime session cache to clear anymore.
  discard

proc createAdminSession*(ttlSeconds = ADMIN_SESSION_TTL_SECONDS): string {.gcsafe.} =
  let expiresAt = int64(epochTime() + float(ttlSeconds))
  let nonce = secureRandomToken()
  "v1." & $expiresAt & "." & nonce & "." & adminSessionSignature(expiresAt, nonce)

proc invalidateAdminSessionToken(token: string) =
  # Logout clears the browser cookie. Signed sessions remain valid until their
  # embedded expiry if a client keeps an old cookie value.
  discard

proc invalidateAdminSession*(request: Request) =
  invalidateAdminSessionToken(getCookieValue(request, ADMIN_SESSION_COOKIE))

proc hasAdminSession*(request: Request): bool {.gcsafe.} =
  if not adminPanelEnabled():
    return false

  let token = getCookieValue(request, ADMIN_SESSION_COOKIE)
  if token.len == 0:
    return false

  let session =
    try:
      parseSignedAdminSession(token)
    except ValueError:
      return false

  if session.expiresAt <= int64(epochTime()):
    return false

  constantTimeEquals(session.signature, adminSessionSignature(session.expiresAt, session.nonce))

proc hasAuthenticatedAdminSession*(request: Request): bool {.gcsafe.} =
  hasAdminSession(request)

proc allowUnauthenticatedStaticAssets*(): bool =
  {.gcsafe.}:
    let access = frameAccessMode()
    adminPanelEnabled() or access == "public" or access == "protected"

proc hasServerApiKeyBearer*(request: Request): bool {.gcsafe.} =
  ## `Authorization: Bearer <serverApiKey>` on a POST — the frame's own
  ## credential toward its backend (frame.json `serverApiKey`, the key
  ## logger.nim posts logs with), which the backend presents when it calls the
  ## frame's HTTP API. Never on GET, like the access-key bearer: a link must
  ## not be able to carry it.
  let apiKey = frameServerApiKeyValue()
  if apiKey.len == 0 or request.httpMethod != "POST":
    return false
  constantTimeEquals(getHeaderValue(request, AUTH_HEADER), AUTH_TYPE & " " & apiKey)

template hasAccess*(request: Request, accessType: AccessType): bool =
  {.gcsafe.}:
    block:
      let access = frameAccessMode()
      if access == "public" or (access == "protected" and accessType == Read):
        true
      elif hasServerApiKeyBearer(request):
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

## Events that are control-plane verbs rather than something a scene reacts
## to. The runner (frameos/runner.nim) handles these itself and never
## dispatches them to the scene: `reload` re-reads frame.json and every
## uploaded scene, `restart` exits the process, `reboot` reboots the device,
## `uploadScenes` replaces the scene set. Everything else that arrives on
## POST /event/@name (setCurrentScene, setSceneState, button presses, turnOn /
## turnOff, render, metrics, custom scene events) is scene territory.
const ControlEvents* = ["reload", "restart", "reboot", "uploadScenes"]

proc isControlEvent*(name: string): bool =
  name in ControlEvents

proc hasControlAccess*(request: Request): bool {.gcsafe.} =
  ## Who may fire a control-plane verb: an admin session, or the backend with
  ## its serverApiKey bearer. Deliberately not the frame access key and not
  ## `public` mode — that key is printed on the frame's QR code and handed to
  ## whoever should be able to pick a scene, which must not extend to
  ## replacing the scene set or reboot-looping the device.
  {.gcsafe.}:
    hasAdminSession(request) or hasServerApiKeyBearer(request)

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
  ## Both comparisons are constant-time: `==` on strings returns as soon as it
  ## finds a differing byte, which leaks the length of a correct prefix to a
  ## caller that can time it.
  let expectedUser = adminAuthUser()
  let userMatches = constantTimeEquals(username, expectedUser)
  let passMatches = constantTimeEquals(password, adminAuthPass())
  userMatches and passMatches and expectedUser.len > 0
