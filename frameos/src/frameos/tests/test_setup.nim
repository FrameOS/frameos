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

block test_frameos_service_contents_uses_detected_user:
  let service = frameosServiceContents("frame-user")

  doAssert service.contains("Description=FrameOS Service")
  doAssert service.contains("User=frame-user")
  doAssert service.contains("WorkingDirectory=/srv/frameos/current")
  doAssert service.contains("ExecStart=/srv/frameos/current/frameos")
  doAssert not service.contains("StandardOutput=journal+console")
  doAssert not service.contains("StandardError=journal+console")

block test_frameos_service_contents_can_mirror_logs_to_console:
  let service = frameosServiceContents("root", consoleOutput = true)

  doAssert service.contains("StandardOutput=journal+console")
  doAssert service.contains("StandardError=journal+console")

block test_write_frame_config_dimensions_persists_detected_size:
  let path = getTempDir() / ("frameos-dimensions-" & $epochTime().int64 & ".json")
  writeFile(path, pretty(%*{
    "name": "HDMI",
    "device": "framebuffer",
    "width": 1920,
    "height": 1080,
  }, indent = 4) & "\n")

  try:
    let changed = writeFrameConfigDimensions(path, FrameConfig(width: 1280, height: 720))
    let payload = parseJson(readFile(path))

    doAssert changed
    doAssert payload{"width"}.getInt() == 1280
    doAssert payload{"height"}.getInt() == 720
    doAssert payload{"device"}.getStr() == "framebuffer"
  finally:
    if fileExists(path):
      removeFile(path)

block test_write_setup_release_payload_updates_agent_frame_config:
  let tempRoot = getTempDir() / ("frameos-setup-payload-" & $epochTime().int64)
  let frameosCurrent = tempRoot / "current"
  let agentCurrent = tempRoot / "agent" / "current"
  let setupPath = tempRoot / "frameos-setup.json"
  createDir(frameosCurrent)
  createDir(agentCurrent)
  writeFile(agentCurrent / "frame.json", pretty(%*{
    "serverHost": "localhost",
    "serverPort": 8989,
  }, indent = 4) & "\n")
  writeFile(setupPath, pretty(%*{
    "serverHost": "backend.frameos.local",
    "serverPort": 443,
    "scenes": [
      {
        "id": "interpreted-scene",
        "settings": {"execution": "interpreted"}
      },
      {
        "id": "compiled-scene",
        "settings": {"execution": "compiled"}
      }
    ],
  }, indent = 4) & "\n")

  try:
    writeSetupReleasePayload(setupPath, frameosCurrent, agentCurrent)

    let runtimeConfigJson = readFile(frameosCurrent / "frame.json")
    let agentConfigJson = readFile(agentCurrent / "frame.json")
    doAssert agentConfigJson == runtimeConfigJson
    let runtimeConfig = parseJson(runtimeConfigJson)
    let agentConfig = parseJson(agentConfigJson)
    let allScenes = parseJson(uncompress(readFile(frameosCurrent / "all_scenes.json.gz"), dataFormat = dfGzip))
    let interpretedScenes = parseJson(uncompress(readFile(frameosCurrent / "scenes.json.gz"), dataFormat = dfGzip))

    doAssert runtimeConfig{"serverHost"}.getStr() == "backend.frameos.local"
    doAssert agentConfig{"serverHost"}.getStr() == "backend.frameos.local"
    doAssert agentConfig{"serverPort"}.getInt() == 443
    doAssert allScenes.len == 2
    doAssert interpretedScenes.len == 1
    doAssert interpretedScenes[0]{"id"}.getStr() == "interpreted-scene"
  finally:
    if dirExists(tempRoot):
      removeDir(tempRoot)

block test_release_activation_switches_staged_release_current_symlink:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    let setupResult = setupReleaseActivation("/srv/frameos/releases/release_build123")

    doAssert not setupResult.rebootRequired
    doAssert commands == @[
      "mkdir -p /srv/frameos/state",
      "rm -rf '/srv/frameos/releases/release_build123/state' && ln -s /srv/frameos/state '/srv/frameos/releases/release_build123/state'",
      "rm -rf /srv/frameos/current && ln -s '/srv/frameos/releases/release_build123' /srv/frameos/current",
    ]
  finally:
    resetSetupCommandRunnerForTest()

block test_release_activation_does_not_repoint_current_when_running_current_release:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    let setupResult = setupReleaseActivation("/srv/frameos/current")

    doAssert not setupResult.rebootRequired
    doAssert commands == @[
      "mkdir -p /srv/frameos/state",
      "rm -rf '/srv/frameos/current/state' && ln -s /srv/frameos/state '/srv/frameos/current/state'",
    ]
  finally:
    resetSetupCommandRunnerForTest()

block test_first_boot_service_start_is_non_blocking:
  let path = getTempDir() / ("frameos-start-services-" & $epochTime().int64 & ".json")
  writeFile(path, pretty(%*{
    "mode": "buildroot",
    "device": "framebuffer",
    "agent": {"agentEnabled": true},
  }, indent = 4) & "\n")

  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    startFrameOSSystemdServices(path)

    doAssert commands.anyIt(it.contains("command -v 'systemctl'"))
    doAssert commands.anyIt(it.contains("systemctl --no-block start frameos.service frameos_agent.service"))
    doAssert not commands.anyIt(
      it.contains("systemctl start frameos.service frameos_agent.service") and
        not it.contains("--no-block")
    )
  finally:
    resetSetupCommandRunnerForTest()
    if fileExists(path):
      removeFile(path)

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
