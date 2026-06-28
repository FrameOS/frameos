import std/[algorithm, json, strutils, tables]
import mummy
import mummy/routers
import httpcore
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

  let scenesReference = templateData{"scenes"}.getStr("")
  if scenesReference.len > 0:
    let scenesPath = resolveTemplateResource(repositorySlug, templateSlug, scenesReference)
    if scenesPath.len > 0 and repoSceneAssetExists(scenesPath):
      try:
        templateData["scenes"] = parseJson(getRepoSceneAsset(scenesPath))
      except CatchableError:
        templateData["scenes"] = newJArray()
    else:
      templateData["scenes"] = newJArray()

  templateData

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
    if metadata{"description"}.kind == JString: %(metadata{"description"}.getStr()) else: newJNull()
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
    jsonResponse(request, Http200, newJArray())
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
