## A scene as files (docs/scene-packages.md), as the runtime reads it: the
## reader's half of frontend/src/utils/scenePackage.ts and
## backend/app/utils/scene_package.py, pinned with them by
## docs/scene-package-fixtures.json (tests/test_scene_package.nim).
##
##   scene.json             the scene, every app's `sources` taken out
##   apps/<keyword>/<file>  each file of `apps[keyword].sources`
##
## A set is a folder of scene folders, template.json's `scenes` their order.
## The runtime parses scene.json alone when a scene loads and reads an app's
## files when its interpreter starts (`appSourcesOf`), from a zip (a Pi's
## scenes.zip, an ESP32's slot file, a package handed to the browser
## preview: utils/zip_entry.nim, in a file or in memory) or a folder.

import std/[algorithm, json, strutils]
when not defined(frameosEmbedded):
  import std/os
import frameos/utils/zip_entry

const
  DeployedScenesPackage* = "./scenes.zip"
    ## A Pi's deployed set as a package, read before scenes.json.gz.
  SceneFile* = "scene.json"
  TemplateFile* = "template.json"
  AppsFolder* = "apps"

type
  ScenePackageError* = object of CatchableError
    code*: string

  ScenePackage* = object
    ## Where a package's files are: a ZIP (`zip`; `zipPath` names it for the
    ## directory zip_entry keeps) or, off the ESP32, a folder on disk.
    zip*: ZipSource
    zipPath*: string
    folder*: string

proc refuse(code, message: string) {.noreturn.} =
  var error = newException(ScenePackageError, message)
  error.code = code
  raise error

proc appFolderName*(keyword: string): string =
  keyword.replace("%", "%25").replace("/", "%2F")

proc isSafePackagePath*(path: string): bool =
  if path.len == 0 or path[0] == '/' or '\\' in path or '\0' in path:
    return false
  for segment in path.split('/'):
    if segment.len == 0 or segment == "." or segment == "..":
      return false
  true

proc zipPackage*(src: ZipSource, path = ""): ScenePackage =
  ScenePackage(zip: src, zipPath: path)

proc names*(pkg: ScenePackage): seq[string] =
  ## Every file of the package, `/`-separated (folders left out).
  if pkg.folder.len > 0:
    when not defined(frameosEmbedded):
      for path in walkDirRec(pkg.folder, relative = true):
        result.add path.replace('\\', '/')
    return
  for member in zipMembers(pkg.zip, pkg.zipPath):
    if not member.name.endsWith("/"):
      result.add member.name

proc read*(pkg: ScenePackage, name: string): string =
  ## One file's text; ZipEntryError / IOError when it is not there.
  if pkg.folder.len > 0:
    when not defined(frameosEmbedded):
      return readFile(pkg.folder / name)
  readWhole(pkg.zip, findMember(pkg.zip, name, pkg.zipPath))

proc dirOf(path: string): string =
  let slash = path.rfind('/')
  if slash < 0: "" else: path[0 ..< slash]

proc depth(path: string): int = path.count('/')

proc shallowest(paths: seq[string], name: string): int =
  ## The index of the shallowest `name` (then the first by path), -1 for none.
  result = -1
  for i, path in paths:
    if path == name or path.endsWith("/" & name):
      if result < 0 or depth(path) < depth(paths[result]) or
          (depth(path) == depth(paths[result]) and path < paths[result]):
        result = i

proc packageRoot*(paths: seq[string]): string =
  ## Where a set's files start: the folder of its shallowest template.json,
  ## else the parent of its shallowest scene folder, else the folder of its
  ## shallowest scenes.json; "" for the top.
  var i = shallowest(paths, TemplateFile)
  if i >= 0: return dirOf(paths[i])
  i = shallowest(paths, SceneFile)
  if i >= 0: return dirOf(dirOf(paths[i]))
  i = shallowest(paths, "scenes.json")
  if i >= 0: dirOf(paths[i]) else: ""

proc joinPath(root, name: string): string =
  if root.len == 0: name else: root & "/" & name

proc stripDotSlash(path: string): string =
  result = path
  while result.startsWith("./"):
    result = result[2 .. ^1]
  while result.endsWith("/"):
    result.setLen(result.len - 1)

type PackagedScene* = object
  ## One scene of a set: its folder relative to the package's top ("" for a
  ## package of one scene), and its scene.json as text. `legacy`: the whole
  ## array of a scenes.json from before packages, sources included.
  folder*: string
  sceneJson*: string
  legacy*: bool

proc packagedScenes*(pkg: ScenePackage): seq[PackagedScene] =
  ## The scenes of a package in order, whichever form it is in (scene
  ## folders in template.json's order, then the rest by name; one scene at
  ## the top; a legacy scenes.json, given as one `legacy` entry).
  let paths = pkg.names()
  let root = packageRoot(paths)
  var listed: JsonNode = nil
  let templatePath = joinPath(root, TemplateFile)
  if templatePath in paths:
    var manifest: JsonNode
    try:
      manifest = parseJson(pkg.read(templatePath))
    except CatchableError as error:
      refuse("invalid_template", "template.json is not JSON: " & error.msg)
    if manifest.kind != JObject:
      refuse("invalid_template", "template.json is not an object")
    listed = manifest{"scenes"}
  let legacyName = joinPath(root, "scenes.json")
  if (not listed.isNil and listed.kind == JString) or (listed.isNil and legacyName in paths):
    let name = if listed.isNil: legacyName else: joinPath(root, stripDotSlash(listed.getStr()))
    if name notin paths:
      refuse("missing_scenes", "The package has no " & name)
    return @[PackagedScene(folder: dirOf(name), sceneJson: pkg.read(name), legacy: true)]
  let top = joinPath(root, SceneFile)
  if top in paths:
    return @[PackagedScene(folder: root, sceneJson: pkg.read(top))]
  var folders: seq[string]
  let prefix = if root.len == 0: "" else: root & "/"
  for path in paths:
    if path.startsWith(prefix) and path.endsWith("/" & SceneFile):
      let rest = path[prefix.len ..< path.len - SceneFile.len - 1]
      if rest.len > 0 and '/' notin rest and rest notin folders:
        folders.add rest
  folders.sort()
  var order: seq[string]
  if not listed.isNil and listed.kind == JArray:
    for entry in listed.elems:
      let folder = if entry.kind == JString: stripDotSlash(entry.getStr()) else: ""
      if folder.len == 0 or not isSafePackagePath(folder) or '/' in folder:
        refuse("invalid_template", "template.json lists " & $entry)
      if folder notin folders:
        refuse("missing_scene", "template.json lists " & folder & ", which has no scene.json")
      if folder notin order:
        order.add folder
  for folder in folders:
    if folder notin order:
      order.add folder
  if order.len == 0:
    refuse("missing_scenes", "The package holds no scene")
  for folder in order:
    let path = joinPath(root, folder)
    result.add PackagedScene(folder: path, sceneJson: pkg.read(joinPath(path, SceneFile)))

proc appFiles(pkg: ScenePackage, paths: seq[string], folder: string): seq[tuple[keyword, file, path: string]] =
  ## The app files of the scene in `folder`, refused when a path is unsafe.
  let prefix = joinPath(folder, AppsFolder) & "/"
  for path in paths:
    if not path.startsWith(prefix):
      continue
    let rest = path[prefix.len .. ^1]
    let slash = rest.find('/')
    if slash <= 0 or not isSafePackagePath(path):
      refuse("unsafe_path", "The package has a file named " & path)
    let keyword = rest[0 ..< slash].replace("%2F", "/").replace("%2f", "/").replace("%25", "%")
    result.add (keyword, rest[slash + 1 .. ^1], path)

proc appSourcesOf*(pkg: ScenePackage, folder, keyword: string): JsonNode =
  ## One app's files, {file: text}, read now; nil when the package has none.
  ## What an interpreter is started from: nothing of it stays after. The
  ## names are only keys here (nothing is opened by them), so they are not
  ## checked: a frame reads what its plane wrote.
  let prefix = joinPath(folder, AppsFolder) & "/" & appFolderName(keyword) & "/"
  for path in pkg.names():
    if path.len > prefix.len and path.startsWith(prefix):
      if result.isNil:
        result = newJObject()
      result[path[prefix.len .. ^1]] = %pkg.read(path)

proc storedSceneJson*(bytes: string): string =
  ## A scene package's scene.json, out of its bytes in memory (an ESP32's
  ## slot file; main/fos_scene_package.c is the store's half).
  let src = memorySource(bytes)
  readWhole(src, findMember(src, SceneFile))

proc sceneOfPackage*(pkg: ScenePackage, scene: PackagedScene): JsonNode =
  ## The whole scene object, its app files back in `apps[*].sources` (files
  ## over what scene.json still carries; an app folder scene.json does not
  ## name becomes that app): what a reader of whole scenes gets (the Code
  ## editor's source, the fixtures).
  try:
    result = parseJson(scene.sceneJson)
  except CatchableError as error:
    refuse("invalid_scene", "scene.json is not JSON: " & error.msg)
  if result.kind != JObject:
    refuse("invalid_scene", "scene.json is not one scene object")
  let files = pkg.appFiles(pkg.names(), scene.folder)
  if files.len == 0:
    return
  var apps = result{"apps"}
  if apps.isNil or apps.kind != JObject:
    apps = newJObject()
    result["apps"] = apps
  for (keyword, file, path) in files:
    var app = apps{keyword}
    if app.isNil or app.kind != JObject:
      app = newJObject()
      apps[keyword] = app
    var sources = app{"sources"}
    if sources.isNil or sources.kind != JObject:
      sources = newJObject()
    else:
      app.delete("sources")
    sources[file] = %pkg.read(path)
    app["sources"] = sources

proc scenesOfPackage*(pkg: ScenePackage): JsonNode =
  ## Every scene of the package as whole objects, in order.
  result = newJArray()
  for scene in pkg.packagedScenes():
    if scene.legacy:
      let parsed = parseJson(scene.sceneJson)
      if parsed.kind != JArray:
        refuse("invalid_scenes", "scenes.json is not a list of scenes")
      for item in parsed.elems:
        if item.kind != JObject:
          refuse("invalid_scenes", "scenes.json is not a list of scenes")
        result.add item
    else:
      result.add pkg.sceneOfPackage(scene)
