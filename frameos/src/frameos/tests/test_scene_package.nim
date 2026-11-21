## docs/scene-package-fixtures.json against the runtime's reader
## (scene_package.nim), each case as a ZIP in memory and as a folder on disk;
## the SPA's scenePackage.ts and the backend's scene_package.py replay the
## same corpus, and also pack.

import std/[json, os, strutils, unittest]
import ../scene_package
import ../utils/zip_entry

let fixtures = parseJson(readFile(currentSourcePath().parentDir / "../../../../docs/scene-package-fixtures.json"))

proc le16(n: int): string = $char(n and 0xFF) & $char((n shr 8) and 0xFF)
proc le32(n: int): string = le16(n and 0xFFFF) & le16((n shr 16) and 0xFFFF)

proc storedZip(files: openArray[(string, string)]): string =
  ## A ZIP of stored members, names as given (a reader must refuse the bad
  ## ones itself). CRCs are left 0: the reader never checks them.
  var central = ""
  for (name, data) in files:
    let offset = result.len
    result.add le32(0x04034b50) & le16(20) & le16(0) & le16(0) & le16(0) & le16(0) & le32(0) &
      le32(data.len) & le32(data.len) & le16(name.len) & le16(0) & name & data
    central.add le32(0x02014b50) & le16(20) & le16(20) & le16(0) & le16(0) & le16(0) & le16(0) &
      le32(0) & le32(data.len) & le32(data.len) & le16(name.len) & le16(0) & le16(0) & le16(0) &
      le16(0) & le32(0) & le32(offset) & name
  let at = result.len
  result.add central & le32(0x06054b50) & le16(0) & le16(0) & le16(files.len) & le16(files.len) &
    le32(central.len) & le32(at) & le16(0)

proc texts(files: JsonNode): seq[(string, string)] =
  for path, value in files.pairs:
    result.add (path, if value.kind == JString: value.getStr() else: $value)

var folderCount = 0
proc onDisk(files: seq[(string, string)]): string =
  inc folderCount
  result = currentSourcePath().parentDir / "../../../build/test-scene-package" / $folderCount
  removeDir(result)
  for (path, text) in files:
    createDir(parentDir(result / path))
    writeFile(result / path, text)

proc bothWays(files: seq[(string, string)], check: proc (pkg: ScenePackage)) =
  forgetZipDirectory()
  let bytes = storedZip(files)
  check(zipPackage(memorySource(bytes)))
  check(ScenePackage(folder: onDisk(files)))

suite "docs/scene-package-fixtures.json":
  test "scene packages read back as their scene":
    for kase in fixtures["scenes"]:
      if kase{"withoutTests"}.getBool(false):
        continue
      bothWays(texts(kase["files"])) do (pkg: ScenePackage):
        let scenes = pkg.scenesOfPackage()
        check scenes.len == 1
        check scenes[0] == kase["scene"]

  test "a set reads back as its scenes, in order":
    for kase in fixtures["sets"]:
      bothWays(texts(kase["files"])) do (pkg: ScenePackage):
        check pkg.scenesOfPackage() == kase["scenes"]

  test "reads":
    for kase in fixtures["reads"]:
      checkpoint kase["name"].getStr()
      bothWays(texts(kase["files"])) do (pkg: ScenePackage):
        check pkg.scenesOfPackage() == kase["scenes"]

  test "refusals":
    for kase in fixtures["refusals"]:
      checkpoint kase["name"].getStr()
      forgetZipDirectory()
      let bytes = storedZip(texts(kase["files"]))
      var code = ""
      try:
        discard zipPackage(memorySource(bytes)).scenesOfPackage()
      except ScenePackageError as error:
        code = error.code
      check code == kase["code"].getStr()

  test "one app's files, read when its interpreter starts":
    let kase = fixtures["scenes"][0]
    bothWays(texts(kase["files"])) do (pkg: ScenePackage):
      let scene = pkg.packagedScenes()[0]
      check scene.folder == ""
      check not parseJson(scene.sceneJson)["apps"]["weatherCard"].hasKey("sources")
      check pkg.appSourcesOf(scene.folder, "weatherCard") == kase["scene"]["apps"]["weatherCard"]["sources"]
      check pkg.appSourcesOf(scene.folder, "missing").isNil
    let odd = fixtures["scenes"][2]
    bothWays(texts(odd["files"])) do (pkg: ScenePackage):
      check pkg.appSourcesOf("", "data/immich") == odd["scene"]["apps"]["data/immich"]["sources"]
      check pkg.appSourcesOf("", "100%") == odd["scene"]["apps"]["100%"]["sources"]

  test "a set's scene folders, under the template's folder":
    let kase = fixtures["reads"][0]
    bothWays(texts(kase["files"])) do (pkg: ScenePackage):
      let scenes = pkg.packagedScenes()
      check scenes.len == 2
      check scenes[0].folder == "Weather and more/Weather"
      check pkg.appSourcesOf(scenes[0].folder, "weatherCard")["lib/icons.ts"].getStr().contains("metric")
