import std/[json, os, sequtils, strutils, times]
import zippy
import ../device_setup
import ../samba_mounts
import ../setup
import ../types

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

block test_samba_mounts_fstab_block_uses_credentials_and_options:
  let mountpoints = MountpointsConfig(enabled: true, items: @[
    MountpointConfig(
      enabled: true,
      source: "//nas/photos",
      target: "/mnt/frame photos",
      username: "frame",
      password: "secret",
      options: "uid=pi,gid=pi,bad option,#ignored",
    )
  ])
  let fstabBlock = frameosFstabBlock(mountpoints, "/tmp/frameos-samba")

  doAssert fstabBlock.contains(frameosFstabBegin)
  doAssert fstabBlock.contains("//nas/photos /mnt/frame\\040photos cifs")
  doAssert fstabBlock.contains("credentials=/tmp/frameos-samba/mount-1.credentials")
  doAssert fstabBlock.contains("iocharset=utf8")
  doAssert fstabBlock.contains("x-systemd.automount")
  doAssert fstabBlock.contains("uid=pi")
  doAssert fstabBlock.contains("gid=pi")
  doAssert not fstabBlock.contains("bad option")
  doAssert not fstabBlock.contains("secret")

block test_samba_mounts_fstab_block_uses_guest_without_credentials:
  let mountpoints = MountpointsConfig(enabled: true, items: @[
    MountpointConfig(enabled: true, source: "//nas/public", target: "/mnt/public"),
  ])
  let fstabBlock = frameosFstabBlock(mountpoints)

  doAssert fstabBlock.contains("guest")
  doAssert not fstabBlock.contains("credentials=")

block test_samba_mounts_replaces_and_removes_managed_fstab_block:
  let oldFstab = "rootfs / ext4 defaults 0 1\n\n" &
    frameosFstabBegin & "\n" &
    "//old/share /mnt/old\\040share cifs guest 0 0\n" &
    frameosFstabEnd & "\n"
  let mountpoints = MountpointsConfig(enabled: true, items: @[
    MountpointConfig(enabled: true, source: "//new/share", target: "/mnt/new"),
  ])
  let replaced = applyFrameosFstabBlock(oldFstab, frameosFstabBlock(mountpoints))

  doAssert replaced.changed
  doAssert replaced.content.contains("rootfs / ext4 defaults 0 1")
  doAssert replaced.content.contains("//new/share /mnt/new cifs")
  doAssert not replaced.content.contains("//old/share")
  doAssert extractFrameosMountTargets(oldFstab) == @["/mnt/old share"]

  let removed = applyFrameosFstabBlock(replaced.content, "")
  doAssert removed.changed
  doAssert not removed.content.contains(frameosFstabBegin)

block test_samba_mount_failures_do_not_raise:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("mount -a -t cifs"):
      return ("mount error: could not resolve address for server", 32)
    ("", 0)
  )
  try:
    doAssert not mountSambaFstabEntries()
    doAssert commands.anyIt(it.contains("mount -a -t cifs"))
  finally:
    resetSetupCommandRunnerForTest()
