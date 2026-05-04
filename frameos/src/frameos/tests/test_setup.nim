import std/[json, os, sequtils, strutils, times]
import zippy
import ../device_setup
import ../setup

block test_app_apt_packages_from_scene_nodes:
  let scenes = parseJson("""[
    {
      "apps": {
        "repo/custom": {
          "sources": {
            "config.json": "{\"name\":\"Custom\",\"apt\":[\"custom-pkg\",\"ffmpeg\"]}"
          }
        }
      },
      "nodes": [
        {
          "type": "app",
          "data": {"keyword": "data/rstpSnapshot", "config": {}}
        },
        {
          "type": "app",
          "data": {"keyword": "repo/custom", "config": {}}
        },
        {
          "type": "app",
          "data": {
            "keyword": "node/custom",
            "sources": {
              "config.json": "{\"name\":\"Node Custom\",\"apt\":[\"node-pkg\"]}"
            }
          }
        },
        {
          "type": "source",
          "sources": {
            "config.json": "{\"name\":\"Source Custom\",\"apt\":[\"source-pkg\"]}"
          }
        }
      ]
    }
  ]""")
  let apps = parseJson("""{
    "apps": {
      "data/rstpSnapshot": {"apt": ["ffmpeg"]},
      "render/image": {}
    }
  }""")

  doAssert appAptPackagesFromScenes(scenes, apps) == @[
    "ffmpeg",
    "custom-pkg",
    "node-pkg",
    "source-pkg",
  ]

block test_load_all_scenes_prefers_full_scene_payload:
  let tempRoot = getTempDir() / ("frameos-all-scenes-" & $epochTime().int64)
  createDir(tempRoot)
  let setupPath = tempRoot / "all_scenes.json.gz"
  let fallbackPath = tempRoot / "scenes.json"
  writeFile(setupPath, compress("""[{"id":"all-scenes","nodes":[]}]""", dataFormat = dfGzip))
  writeFile(fallbackPath, """[{"id":"fallback-scenes","nodes":[]}]""")
  putEnv("FRAMEOS_ALL_SCENES_JSON", setupPath)
  putEnv("FRAMEOS_SCENES_JSON", fallbackPath)
  try:
    let payload = loadAllScenesPayload()
    doAssert payload.kind == JArray
    doAssert payload[0]{"id"}.getStr() == "all-scenes"
  finally:
    delEnv("FRAMEOS_ALL_SCENES_JSON")
    delEnv("FRAMEOS_SCENES_JSON")
    removeDir(tempRoot)

block test_setup_apt_packages_installs_only_missing_packages:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("command -v 'apt-get'"):
      return ("", 0)
    if command.contains("dpkg-query") and command.contains("'already-installed'"):
      return ("", 0)
    if command.contains("dpkg-query"):
      return ("", 1)
    return ("", 0)
  )
  try:
    let setupResult = setupAptPackages(@["ffmpeg", "already-installed", "ffmpeg"])
    doAssert not setupResult.rebootRequired
    let installCommands = commands.filterIt(it.contains("apt-get install"))
    doAssert installCommands.len == 1
    doAssert installCommands[0].contains("'ffmpeg'")
    doAssert not installCommands[0].contains("'already-installed'")
  finally:
    resetSetupCommandRunnerForTest()
