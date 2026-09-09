import std/[algorithm, json, locks, monotimes, strutils, tables, times]
import mummy
import mummy/routers
import httpcore
import frameos/version
import frameos/channels
import frameos/cloud/link_state
import frameos/utils/http_client
import ../api
import ../auth
import ../embedded_assets
import ./admin_api_assets_routes
import ./common

const RepoSceneAssetPrefix = "repo/scenes/"
const TemplateJsonSuffix = "/template.json"

proc decodePathSegment(value: string): string =
  try:
    decodeQueryComponent(value)
  except CatchableError:
    value

proc validPathSegment(value: string): bool =
  value.len > 0 and "/" notin value and "\\" notin value and value != "." and value != ".."

proc repoSceneAssetExists(path: string): bool {.gcsafe.} =
  for assetPath in listRepoSceneAssetPaths():
    if assetPath == path:
      return true
  false

proc repositorySlugs(): seq[string] {.gcsafe.} =
  var seen = initTable[string, bool]()
  for assetPath in listRepoSceneAssetPaths():
    if not assetPath.startsWith(RepoSceneAssetPrefix):
      continue
    let rest = assetPath[RepoSceneAssetPrefix.len .. ^1]
    let slash = rest.find("/")
    if slash <= 0:
      continue
    let slug = rest[0 ..< slash]
    if validPathSegment(slug):
      seen[slug] = true

  for slug in seen.keys:
    result.add(slug)

proc templateSlugs(repositorySlug: string): seq[string] {.gcsafe.} =
  let prefix = RepoSceneAssetPrefix & repositorySlug & "/"
  var seen = initTable[string, bool]()
  for assetPath in listRepoSceneAssetPaths():
    if not assetPath.startsWith(prefix) or not assetPath.endsWith(TemplateJsonSuffix):
      continue
    let rest = assetPath[prefix.len .. ^1]
    let slug = rest[0 ..< rest.len - TemplateJsonSuffix.len]
    if validPathSegment(slug):
      seen[slug] = true

  for slug in seen.keys:
    result.add(slug)
  result.sort()

proc resolveTemplateResource(repositorySlug: string, templateSlug: string, resourcePath: string): string =
  if resourcePath.len == 0:
    return ""

  var relative = resourcePath
  if relative.startsWith("./"):
    relative = relative[2 .. ^1]
  if relative.startsWith("/") or "\\" in relative:
    return ""
  for part in relative.split("/"):
    if part.len == 0 or part == "." or part == "..":
      return ""

  RepoSceneAssetPrefix & repositorySlug & "/" & templateSlug & "/" & relative

proc systemTemplateImagePath(repositorySlug: string, templateSlug: string): string {.gcsafe.} =
  if not validPathSegment(repositorySlug) or not validPathSegment(templateSlug):
    return ""

  let templatePath = RepoSceneAssetPrefix & repositorySlug & "/" & templateSlug & "/template.json"
  if not repoSceneAssetExists(templatePath):
    return ""

  let templateData =
    try:
      parseJson(getRepoSceneAsset(templatePath))
    except CatchableError:
      return ""
  let imageReference = templateData{"image"}.getStr("")
  let imagePath = resolveTemplateResource(repositorySlug, templateSlug, imageReference)
  if imagePath.len == 0 or not repoSceneAssetExists(imagePath):
    return ""
  imagePath

proc loadTemplateDefinition(repositorySlug: string, templateSlug: string): JsonNode {.gcsafe.} =
  let templatePath = RepoSceneAssetPrefix & repositorySlug & "/" & templateSlug & "/template.json"
  if not repoSceneAssetExists(templatePath):
    return nil

  let templateData =
    try:
      parseJson(getRepoSceneAsset(templatePath))
    except CatchableError:
      return nil
  if templateData.kind != JObject:
    return nil

  if templateData{"image"}.getStr("").len > 0:
    templateData["image"] =
      %("/api/repositories/system/" & repositorySlug & "/templates/" & templateSlug & "/image")

  # Scenes can be large (embedded app sources), so the listing only carries
  # a URL; clients fetch the scenes on install or when otherwise needed.
  let scenesReference = templateData{"scenes"}.getStr("")
  if scenesReference.len > 0:
    templateData.delete("scenes")
    let scenesPath = resolveTemplateResource(repositorySlug, templateSlug, scenesReference)
    if scenesPath.len > 0 and repoSceneAssetExists(scenesPath):
      templateData["scenesUrl"] =
        %("/api/repositories/system/" & repositorySlug & "/templates/" & templateSlug & "/scenes.json")

  templateData

proc systemTemplateScenesPath(repositorySlug: string, templateSlug: string): string {.gcsafe.} =
  if not validPathSegment(repositorySlug) or not validPathSegment(templateSlug):
    return ""

  let templatePath = RepoSceneAssetPrefix & repositorySlug & "/" & templateSlug & "/template.json"
  if not repoSceneAssetExists(templatePath):
    return ""

  let templateData =
    try:
      parseJson(getRepoSceneAsset(templatePath))
    except CatchableError:
      return ""
  let scenesReference = templateData{"scenes"}.getStr("")
  let scenesPath = resolveTemplateResource(repositorySlug, templateSlug, scenesReference)
  if scenesPath.len == 0 or not repoSceneAssetExists(scenesPath):
    return ""
  scenesPath

proc loadSystemRepository(repositorySlug: string): JsonNode {.gcsafe.} =
  let metadataPath = RepoSceneAssetPrefix & repositorySlug & "/repository.json"
  let metadata =
    if repoSceneAssetExists(metadataPath):
      try:
        parseJson(getRepoSceneAsset(metadataPath))
      except CatchableError:
        newJObject()
    else:
      newJObject()

  var templates = newJArray()
  for templateSlug in templateSlugs(repositorySlug):
    let templateData = loadTemplateDefinition(repositorySlug, templateSlug)
    if templateData != nil:
      templates.add(templateData)

  result = newJObject()
  result["id"] = %("system-" & repositorySlug)
  result["name"] = %(metadata{"name"}.getStr(repositorySlug))
  result["description"] =
    if metadata{"description"} != nil and metadata["description"].kind == JString: %(metadata["description"].getStr()) else: newJNull()
  result["url"] = %("/api/repositories/system/" & repositorySlug & "/repository.json")
  result["last_updated_at"] = newJNull()
  result["templates"] = templates

proc systemRepositoryRank(slug: string): int =
  case slug
  of "samples":
    0
  of "gallery":
    1
  else:
    2

proc systemRepositoriesPayload(): JsonNode {.gcsafe.} =
  var slugs = repositorySlugs()
  slugs.sort(proc(a, b: string): int =
    let rankComparison = cmp(systemRepositoryRank(a), systemRepositoryRank(b))
    if rankComparison != 0:
      rankComparison
    else:
      cmp(a, b)
  )

  result = newJArray()
  for slug in slugs:
    result.add(loadSystemRepository(slug))

# ---------------------------------------------------------------------------
# The cloud scene store as a repository, the way a self-hosted backend tracks
# it (backend/app/api/repositories.py, cloud_store_repository_url): the
# provider this frame is linked to — or the default provider when it is not
# linked — serves its public catalog as frameos repository JSON at
# /api/store/{frameosVersion}/repository.json, filtered to scenes this
# version can run. The frame fetches that index itself and hands the SPA the
# same shape /api/repositories has on a backend; template scenes come through
# a same-origin route so the browser never needs CORS against the provider.
# Images and zips stay absolute provider URLs — the browser loads those.

const
  CloudStoreRepositoryId* = "system-cloud-store"
  CloudStoreScenesRoutePrefix = "/api/repositories/cloud-store/scenes/"
  cloudStoreIndexTtlSeconds = 300
  ## A provider that is down or answering garbage is not asked again on the
  ## very next request: with four worker threads and the SPA polling, that
  ## was a fetch per request, each one waiting out the timeout.
  cloudStoreFailureTtlSeconds = 30
  cloudStoreFetchTimeoutMs = 10_000
  cloudStoreFetchMaxSeconds = 15.0
  ## The index is a catalog (names, ids, image and zip URLs); a scene's
  ## scenes.json carries app sources and can be far larger.
  CloudStoreIndexMaxBytes* = 2 * 1024 * 1024
  CloudStoreScenesMaxBytes* = 8 * 1024 * 1024

type CloudStoreFetchHook* = proc(url: string, maxBytes: int): tuple[body: string, status: int] {.gcsafe, nimcall.}

proc defaultCloudStoreFetch(url: string, maxBytes: int): tuple[body: string, status: int] {.gcsafe, nimcall.} =
  ## The runtime's own client: connect, TLS and send are bounded, not just
  ## the read (utils/http_client.nim), the body is capped at maxBytes, and
  ## redirects are counted. The stdlib client this replaced bounded none of
  ## those and let the provider size the frame's heap.
  try:
    let response = boundedRequestWithHeaders(url, timeoutMs = cloudStoreFetchTimeoutMs,
                                             maxBytes = maxBytes, maxSeconds = cloudStoreFetchMaxSeconds,
                                             maxRedirects = 2)
    (body: response.body, status: response.code)
  except CatchableError as e:
    (body: e.msg, status: 0)

var cloudStoreFetchHook: CloudStoreFetchHook = defaultCloudStoreFetch

proc setCloudStoreFetchHookForTest*(hook: CloudStoreFetchHook) =
  cloudStoreFetchHook = if hook == nil: defaultCloudStoreFetch else: hook

# The index is fetched and shaped ONCE per TTL and kept as the serialized
# repository entry (a string, copied out under the lock): a JsonNode shared
# across the worker threads is what took the admin panel down on 2026-09-06
# (server/auth.nim), and re-parsing the provider's whole index on every
# request was the other half of the cost. `cloudStoreFetchLock` is the
# single-flight: the first request past a stale cache holds it while it
# fetches, the others queue on it and find the fresh entry when they wake.
var
  cloudStoreCacheLock: Lock
  cloudStoreFetchLock: Lock
  cloudStoreCacheUrl: string
  cloudStoreCacheEntry: string
  cloudStoreCacheAt: MonoTime
  cloudStoreCacheValid: bool
  cloudStoreFailedUrl: string
  cloudStoreFailedAt: MonoTime
  cloudStoreFailedValid: bool

initLock(cloudStoreCacheLock)
initLock(cloudStoreFetchLock)

proc resetCloudStoreCacheForTest*() =
  withLock cloudStoreCacheLock:
    cloudStoreCacheValid = false
    cloudStoreCacheEntry = ""
    cloudStoreCacheUrl = ""
    cloudStoreFailedValid = false
    cloudStoreFailedUrl = ""

proc cloudStoreProviderUrl(): string {.gcsafe.} =
  providerUrlFromState(loadCloudLinkState()).strip(chars = {'/'})

proc cloudStoreRepositoryUrl*(): string {.gcsafe.} =
  ## The versioned index when this build knows its version, the plain index
  ## otherwise — the same fallback the backend makes.
  let version = publishedFrameOSVersion(compiledFrameOSVersion())
  let base = cloudStoreProviderUrl() & "/api/store/"
  if version.len == 0 or version == "unknown": base & "repository.json"
  else: base & version & "/repository.json"

proc resolveAgainst(repositoryUrl: string, value: string): string =
  ## "./x" is relative to the index's directory, as the backend and the cloud
  ## SPA both resolve it (backend/app/models/repository.py).
  if not value.startsWith("./"):
    return value
  let slash = repositoryUrl.rfind('/')
  (if slash >= 0: repositoryUrl[0 ..< slash] else: repositoryUrl) & value[1 .. ^1]

proc validStoreSceneId(value: string): bool =
  value.len == 36 and value.allCharsInSet({'0'..'9', 'a'..'f', 'A'..'F', '-'})

proc shapeCloudStoreRepository(url: string, body: string): JsonNode {.gcsafe.} =
  ## The provider's index as one repository entry, or nil when the body is
  ## not an index.
  let data =
    try:
      parseJson(body)
    except CatchableError:
      log(%*{"event": "repositories:cloudStore:invalid", "url": url})
      return nil
  if data.kind != JObject:
    return nil

  var templates = newJArray()
  if data{"templates"} != nil and data["templates"].kind == JArray:
    for entry in data["templates"]:
      if entry.kind != JObject:
        continue
      var templateData = copy(entry)
      for key in ["image", "zip"]:
        if templateData{key} != nil and templateData[key].kind == JString:
          templateData[key] = %resolveAgainst(url, templateData[key].getStr())
      # Scenes load through this frame, not straight from the provider: the
      # SPA runs on the frame's origin and fetchTemplateScenes takes a
      # same-origin scenesUrl without any CORS on the store.
      if templateData.hasKey("scenes"):
        templateData.delete("scenes")
      let sceneId = templateData{"sceneId"}.getStr("")
      if validStoreSceneId(sceneId):
        templateData["scenesUrl"] = %(CloudStoreScenesRoutePrefix & sceneId & "/scenes.json")
      templates.add(templateData)

  result = newJObject()
  result["id"] = %CloudStoreRepositoryId
  result["name"] = %(data{"name"}.getStr("FrameOS Cloud store"))
  result["description"] =
    if data{"description"} != nil and data["description"].kind == JString: %(data["description"].getStr()) else: newJNull()
  result["url"] = %url
  result["last_updated_at"] = newJNull()
  result["templates"] = templates

proc cachedCloudStoreEntry(url: string, now: MonoTime): tuple[hit: bool, entry: string] {.gcsafe.} =
  ## Under the cache lock: the serialized entry when it is fresh, "" (as a
  ## hit) inside the failure window, and a miss otherwise.
  {.gcsafe.}:
    withLock cloudStoreCacheLock:
      if cloudStoreCacheValid and cloudStoreCacheUrl == url and
          (now - cloudStoreCacheAt) < initDuration(seconds = cloudStoreIndexTtlSeconds):
        return (hit: true, entry: cloudStoreCacheEntry)
      if cloudStoreFailedValid and cloudStoreFailedUrl == url and
          (now - cloudStoreFailedAt) < initDuration(seconds = cloudStoreFailureTtlSeconds):
        return (hit: true, entry: "")
  (hit: false, entry: "")

proc cloudStoreRepositoryEntry*(): string {.gcsafe.} =
  ## The store as one serialized repository entry, or "" when the index
  ## cannot be had. One fetch and one parse per TTL, shared by every worker.
  let url = cloudStoreRepositoryUrl()
  let cached = cachedCloudStoreEntry(url, getMonoTime())
  if cached.hit:
    return cached.entry
  result = ""
  {.gcsafe.}:
    withLock cloudStoreFetchLock:
      # Whoever held the lock before us may have filled the cache.
      let again = cachedCloudStoreEntry(url, getMonoTime())
      if again.hit:
        return again.entry
      let fetched = cloudStoreFetchHook(url, CloudStoreIndexMaxBytes)
      var shaped: JsonNode = nil
      if fetched.status != 200:
        log(%*{"event": "repositories:cloudStore:unavailable", "url": url, "status": fetched.status,
               "error": (if fetched.status == 0: fetched.body else: "")})
      else:
        shaped = shapeCloudStoreRepository(url, fetched.body)
      let entry = if shaped == nil: "" else: $shaped
      withLock cloudStoreCacheLock:
        if shaped == nil:
          cloudStoreFailedUrl = url
          cloudStoreFailedAt = getMonoTime()
          cloudStoreFailedValid = true
        else:
          cloudStoreCacheUrl = url
          cloudStoreCacheEntry = entry
          cloudStoreCacheAt = getMonoTime()
          cloudStoreCacheValid = true
          cloudStoreFailedValid = false
      result = entry

proc cloudStoreRepositoryPayload*(): JsonNode {.gcsafe.} =
  ## The store as one repository entry, or nil when the index is unavailable.
  ## A fresh node per caller — never the cached one.
  let entry = cloudStoreRepositoryEntry()
  if entry.len == 0:
    return nil
  parseJson(entry)

proc cloudStoreSceneScenesJson(sceneId: string): tuple[body: string, status: int] {.gcsafe.} =
  {.gcsafe.}:
    cloudStoreFetchHook(cloudStoreProviderUrl() & "/api/store/scenes/" & sceneId & "/scenes.json",
                        CloudStoreScenesMaxBytes)

proc requireRepositoryReadAccess(request: Request): bool {.gcsafe.} =
  if not hasAdminAccess(request):
    request.respond(Http401, body = "Unauthorized")
    return false
  true

proc addRepositoryApiRoutes*(router: var Router) =
  router.get("/api/repositories/system", proc(request: Request) {.gcsafe.} =
    if not requireRepositoryReadAccess(request):
      return
    {.gcsafe.}:
      jsonResponse(request, Http200, systemRepositoriesPayload())
  )

  router.get("/api/repositories", proc(request: Request) {.gcsafe.} =
    if not requireRepositoryReadAccess(request):
      return
    {.gcsafe.}:
      # The cached entry is served as-is: no parse per request.
      let cloudStore = cloudStoreRepositoryEntry()
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      request.respond(Http200, headers, "[" & cloudStore & "]")
  )

  router.get("/api/repositories/cloud-store/scenes/@sceneId/scenes.json", proc(request: Request) {.gcsafe.} =
    if not requireRepositoryReadAccess(request):
      return
    {.gcsafe.}:
      let sceneId = decodePathSegment(request.pathParams["sceneId"])
      if not validStoreSceneId(sceneId):
        jsonResponse(request, Http404, %*{"detail": "Scene not found"})
        return
      let fetched = cloudStoreSceneScenesJson(sceneId)
      if fetched.status != 200:
        jsonResponse(request, Http502, %*{"detail": "The scene store did not answer",
                                          "status": fetched.status})
        return
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      headers["Cache-Control"] = "no-store"
      request.respond(Http200, headers, fetched.body)
  )

  router.get("/api/repositories/system/@repositorySlug/templates/@templateSlug/scenes.json", proc(request: Request) {.gcsafe.} =
    if not requireRepositoryReadAccess(request):
      return
    {.gcsafe.}:
      let repositorySlug = decodePathSegment(request.pathParams["repositorySlug"])
      let templateSlug = decodePathSegment(request.pathParams["templateSlug"])
      let scenesPath = systemTemplateScenesPath(repositorySlug, templateSlug)
      if scenesPath.len == 0:
        jsonResponse(request, Http404, %*{"detail": "Template scenes not found"})
        return

      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      request.respond(Http200, headers, getRepoSceneAsset(scenesPath))
  )

  router.get("/api/repositories/system/@repositorySlug/templates/@templateSlug/image", proc(request: Request) {.gcsafe.} =
    if not requireRepositoryReadAccess(request):
      return
    {.gcsafe.}:
      let repositorySlug = decodePathSegment(request.pathParams["repositorySlug"])
      let templateSlug = decodePathSegment(request.pathParams["templateSlug"])
      let imagePath = systemTemplateImagePath(repositorySlug, templateSlug)
      if imagePath.len == 0:
        jsonResponse(request, Http404, %*{"detail": "Template image not found"})
        return

      var headers: mummy.HttpHeaders
      headers["Content-Type"] = contentTypeForFilePath(imagePath)
      headers["Cache-Control"] = "public, max-age=86400"
      request.respond(Http200, headers, getRepoSceneAsset(imagePath))
  )
