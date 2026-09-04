import std/[json, os, sequtils, strutils, times]
import zippy
import ../device_setup
import ../privileged
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

block test_timezone_keeps_etc_timezone_in_step:
  # /etc/localtime is systemd's to write; /etc/timezone is the plain-text copy
  # `lib/tz.nim` falls back to, and only the no-timedatectl branch used to
  # touch it — so every systemd frame kept the image's zone there (uus2w on
  # 2026.9.7 said Etc/UTC while /etc/localtime said Europe/Brussels). Whatever
  # branch sets the zone, this file follows.
  let tzPath = getTempDir() / ("frameos-etc-timezone-" & $epochTime().int64)
  writeFile(tzPath, "Etc/UTC\n")
  putEnv("FRAMEOS_ETC_TIMEZONE", tzPath)
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult = ("", 0))
  try:
    discard setupTimezone("Pacific/Auckland")
    doAssert readFile(tzPath).strip() == "Pacific/Auckland", readFile(tzPath)
  finally:
    resetSetupCommandRunnerForTest()
    delEnv("FRAMEOS_ETC_TIMEZONE")
    removeFile(tzPath)

block test_timezone_leaves_a_missing_etc_timezone_alone:
  # A system that keeps no /etc/timezone does not get one invented for it.
  let tzPath = getTempDir() / ("frameos-etc-timezone-absent-" & $epochTime().int64)
  removeFile(tzPath)
  putEnv("FRAMEOS_ETC_TIMEZONE", tzPath)
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult = ("", 0))
  try:
    discard setupTimezone("Pacific/Auckland")
    doAssert not fileExists(tzPath)
  finally:
    resetSetupCommandRunnerForTest()
    delEnv("FRAMEOS_ETC_TIMEZONE")

block test_timezone_goes_through_the_door_when_it_is_available:
  # The zone must differ from this machine's and exist in /usr/share/zoneinfo,
  # or setupTimezone returns before it would ever ask anyone.
  var commands: seq[string] = @[]
  var doorRequests: seq[PrivilegedRequest] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  setPrivilegedRequestHookForTest(proc(request: PrivilegedRequest): PrivilegedResult {.gcsafe.} =
    {.gcsafe.}:
      doorRequests.add(request)
    privilegedOk("Pacific/Auckland"))
  try:
    doAssert privilegedDoorAvailable(), "the hook forces the door on"
    discard setupTimezone("Pacific/Auckland")
    doAssert doorRequests.len == 1, $doorRequests.len
    doAssert doorRequests[0].verb == pvSetTimezone
    doAssert doorRequests[0].args["zone"].getStr() == "Pacific/Auckland"
    doAssert not commands.anyIt(it.contains("timedatectl")), "never sudo from the runtime: " & $commands
    doAssert not commands.anyIt(it.contains("/etc/localtime")), $commands
  finally:
    resetPrivilegedRequestHookForTest()
    resetSetupCommandRunnerForTest()

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

block test_schedule_setup_reboot_only_when_setup_requires_it:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    doAssert not scheduleSetupRebootIfRequired(setupOk(), "FrameOS driver setup", delaySeconds = 7)
    doAssert commands.len == 0

    doAssert scheduleSetupRebootIfRequired(setupNeedsReboot(), "FrameOS driver setup", delaySeconds = 7)
    doAssert commands.len == 1
    doAssert commands[0].contains("sleep 7")
    doAssert commands[0].contains("systemctl reboot || reboot")
  finally:
    resetSetupCommandRunnerForTest()

block test_frameos_service_contents_uses_detected_user:
  let service = frameosServiceContents("frame-user")

  doAssert service.contains("Description=FrameOS Service")
  doAssert service.contains("User=frame-user")
  doAssert service.contains("WorkingDirectory=/srv/frameos/current")
  doAssert service.contains("ExecStart=/srv/frameos/current/frameos")
  doAssert service.contains("RestartSec=5")
  doAssert service.contains("ExecStopPost=-+/bin/sh -lc 'mkdir -p /srv/frameos/runtime")
  doAssert service.contains("/srv/frameos/runtime/frameos-last-exit")
  # systemd expands a bare %s in ExecStopPost= to the user's shell, which
  # made every reboot reason read "/bin/sh"; the printf specifiers must be %%s.
  doAssert service.contains("printf \"serviceResult=%%s\\nexitCode=%%s\\nexitStatus=%%s\\n\"")
  doAssert not service.contains("serviceResult=%s")
  doAssert not service.contains("StandardOutput=journal+console")
  doAssert not service.contains("StandardError=journal+console")

block test_frameos_service_contents_can_mirror_logs_to_console:
  let service = frameosServiceContents("root", consoleOutput = true)

  doAssert service.contains("StandardOutput=journal+console")
  doAssert service.contains("StandardError=journal+console")

block test_frameos_service_contents_claims_tty_for_framebuffer:
  let service = frameosServiceContents("frame-user", framebufferConsole = true)

  doAssert service.contains("After=network.target getty@tty1.service")
  doAssert service.contains("Conflicts=getty@tty1.service")
  doAssert service.contains("TTYPath=/dev/tty1")
  doAssert service.contains("StandardInput=tty-force")
  doAssert service.contains("TTYReset=yes")
  doAssert service.contains(
    "ExecStopPost=-+/bin/systemd-run --quiet --collect --on-active=10 /bin/sh -lc '/bin/systemctl show -p ActiveState --value frameos.service 2>/dev/null | /bin/grep -xq -e active -e activating -e reloading && exit 0; /bin/systemctl reset-failed getty@tty1.service; /bin/systemctl start getty@tty1.service'")
  doAssert not service.contains("--on-active=3 /bin/systemctl reset-failed getty@tty1.service")
  doAssert not service.contains("--on-active=4 /bin/systemctl start getty@tty1.service")
  doAssert not service.contains("python3 -c")
  doAssert not service.contains("TTYVHangup=yes")
  doAssert not service.contains("TTYVTDisallocate=yes")
  doAssert not service.contains("StandardOutput=journal+console")

block test_service_memory_limits_leave_a_fixed_os_reserve:
  # Unknown total falls back to generous percentages
  doAssert serviceMemoryLimits(0) == (high: "80%", max: "90%")

  # Pi Zero 2 W class: 416MB usable -> reserve 52MB, cap near the edge
  let zero2w = serviceMemoryLimits(416 * 1024)
  doAssert zero2w.max == $(416 * 1024 - 52 * 1024) & "K"
  doAssert zero2w.high == $(416 * 1024 - 52 * 1024 - (416 * 1024 - 52 * 1024) div 16) & "K"

  # Tiny 128MB-class device: reserve is floored at 40MB
  doAssert serviceMemoryLimits(128 * 1024).max == $(128 * 1024 - 40 * 1024) & "K"

  # Big device: reserve is capped at 256MB
  doAssert serviceMemoryLimits(8 * 1024 * 1024).max == $(8 * 1024 * 1024 - 256 * 1024) & "K"

  # Degenerate totals never produce a non-positive cap
  doAssert serviceMemoryLimits(16 * 1024).max == $(32 * 1024) & "K"

block test_frameos_service_contents_embed_memory_limits:
  let service = frameosServiceContents("frame-user", memTotalKb = 416 * 1024)
  doAssert service.contains("MemoryMax=" & $(416 * 1024 - 52 * 1024) & "K")
  doAssert service.contains("MemoryHigh=")
  doAssert service.contains("MemorySwapMax=64M")
  doAssert service.contains("WatchdogSec=900")
  doAssert service.contains("Type=notify")

block test_frameos_service_user_prefers_explicit_setup_user:
  let previousServiceUser = getEnv("FRAMEOS_SERVICE_USER")
  putEnv("FRAMEOS_SERVICE_USER", "frame-user")
  try:
    doAssert frameosServiceUser() == "frame-user"
  finally:
    if previousServiceUser.len > 0:
      putEnv("FRAMEOS_SERVICE_USER", previousServiceUser)
    else:
      delEnv("FRAMEOS_SERVICE_USER")

block test_cgroup_indicates_remote_service:
  doAssert cgroupIndicatesRemoteService("0::/system.slice/frameos-remote.service\n")
  doAssert cgroupIndicatesRemoteService("0::/system.slice/frameos_agent.service\n")
  doAssert cgroupIndicatesRemoteService("0::/system.slice/frameos-agent.service\n")
  doAssert cgroupIndicatesRemoteService(
    "12:pids:/system.slice/frameos-remote.service\n1:name=systemd:/system.slice/frameos-remote.service\n")
  doAssert not cgroupIndicatesRemoteService("0::/system.slice/frameos.service\n")
  doAssert not cgroupIndicatesRemoteService("0::/user.slice/user-1000.slice/session-4.scope\n")
  doAssert not cgroupIndicatesRemoteService("")

block test_running_under_frameos_remote_honors_setup_env:
  let previousSetupUnderRemote = getEnv("FRAMEOS_SETUP_UNDER_REMOTE")
  let previousSetupUnderAgent = getEnv("FRAMEOS_SETUP_UNDER_AGENT")
  putEnv("FRAMEOS_SETUP_UNDER_REMOTE", "1")
  try:
    doAssert runningUnderFrameosRemote()
  finally:
    if previousSetupUnderRemote.len > 0:
      putEnv("FRAMEOS_SETUP_UNDER_REMOTE", previousSetupUnderRemote)
    else:
      delEnv("FRAMEOS_SETUP_UNDER_REMOTE")

  putEnv("FRAMEOS_SETUP_UNDER_AGENT", "1")
  try:
    doAssert runningUnderFrameosRemote()
  finally:
    if previousSetupUnderAgent.len > 0:
      putEnv("FRAMEOS_SETUP_UNDER_AGENT", previousSetupUnderAgent)
    else:
      delEnv("FRAMEOS_SETUP_UNDER_AGENT")

block test_system_hardening_defers_live_changes_when_not_live_applying:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    discard setupSystemHardening(liveApply = false)

    doAssert not commands.anyIt(it.contains("daemon-reexec"))
    doAssert not commands.anyIt(it.contains("reload NetworkManager"))
    doAssert not commands.anyIt(it.contains("iw dev"))
  finally:
    resetSetupCommandRunnerForTest()

block test_system_hardening_skips_networkmanager_config_without_the_unit:
  # /etc/NetworkManager exists even on images without NetworkManager (it is a
  # bind-mount point on buildroot), so the powersave config must additionally
  # be gated on the systemd unit being present.
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("systemctl cat NetworkManager.service"):
      ("", 1)
    else:
      ("", 0)
  )
  try:
    discard setupSystemHardening(liveApply = true)

    doAssert not commands.anyIt(it.contains("wifi-powersave-off"))
    doAssert not commands.anyIt(it.contains("reload NetworkManager"))
  finally:
    resetSetupCommandRunnerForTest()

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

block test_write_setup_release_payload_updates_remote_frame_config:
  let tempRoot = getTempDir() / ("frameos-setup-payload-" & $epochTime().int64)
  let frameosCurrent = tempRoot / "current"
  let remoteCurrent = tempRoot / "remote" / "current"
  let setupPath = tempRoot / "frameos-setup.json"
  createDir(frameosCurrent)
  createDir(remoteCurrent)
  writeFile(remoteCurrent / "frame.json", pretty(%*{
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
    writeSetupReleasePayload(setupPath, frameosCurrent, remoteCurrent)

    let runtimeConfigJson = readFile(frameosCurrent / "frame.json")
    let remoteConfigJson = readFile(remoteCurrent / "frame.json")
    doAssert remoteConfigJson == runtimeConfigJson
    # frame.json holds the API key and service tokens: owner-only on both
    # copies, including the remote one that existed (world-readable) before.
    doAssert getFilePermissions(frameosCurrent / "frame.json") == {fpUserRead, fpUserWrite}
    doAssert getFilePermissions(remoteCurrent / "frame.json") == {fpUserRead, fpUserWrite}
    let runtimeConfig = parseJson(runtimeConfigJson)
    let remoteConfig = parseJson(remoteConfigJson)
    let allScenes = parseJson(uncompress(readFile(frameosCurrent / "all_scenes.json.gz"), dataFormat = dfGzip))
    let interpretedScenes = parseJson(uncompress(readFile(frameosCurrent / "scenes.json.gz"), dataFormat = dfGzip))

    doAssert runtimeConfig{"serverHost"}.getStr() == "backend.frameos.local"
    doAssert remoteConfig{"serverHost"}.getStr() == "backend.frameos.local"
    doAssert remoteConfig{"serverPort"}.getInt() == 443
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
    # agentEnabled alone no longer starts frameos-remote.service on a
    # Buildroot frame: generic images do not ship the remote at all, so the
    # unit is only started where an image (or a backend deploy) installed it
    # under /srv/frameos/remote/current — which this test host lacks.
    doAssert commands.anyIt(it.contains("systemctl --no-block start frameos.service") and
      not it.contains("frameos-remote.service"))
    doAssert not commands.anyIt(
      it.contains("systemctl start frameos.service") and
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

block test_mount_point_for_path_finds_the_longest_matching_mount:
  # A Buildroot frame: read-only rootfs, the writable data partition on top.
  const mounts = """/dev/root / ext4 ro,relatime 0 0
devtmpfs /dev devtmpfs rw,nosuid 0 0
/dev/mmcblk0p3 /srv/frameos ext4 rw,noatime 0 0
/dev/mmcblk0p1 /boot vfat rw,noatime,umask=077 0 0
"""

  doAssert mountPointForPath(mounts, "/etc/systemd/system/frameos.service") == ("/", true)
  doAssert mountPointForPath(mounts, "/srv/frameos/logs/upgrade.log") == ("/srv/frameos", false)
  doAssert mountPointForPath(mounts, "/boot/config.txt") == ("/boot", false)
  # /srv is on the rootfs; only /srv/frameos is not. Prefix matching must be
  # per path component, or "/srv/frameos-backup" would resolve to /srv/frameos.
  doAssert mountPointForPath(mounts, "/srv/frameos-backup/x") == ("/", true)
  doAssert mountPointForPath(mounts, "relative/path") == ("", false)

block test_mount_point_for_path_handles_escapes_and_overmounts:
  const mounts = """/dev/root / ext4 rw,relatime 0 0
/dev/sda1 /mnt/my\040share ext4 ro,relatime 0 0
/dev/sdb1 /mnt/over ext4 rw 0 0
/dev/sdc1 /mnt/over ext4 ro 0 0
"""

  doAssert mountPointForPath(mounts, "/mnt/my share/file") == ("/mnt/my share", true)
  # Last mount of the same point wins: that is what an overmount does.
  doAssert mountPointForPath(mounts, "/mnt/over/file") == ("/mnt/over", true)
  # "rw" must not match a mount whose options merely contain the letters.
  doAssert mountPointForPath("/dev/root / ext4 rw,errors=remount-ro 0 0\n", "/etc/x") == ("/", false)

block test_writable_mount_remounts_a_read_only_root_and_restores_it:
  let mountsPath = getTempDir() / ("frameos-mounts-" & $epochTime().int64)
  writeFile(mountsPath, "/dev/root / ext4 ro,relatime 0 0\n")
  putEnv("FRAMEOS_PROC_MOUNTS", mountsPath)
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    withWritableMount("/etc/systemd/system/frameos.service"):
      commands.add("<body>")

    doAssert commands.len == 4
    doAssert commands[0].endsWith("mount -o remount,rw '/'")
    doAssert commands[1] == "<body>"
    doAssert commands[2].endsWith("sync")
    doAssert commands[3].endsWith("mount -o remount,ro '/'")
  finally:
    resetSetupCommandRunnerForTest()
    delEnv("FRAMEOS_PROC_MOUNTS")
    removeFile(mountsPath)

block test_writable_mount_restores_the_mount_when_the_body_raises:
  let mountsPath = getTempDir() / ("frameos-mounts-raise-" & $epochTime().int64)
  writeFile(mountsPath, "/dev/root / ext4 ro,relatime 0 0\n")
  putEnv("FRAMEOS_PROC_MOUNTS", mountsPath)
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    var raised = false
    try:
      withWritableMount("/etc/timezone"):
        raise newException(OSError, "boom")
    except OSError:
      raised = true
    doAssert raised
    doAssert commands.len == 3
    doAssert commands[2].endsWith("mount -o remount,ro '/'")
  finally:
    resetSetupCommandRunnerForTest()
    delEnv("FRAMEOS_PROC_MOUNTS")
    removeFile(mountsPath)

block test_writable_mount_is_a_no_op_on_a_writable_filesystem:
  let mountsPath = getTempDir() / ("frameos-mounts-rw-" & $epochTime().int64)
  writeFile(mountsPath, "/dev/root / ext4 rw,relatime 0 0\n")
  putEnv("FRAMEOS_PROC_MOUNTS", mountsPath)
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    withWritableMount("/etc/systemd/system/frameos.service"):
      discard
    doAssert commands.len == 0
  finally:
    resetSetupCommandRunnerForTest()
    delEnv("FRAMEOS_PROC_MOUNTS")
    removeFile(mountsPath)

block test_writable_mount_leaves_the_mount_alone_when_the_remount_fails:
  # A frame where the remount is refused must still attempt the write, so the
  # caller reports the real EROFS error instead of a remount failure.
  let mountsPath = getTempDir() / ("frameos-mounts-fail-" & $epochTime().int64)
  writeFile(mountsPath, "/dev/root / ext4 ro,relatime 0 0\n")
  putEnv("FRAMEOS_PROC_MOUNTS", mountsPath)
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("remount,rw"):
      return ("mount: permission denied", 1)
    ("", 0)
  )
  try:
    withWritableMount("/etc/systemd/system/frameos.service"):
      commands.add("<body>")
    doAssert commands.len == 2
    doAssert commands[1] == "<body>"
    doAssert not commands.anyIt(it.contains("remount,ro"))
  finally:
    resetSetupCommandRunnerForTest()
    delEnv("FRAMEOS_PROC_MOUNTS")
    removeFile(mountsPath)

block test_dropin_turns_dnssec_off:
  doAssert dropinTurnsDnssecOff("[Resolve]\nDNSSEC=no\n")
  doAssert dropinTurnsDnssecOff("# comment\n[Resolve]\n  DNSSEC=no  \n")
  doAssert not dropinTurnsDnssecOff("")
  doAssert not dropinTurnsDnssecOff("[Resolve]\nDNSSEC=allow-downgrade\n")
  doAssert not dropinTurnsDnssecOff("# DNSSEC=no is what we want but never wrote\nDNSSEC=yes\n")

block test_resolved_dnssec_writes_dropin_and_restarts_resolved:
  let dropinDir = getTempDir() / ("frameos-resolved-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    discard setupResolvedDnssec(liveApply = true, dropinPath = dropinPath)
    doAssert fileExists(dropinPath)
    doAssert dropinTurnsDnssecOff(readFile(dropinPath))
    doAssert commands.anyIt(it.contains("try-restart systemd-resolved"))

    # Idempotent: a second run must neither rewrite nor restart.
    commands = @[]
    discard setupResolvedDnssec(liveApply = true, dropinPath = dropinPath)
    doAssert not commands.anyIt(it.contains("try-restart"))
    doAssert not commands.anyIt(it.contains("install -d"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_resolved_dnssec_defers_restart_when_not_live_applying:
  let dropinDir = getTempDir() / ("frameos-resolved-defer-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    discard setupResolvedDnssec(liveApply = false, dropinPath = dropinPath)
    doAssert fileExists(dropinPath)
    doAssert not commands.anyIt(it.contains("try-restart"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_resolved_dnssec_skips_when_resolved_is_not_active:
  let dropinDir = getTempDir() / ("frameos-resolved-inactive-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("is-active --quiet systemd-resolved"):
      return ("", 3)
    ("", 0)
  )
  try:
    discard setupResolvedDnssec(liveApply = true, dropinPath = dropinPath)
    doAssert not fileExists(dropinPath)
    doAssert not commands.anyIt(it.contains("try-restart"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_network_service_guard_writes_dropin_and_restarts_only_failed_unit:
  let dropinDir = getTempDir() / ("frameos-netguard-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    # network.service present and failed -> drop-in + daemon-reload + restart
    discard setupNetworkServiceEth0Guard(liveApply = true, dropinPath = dropinPath)
    doAssert fileExists(dropinPath)
    doAssert readFile(dropinPath).contains("/sys/class/net/eth0")
    doAssert commands.anyIt(it.contains("daemon-reload"))
    doAssert commands.anyIt(it.contains("restart network.service"))

    # Idempotent on the second pass.
    commands = @[]
    discard setupNetworkServiceEth0Guard(liveApply = true, dropinPath = dropinPath)
    doAssert not commands.anyIt(it.contains("daemon-reload"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_network_service_guard_does_not_restart_a_healthy_unit:
  # On an Ethernet board (Pi 1 B/B+) network.service is active and carries the
  # deploy's own link; restarting it would ifdown eth0 mid-deploy.
  let dropinDir = getTempDir() / ("frameos-netguard-healthy-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("is-failed --quiet network.service"):
      return ("", 1)
    ("", 0)
  )
  try:
    discard setupNetworkServiceEth0Guard(liveApply = true, dropinPath = dropinPath)
    doAssert fileExists(dropinPath)
    doAssert commands.anyIt(it.contains("daemon-reload"))
    doAssert not commands.anyIt(it.contains("restart network.service"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_persistent_state_mounts_are_added_once_and_mounted_live:
  # The read-only rootfs left NetworkManager's dnsmasq and timesyncd with no
  # writable state (2026-09-04): both directories get a bind mount onto the
  # persistent partition, written to fstab once and mounted right away.
  let root = getTempDir() / ("frameos-statemounts-" & $epochTime().int64)
  createDir(root)
  let fstabPath = root / "fstab"
  writeFile(fstabPath, "LABEL=BOOT /boot vfat defaults,noatime,umask=077 0 0\n" &
    "/srv/frameos/state/NetworkManager/system-connections /etc/NetworkManager/system-connections none bind 0 0\n")
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("mountpoint -q"):
      return ("", 1) # not mounted yet
    ("", 0)
  )
  try:
    discard setupPersistentStateMounts(liveApply = true, fstabPath = fstabPath)
    let fstab = readFile(fstabPath)
    doAssert fstab.contains("/srv/frameos/state/NetworkManager/var-lib /var/lib/NetworkManager none bind,nofail,")
    doAssert fstab.contains("/srv/frameos/state/timesync /var/lib/systemd/timesync none bind,nofail,")
    doAssert fstab.contains("x-systemd.before=NetworkManager.service"), "the mount must precede NetworkManager"
    doAssert fstab.contains("x-systemd.before=systemd-timesyncd.service")
    doAssert fstab.startsWith("LABEL=BOOT"), "existing lines are kept"
    doAssert commands.anyIt(it.contains("install -d -m 700 '/srv/frameos/state/NetworkManager/var-lib'"))
    doAssert commands.anyIt(it.contains("chown 'systemd-timesync:systemd-timesync' '/srv/frameos/state/timesync'"))
    doAssert commands.anyIt(it.contains("mount --bind '/srv/frameos/state/NetworkManager/var-lib' '/var/lib/NetworkManager'"))
    doAssert commands.anyIt(it.contains("mount --bind '/srv/frameos/state/timesync' '/var/lib/systemd/timesync'"))
    doAssert commands.anyIt(it.contains("daemon-reload"))

    # Idempotent: a second pass neither rewrites fstab nor mounts again.
    commands = @[]
    let before = readFile(fstabPath)
    discard setupPersistentStateMounts(liveApply = true, fstabPath = fstabPath)
    doAssert readFile(fstabPath) == before
    doAssert not commands.anyIt(it.contains("mount --bind"))
    doAssert before.count("/var/lib/NetworkManager none") == 1
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(root)

block test_persistent_state_mounts_defer_when_not_live:
  let root = getTempDir() / ("frameos-statemounts-deferred-" & $epochTime().int64)
  createDir(root)
  let fstabPath = root / "fstab"
  writeFile(fstabPath, "")
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    discard setupPersistentStateMounts(liveApply = false, fstabPath = fstabPath)
    doAssert readFile(fstabPath).contains("/var/lib/NetworkManager none bind")
    doAssert not commands.anyIt(it.contains("mount --bind"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(root)

block test_dropbear_host_key_dropin_installs_and_restarts_only_a_failed_unit:
  let dropinDir = getTempDir() / ("frameos-dropbear-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos-hostkey.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    ("", 0)
  )
  try:
    # dropbear.service present and failed (no host key on a ro root) ->
    # drop-in + daemon-reload + restart.
    discard setupDropbearHostKey(liveApply = true, dropinPath = dropinPath)
    doAssert fileExists(dropinPath)
    let dropin = readFile(dropinPath)
    doAssert dropin.contains("RequiresMountsFor=/srv/frameos")
    doAssert dropin.contains("dropbearkey -t ed25519 -f /srv/frameos/state/dropbear/dropbear_ed25519_host_key")
    doAssert dropin.contains("ExecStart=/usr/sbin/dropbear -F -r /srv/frameos/state/dropbear/dropbear_ed25519_host_key $DROPBEAR_ARGS")
    doAssert commands.anyIt(it.contains("daemon-reload"))
    doAssert commands.anyIt(it.contains("restart dropbear.service"))

    # Idempotent on the second pass.
    commands = @[]
    discard setupDropbearHostKey(liveApply = true, dropinPath = dropinPath)
    doAssert not commands.anyIt(it.contains("daemon-reload"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_dropbear_host_key_dropin_does_not_cut_a_running_sshd:
  # A restart kills every SSH session in dropbear's control group, the
  # deploy's own included: a healthy unit is left alone until the next boot.
  let dropinDir = getTempDir() / ("frameos-dropbear-healthy-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos-hostkey.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("is-failed --quiet dropbear.service"):
      return ("", 1)
    ("", 0)
  )
  try:
    discard setupDropbearHostKey(liveApply = true, dropinPath = dropinPath)
    doAssert fileExists(dropinPath)
    doAssert commands.anyIt(it.contains("daemon-reload"))
    doAssert not commands.anyIt(it.contains("restart dropbear.service"))
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_dropbear_host_key_dropin_skips_without_the_unit:
  let dropinDir = getTempDir() / ("frameos-dropbear-absent-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos-hostkey.conf"
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    if command.contains("systemctl cat dropbear.service"):
      return ("", 1)
    ("", 0)
  )
  try:
    discard setupDropbearHostKey(liveApply = true, dropinPath = dropinPath)
    doAssert not fileExists(dropinPath)
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)

block test_network_service_guard_skips_without_the_unit:
  let dropinDir = getTempDir() / ("frameos-netguard-absent-" & $epochTime().int64)
  createDir(dropinDir)
  let dropinPath = dropinDir / "10-frameos.conf"
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("systemctl cat network.service"):
      return ("", 1)
    ("", 0)
  )
  try:
    discard setupNetworkServiceEth0Guard(liveApply = true, dropinPath = dropinPath)
    doAssert not fileExists(dropinPath)
  finally:
    resetSetupCommandRunnerForTest()
    removeDir(dropinDir)
