import std/[json, os, sets, strutils]
import zippy
import assets/apps as appsAsset
import frameos/config
import frameos/device_setup
import frameos/types
import drivers/drivers as drivers

proc addUnique(packages: var seq[string], seen: var HashSet[string], packageName: string) =
  let normalized = packageName.strip()
  if normalized.len == 0 or seen.contains(normalized):
    return
  seen.incl(normalized)
  packages.add(normalized)

proc addAptPackagesFromConfig(packages: var seq[string], seen: var HashSet[string], config: JsonNode) =
  if config == nil or config.kind != JObject:
    return
  let aptPackages = config{"apt"}
  if aptPackages == nil or aptPackages.kind != JArray:
    return
  for item in aptPackages.items:
    if item.kind == JString:
      packages.addUnique(seen, item.getStr())

proc configFromSources(sources: JsonNode): JsonNode =
  if sources == nil or sources.kind != JObject:
    return nil
  let configSource = sources{"config.json"}
  if configSource == nil or configSource.kind != JString:
    return nil
  try:
    result = parseJson(configSource.getStr("{}"))
  except CatchableError:
    result = nil

proc addAptPackagesFromSources(packages: var seq[string], seen: var HashSet[string], sources: JsonNode) =
  packages.addAptPackagesFromConfig(seen, configFromSources(sources))

proc addAptPackagesFromAppCatalog(
  packages: var seq[string],
  seen: var HashSet[string],
  appsPayload: JsonNode,
  keyword: string,
) =
  if keyword.len == 0 or appsPayload == nil or appsPayload.kind != JObject:
    return
  let apps = appsPayload{"apps"}
  if apps == nil or apps.kind != JObject or not apps.hasKey(keyword):
    return
  packages.addAptPackagesFromConfig(seen, apps[keyword])

proc addAptPackagesFromSceneApp(
  packages: var seq[string],
  seen: var HashSet[string],
  scene: JsonNode,
  keyword: string,
) =
  if keyword.len == 0 or scene == nil or scene.kind != JObject:
    return
  let sceneApps = scene{"apps"}
  if sceneApps == nil or sceneApps.kind != JObject or not sceneApps.hasKey(keyword):
    return
  let sceneApp = sceneApps[keyword]
  if sceneApp == nil or sceneApp.kind != JObject:
    return
  packages.addAptPackagesFromSources(seen, sceneApp{"sources"})

proc appAptPackagesFromScenes*(scenesPayload: JsonNode, appsPayload: JsonNode): seq[string] =
  var seen = initHashSet[string]()
  result = @[]
  if scenesPayload == nil or scenesPayload.kind != JArray:
    return

  for scene in scenesPayload.items:
    if scene == nil or scene.kind != JObject:
      continue
    let nodes = scene{"nodes"}
    if nodes == nil or nodes.kind != JArray:
      continue

    for node in nodes.items:
      if node == nil or node.kind != JObject:
        continue

      let nodeType = node{"type"}.getStr()
      if nodeType == "app":
        let data = node{"data"}
        let keyword = data{"keyword"}.getStr()
        result.addAptPackagesFromAppCatalog(seen, appsPayload, keyword)
        result.addAptPackagesFromSceneApp(seen, scene, keyword)
        result.addAptPackagesFromSources(seen, data{"sources"})
      elif nodeType == "source":
        result.addAptPackagesFromSources(seen, node{"sources"})
        result.addAptPackagesFromSources(seen, node{"data"}{"sources"})

proc readJsonFile(path: string): JsonNode =
  let encoded = readFile(path)
  let decoded =
    if path.endsWith(".gz"):
      uncompress(encoded)
    else:
      encoded
  result = parseJson(decoded)

proc loadAllScenesPayload*(): JsonNode =
  let configuredPath = getEnv("FRAMEOS_ALL_SCENES_JSON")
  if configuredPath.len > 0 and fileExists(configuredPath):
    return readJsonFile(configuredPath)

  for path in ["./all_scenes.json.gz", "./all_scenes.json"]:
    if fileExists(path):
      return readJsonFile(path)

  let scenesPath = getEnv("FRAMEOS_SCENES_JSON")
  if scenesPath.len > 0 and fileExists(scenesPath):
    return readJsonFile(scenesPath)

  for path in ["./scenes.json.gz", "./scenes.json"]:
    if fileExists(path):
      return readJsonFile(path)

  result = newJArray()

proc loadAppsPayload(): JsonNode =
  try:
    result = parseJson(appsAsset.getAppsJson())
  except CatchableError:
    result = %*{"apps": {}}

proc setupAppAptPackages*(): SetupResult =
  setupAptPackages(appAptPackagesFromScenes(loadAllScenesPayload(), loadAppsPayload()))

proc setupFrameOS*(): SetupResult =
  echo "FrameOS setup: starting"
  let frameOS = FrameOS(frameConfig: loadConfig())
  if frameOS.frameConfig.mode == "rpios":
    addSetupResult(result, runSetupStep("app apt packages", proc(): SetupResult = setupAppAptPackages()))
  else:
    echo "FrameOS setup: app apt packages skipped for mode " & frameOS.frameConfig.mode
  addSetupResult(result, drivers.setup(frameOS))
  if result.rebootRequired:
    echo "FrameOS setup: reboot required"
  echo "FrameOS setup: complete"
