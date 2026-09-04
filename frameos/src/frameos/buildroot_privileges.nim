## Buildroot privilege separation: `frameos.service` runs as the `frameos`
## user, root work goes through the privileged door (frameos/privileged.nim).
##
## This module owns everything `frameos setup` does to get a Buildroot frame
## into — or keep it in — that state:
##
## - render the hardened unit (byte-identical to what
##   backend/app/tasks/buildroot_image.py composes into a fresh image, from
##   the same template files under frameos/),
## - decide which user the unit runs as (`buildrootServiceUser`),
## - create the user and group on a frame that predates them (an OTA from a
##   root-only release lands here),
## - lay out /srv/frameos so root owns the code and `frameos` owns the state,
## - install and enable the door's .path/.service units and the udev rule.
##
## Everything here runs as root: from the first-boot service, from the
## privileged worker (`apply-driver-setup`, `install-release`) or from a root
## runtime on a not-yet-migrated frame.

import std/[os, strutils, times]
import frameos/device_setup
import frameos/types
import frameos/utils/system

const
  BuildrootServiceUser* = "frameos"
  ## Fixed, not allocated: the composed image, an OTA-created user and the
  ## ownership stamped into the FRAMEOS partition must all agree. 990 sits in
  ## Buildroot's system range (101..999) far above the handful of package
  ## users it allocates from 100 upwards (dbus, systemd-*).
  BuildrootServiceUid* = 990
  BuildrootServiceGid* = 990
  BuildrootServiceUserComment = "FrameOS runtime"
  BuildrootServiceUserHome = "/srv/frameos"
  BuildrootServiceUserShell = "/bin/false"

  BuildrootPrivilegedPathUnitName* = "frameos-privileged.path"
  BuildrootPrivilegedServiceUnitName* = "frameos-privileged.service"
  BuildrootDeviceUdevRulesName* = "60-frameos-devices.rules"

  ## The same files backend/app/tasks/buildroot_image.py reads at compose time.
  buildrootFrameosServiceTemplate = staticRead("../../frameos.service")
  buildrootUnprivilegedServiceBlock = staticRead("../../frameos.service.unprivileged")
  BuildrootPrivilegedPathUnit* = staticRead("../../frameos-privileged.path")
  BuildrootPrivilegedServiceUnit* = staticRead("../../frameos-privileged.service")
  BuildrootDeviceUdevRules* = staticRead("../../60-frameos-devices.rules")

  UnprivilegedServiceMarker = "__FRAMEOS_UNPRIVILEGED_SERVICE__"
  NetworkManagerUnitPaths = [
    "/usr/lib/systemd/system/NetworkManager.service",
    "/lib/systemd/system/NetworkManager.service",
  ]

# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

proc renderBuildrootFrameosService*(user: string, usesNetworkManager: bool): string =
  ## Keep in step with render_buildroot_frameos_service in
  ## backend/app/tasks/buildroot_image.py: same template, same three
  ## substitutions, so an upgrade compares equal against a composed image
  ## and never rewrites the read-only rootfs for nothing.
  result = buildrootFrameosServiceTemplate
  let unprivileged =
    if user == "root": ""
    else: buildrootUnprivilegedServiceBlock
  result = result.replace(UnprivilegedServiceMarker, unprivileged)
  result = result.replace("%I", user)
  if usesNetworkManager:
    let anchor = "After=network.target\n"
    let idx = result.find(anchor)
    if idx >= 0:
      result = result[0 ..< idx] &
        "Wants=NetworkManager.service\nAfter=network.target NetworkManager.service\n" &
        result[idx + anchor.len .. ^1]

proc buildrootUsesNetworkManager*(): bool =
  ## The armv6 image has no NetworkManager (its Kconfig deps do not resolve on
  ## ARM1176) and drives wpa_supplicant/hostapd itself; that orchestration is
  ## a root network daemon by nature and stays root.
  for path in NetworkManagerUnitPaths:
    if fileExists(path):
      return true
  false

proc installedServiceUser*(path = "/etc/systemd/system/frameos.service"): string =
  ## `User=` of the installed unit, "" when there is none.
  try:
    if fileExists(path):
      for line in readFile(path).splitLines():
        if line.startsWith("User="):
          return line["User=".len .. ^1].strip()
  except CatchableError:
    discard
  ""

proc buildrootServiceUser*(frameConfig: FrameConfig, installedUser: string,
                           usesNetworkManager: bool): string =
  ## Which user a Buildroot frameos.service runs as.
  ##
  ## Generic images — standalone or FrameOS Cloud frames, which only ever
  ## install signed releases — run as `frameos`. A frame a self-hosted
  ## backend manages keeps whatever its unit says (root, in practice): the
  ## backend deploys unsigned custom builds over SSH/Remote as root and
  ## writes release directories as root, so a `frameos` runtime could not
  ## even open its own frame.json there. `FRAMEOS_BUILDROOT_SERVICE_USER`
  ## overrides both, for recovery over a console.
  ##
  ## "Backend-managed" means a backend can actually reach the frame: a
  ## `serverHost`, or an enabled agent *with* a shared secret. Generic
  ## images from before 2026-08-21 shipped `agentEnabled: true` with an
  ## empty secret as a default, which no backend can use — treating that
  ## as managed kept a FrameOS Cloud frame (Cloud-5, 2026-09-04) on root
  ## through the 9.4 upgrade instead of migrating it.
  let override = getEnv("FRAMEOS_BUILDROOT_SERVICE_USER").strip()
  if override.len > 0:
    return override
  let agentUsable = frameConfig != nil and frameConfig.agent != nil and
    frameConfig.agent.agentEnabled and frameConfig.agent.agentSharedSecret.strip().len > 0
  let backendManaged = frameConfig != nil and (
    frameConfig.serverHost.strip().len > 0 or agentUsable)
  if backendManaged:
    return if installedUser.len > 0: installedUser else: "root"
  if not usesNetworkManager:
    return "root"
  BuildrootServiceUser

# ---------------------------------------------------------------------------
# Users, groups, ownership — pure script builders, so tests can read them
# ---------------------------------------------------------------------------

proc buildrootPasswdLine*(user = BuildrootServiceUser, uid = BuildrootServiceUid,
                          gid = BuildrootServiceGid): string =
  user & ":x:" & $uid & ":" & $gid & ":" & BuildrootServiceUserComment & ":" &
    BuildrootServiceUserHome & ":" & BuildrootServiceUserShell

proc buildrootGroupLine*(user = BuildrootServiceUser, gid = BuildrootServiceGid): string =
  user & ":x:" & $gid & ":"

proc buildrootShadowLine*(user = BuildrootServiceUser): string =
  ## Locked, like Buildroot's own system users (`daemon:*:::::::`).
  user & ":*:::::::"

proc buildrootUserSetupScript*(user = BuildrootServiceUser, uid = BuildrootServiceUid,
                               gid = BuildrootServiceGid, etcDir = "/etc"): string =
  ## POSIX sh: creates the group and user unless they exist. Refuses to
  ## continue when the fixed uid/gid is taken by someone else — appending a
  ## duplicate id would be worse than a failed setup step. Edits the files
  ## directly rather than through useradd so the result is identical to what
  ## the image composer writes.
  let passwd = etcDir / "passwd"
  let group = etcDir / "group"
  let shadow = etcDir / "shadow"
  "set -e; " &
    "if grep -q '^" & user & ":[^:]*:" & $gid & ":' " & shellQuote(group) & "; then :; " &
    "elif grep -q '^" & user & ":' " & shellQuote(group) & "; then " &
    "echo 'group " & user & " has the wrong gid (expected " & $gid & ")' >&2; exit 1; " &
    "elif grep -q '^[^:]*:[^:]*:" & $gid & ":' " & shellQuote(group) & "; then " &
    "echo 'gid " & $gid & " is taken by another group' >&2; exit 1; " &
    "else printf '%s\\n' " & shellQuote(buildrootGroupLine(user, gid)) & " >> " & shellQuote(group) & "; fi; " &
    "if grep -q '^" & user & ":[^:]*:" & $uid & ":" & $gid & ":' " & shellQuote(passwd) & "; then :; " &
    "elif grep -q '^" & user & ":' " & shellQuote(passwd) & "; then " &
    "echo 'user " & user & " has the wrong uid/gid (expected " & $uid & ":" & $gid & ")' >&2; exit 1; " &
    "elif grep -q '^[^:]*:[^:]*:" & $uid & ":' " & shellQuote(passwd) & "; then " &
    "echo 'uid " & $uid & " is taken by another user' >&2; exit 1; " &
    "else printf '%s\\n' " & shellQuote(buildrootPasswdLine(user, uid, gid)) & " >> " & shellQuote(passwd) & "; fi; " &
    "if [ -f " & shellQuote(shadow) & " ] && ! grep -q '^" & user & ":' " & shellQuote(shadow) & "; then " &
    "printf '%s\\n' " & shellQuote(buildrootShadowLine(user)) & " >> " & shellQuote(shadow) & "; fi"

proc buildrootOwnershipScript*(user = BuildrootServiceUser, installDir = "/srv/frameos",
                               assetsDir = "/srv/assets"): string =
  ## POSIX sh (busybox find/chown/chmod): the /srv/frameos layout.
  ##
  ##   /srv/frameos                       root:root  0755   code and symlinks
  ##   /srv/frameos/releases/<r>          root:USER  1775   sticky: USER may add
  ##                                                        files, not replace root's
  ##   /srv/frameos/releases/<r>/frameos  root:root  0755   what root executes
  ##   /srv/frameos/releases/<r>/{drivers,scenes,vendor} root:root 0755/0644:
  ##                                                        root's, world-readable
  ##                                                        (the runtime loads them)
  ##   /srv/frameos/releases/<r>/*.json*  USER:USER         frame.json, salt
  ##   /srv/frameos/current               root-owned symlink
  ##   /srv/frameos/{state,logs,tmp,runtime,staging}  root:USER 1770; contents USER
  ##   /srv/frameos/state/{NetworkManager,wpa_supplicant}  root 0700 (NM/wpa
  ##                                                        refuse other owners)
  ##   /srv/frameos/privileged            root:USER 0755; queue root:USER 1770;
  ##                                      results root:USER 2750
  ##
  ## /srv/assets is vfat (umask=000): chown is meaningless there and skipped.
  ##
  ## This script only ever hands things to ROOT and sets modes. Handing the
  ## runtime's files back to USER is `chownRuntimeTrees` below — in Nim, on
  ## an open descriptor, because a hard link the runtime planted to root's
  ## binary must never be chowned to the runtime, and busybox find (as
  ## Buildroot configures it) has no `-links` to tell the two apart.
  let d = shellQuote(installDir)
  let u = shellQuote(user)
  let rg = shellQuote("root:" & user)
  "set -e; " &
    "chown root:root " & d & "; chmod 0755 " & d & "; " &
    "mkdir -p " & d & "/releases " & d & "/state " & d & "/logs " & d & "/tmp " & d & "/runtime " &
      d & "/staging " & d & "/privileged/queue " & d & "/privileged/results; " &
    "chown root:root " & d & "/releases; chmod 0755 " & d & "/releases; " &
    "for r in " & d & "/releases/*/; do [ -d \"$r\" ] || continue; " &
      "chown " & rg & " \"$r\"; chmod 1775 \"$r\"; " &
      "[ -f \"$r/frameos\" ] && [ ! -L \"$r/frameos\" ] && chown root:root \"$r/frameos\" && chmod 0755 \"$r/frameos\"; " &
      "[ -f \"$r/frameos.service\" ] && [ ! -L \"$r/frameos.service\" ] && chown root:root \"$r/frameos.service\" && chmod 0644 \"$r/frameos.service\"; " &
      # Code-loading roots: root's directories, never something the runtime
      # dropped under the same name in the sticky release root. Root owns
      # them, but the RUNTIME reads them (dlopen of drivers/*.so, fonts under
      # vendor/), and the door worker that unpacked them runs with
      # UMask=0027 — so every mode is set here explicitly: 2026.9.5 was
      # installed through the door with drivers/ 0750 and *.so 0640, and the
      # unprivileged runtime could not load a single driver.
      "for sub in drivers scenes vendor; do " &
        "if [ -L \"$r/$sub\" ] || { [ -e \"$r/$sub\" ] && [ ! -d \"$r/$sub\" ]; }; then rm -f \"$r/$sub\"; fi; " &
        "mkdir -p \"$r/$sub\"; chown -R root:root \"$r/$sub\"; chmod -R u=rwX,go=rX \"$r/$sub\"; done; " &
    "done; " &
    "[ -L " & d & "/current ] && chown -h root:root " & d & "/current; " &
    "[ -d " & d & "/vendor ] && chown -R root:root " & d & "/vendor && chmod -R u=rwX,go=rX " & d & "/vendor; " &
    "for p in logs tmp runtime staging state; do " &
      "chown " & rg & " " & d & "/$p; chmod 1770 " & d & "/$p; done; " &
    "for p in NetworkManager wpa_supplicant; do [ -d " & d & "/state/$p ] && chown -R root:root " & d &
      "/state/$p && chmod 0700 " & d & "/state/$p; done; " &
    "chown " & rg & " " & d & "/privileged; chmod 0755 " & d & "/privileged; " &
    "chown " & rg & " " & d & "/privileged/queue; chmod 1770 " & d & "/privileged/queue; " &
    "find " & d & "/privileged/results -mindepth 1 -exec chown -h root:" & u & " {} +; " &
    "find " & d & "/privileged/results -mindepth 1 -type f -exec chmod 0640 {} +; " &
    "chown " & rg & " " & d & "/privileged/results; chmod 2750 " & d & "/privileged/results; " &
    "true"

type
  RuntimeChownReport* = object
    ## What chownRuntimeTrees did, for logs and tests.
    changed*: seq[string]   ## entries now owned by the runtime user
    skipped*: seq[string]   ## entries refused: hard-linked regular files
    failed*: seq[string]    ## entries that could not be opened or chowned

when defined(posix) and not defined(frameosEmbedded) and not defined(frameosWasm):
  import std/posix

  # std/posix has neither the *at() family nor fdopendir; all POSIX.1-2008.
  proc openat(dirfd: cint, path: cstring, flags: cint): cint {.importc: "openat", header: "<fcntl.h>", varargs.}
  proc fdopendir(fd: cint): ptr DIR {.importc: "fdopendir", header: "<dirent.h>".}
  proc fstatat(dirfd: cint, path: cstring, st: var Stat, flags: cint): cint {.
    importc: "fstatat", header: "<sys/stat.h>".}
  proc fchownat(dirfd: cint, path: cstring, owner: Uid, group: Gid, flags: cint): cint {.
    importc: "fchownat", header: "<unistd.h>".}
  var AT_SYMLINK_NOFOLLOW {.importc: "AT_SYMLINK_NOFOLLOW", header: "<fcntl.h>".}: cint
  # os.moveDir falls back to copy-and-delete (a path walk); this is rename(2) only.
  proc renameEntry(source, destination: cstring): cint {.importc: "rename", header: "<stdio.h>".}

  proc chownOpenEntry(fd: cint, display: string, uid: Uid, gid: Gid,
                      report: var RuntimeChownReport, chmodMode = -1) =
    ## The descriptor is fstat'ed and chowned as one inode, so what gets
    ## chowned is exactly what was checked. A regular file with more than
    ## one link is refused: the only way a runtime-created entry shares an
    ## inode with something root owns is a hard link the runtime made to
    ## root's file (protected_hardlinks off), and chowning that would hand
    ## it the binary root executes.
    var st: Stat
    if fstat(fd, st) != 0:
      report.failed.add(display)
      return
    if S_ISREG(st.st_mode) and int(st.st_nlink) != 1:
      report.skipped.add(display)
      return
    if not (S_ISREG(st.st_mode) or S_ISDIR(st.st_mode)):
      # FIFOs, sockets: nothing the layout needs; leave them alone.
      return
    if fchown(fd, uid, gid) != 0:
      report.failed.add(display)
      return
    if chmodMode >= 0:
      discard fchmod(fd, Mode(chmodMode))
    report.changed.add(display)

  proc chownTreeAt(dirfd: cint, display: string, uid: Uid, gid: Gid,
                   report: var RuntimeChownReport, prune: openArray[string],
                   releaseRoot: bool) =
    ## Everything inside the directory `dirfd` is open on. The walk is
    ## descriptor-relative (fdopendir / openat), never by path: a runtime
    ## that swaps one of its own sub-directories for a symlink while root
    ## is inside it must not be able to steer the chown into /etc. Symlinks
    ## are chowned with AT_SYMLINK_NOFOLLOW and never entered. At a release
    ## root (`releaseRoot`) only regular files are handed over — `frameos`
    ## and `frameos.service` excepted, `frame.json*` set to 0600 — and
    ## nothing is entered; elsewhere directories are entered, `prune` names
    ## are skipped at this level.
    let dupFd = dup(dirfd)
    if dupFd < 0:
      report.failed.add(display)
      return
    let dir = fdopendir(dupFd)   # owns dupFd from here on
    if dir == nil:
      discard posix.close(dupFd)
      report.failed.add(display)
      return
    defer: discard closedir(dir)
    while true:
      let entry = readdir(dir)
      if entry == nil:
        break
      let name = $cast[cstring](addr entry.d_name[0])
      if name == "." or name == ".." or name in prune:
        continue
      let childDisplay = display / name
      if releaseRoot and name in ["frameos", "frameos.service"]:
        continue
      # Classify without following; the open below re-checks on the
      # descriptor, so a swap between the two only makes the entry fail.
      var st: Stat
      if fstatat(dirfd, name.cstring, st, AT_SYMLINK_NOFOLLOW) != 0:
        report.failed.add(childDisplay)
        continue
      if S_ISLNK(st.st_mode):
        # Owning a symlink grants the runtime nothing it lacks, and the old
        # layout left them to it; never follow it.
        if not releaseRoot:
          if fchownat(dirfd, name.cstring, uid, gid, AT_SYMLINK_NOFOLLOW) == 0:
            report.changed.add(childDisplay)
          else:
            report.failed.add(childDisplay)
        continue
      if S_ISDIR(st.st_mode):
        if releaseRoot:
          continue
        let childDir = openat(dirfd, name.cstring, O_RDONLY or O_DIRECTORY or O_NOFOLLOW or O_CLOEXEC)
        if childDir < 0:
          report.failed.add(childDisplay)
          continue
        chownOpenEntry(childDir, childDisplay, uid, gid, report)
        chownTreeAt(childDir, childDisplay, uid, gid, report, [], releaseRoot = false)
        discard posix.close(childDir)
        continue
      if not S_ISREG(st.st_mode):
        continue   # FIFOs, sockets, devices: nothing the layout needs
      let childFd = openat(dirfd, name.cstring, O_RDONLY or O_NOFOLLOW or O_NONBLOCK or O_CLOEXEC)
      if childFd < 0:
        report.failed.add(childDisplay)
        continue
      chownOpenEntry(childFd, childDisplay, uid, gid, report,
        chmodMode = if releaseRoot and name.startsWith("frame.json"): 0o600 else: -1)
      discard posix.close(childFd)

  proc chownRuntimeTrees*(user = BuildrootServiceUser, installDir = "/srv/frameos"): RuntimeChownReport =
    ## The USER half of the /srv/frameos layout (see buildrootOwnershipScript
    ## for the root half): release-root files except `frameos` and
    ## `frameos.service` (frame.json and its salt 0600), and everything
    ## inside logs, tmp, runtime, staging and state — except the
    ## NetworkManager and wpa_supplicant keyfile directories, which stay
    ## root's. Raises when the user does not exist.
    let pw = getpwnam(user.cstring)
    if pw == nil:
      raise newException(OSError, "no such user: " & user)
    let uid = pw.pw_uid
    let gid = pw.pw_gid
    proc openDir(path: string): cint =
      posix.open(path.cstring, O_RDONLY or O_DIRECTORY or O_NOFOLLOW or O_CLOEXEC)
    # releases/ and each release root are root's directories: the runtime
    # cannot swap either, so opening them by path is fine.
    for kind, releaseDir in walkDir(installDir / "releases"):
      if kind != pcDir:
        continue
      let fd = openDir(releaseDir)
      if fd < 0:
        result.failed.add(releaseDir)
        continue
      chownTreeAt(fd, releaseDir, uid, gid, result, [], releaseRoot = true)
      discard posix.close(fd)
    for sub in ["logs", "tmp", "runtime", "staging", "state"]:
      let path = installDir / sub
      if not dirExists(path):
        continue
      let fd = openDir(path)
      if fd < 0:
        result.failed.add(path)
        continue
      chownTreeAt(fd, path, uid, gid, result,
        prune = if sub == "state": @["NetworkManager", "wpa_supplicant"] else: @[],
        releaseRoot = false)
      discard posix.close(fd)
else:
  proc chownRuntimeTrees*(user = BuildrootServiceUser, installDir = "/srv/frameos"): RuntimeChownReport =
    discard

# ---------------------------------------------------------------------------
# Applying it (root)
# ---------------------------------------------------------------------------

proc ensureBuildrootServiceUser*(user = BuildrootServiceUser): bool =
  ## Creates the user/group on the (remounted) rootfs. True when the user
  ## exists afterwards.
  if user == "root":
    return true
  setupLog("FrameOS setup: privilege separation: creating user " & user &
    " (uid " & $BuildrootServiceUid & ")")
  withWritableMount("/etc/passwd"):
    let res = runSetupCommand(privilegedCommand("sh -c " & shellQuote(buildrootUserSetupScript(user))),
      raiseOnError = false)
    if res.exitCode != 0:
      setupLog("FrameOS setup: privilege separation: could not create user " & user)
      return false
  commandSucceeds("grep -q '^" & user & ":[^:]*:" & $BuildrootServiceUid & ":" &
    $BuildrootServiceGid & ":' /etc/passwd") and
    commandSucceeds("grep -q '^" & user & ":[^:]*:" & $BuildrootServiceGid & ":' /etc/group")

proc pruneRuntimePlantedCodeRoots*(installDir = "/srv/frameos"): seq[string] =
  ## `drivers/`, `scenes/` and `vendor/` under a release root are where root
  ## loads code from (LD_LIBRARY_PATH, driver .so files), which is why the
  ## composer and install-release create them root-owned before the release
  ## root becomes sticky-writable. Should one of those names nevertheless be
  ## a symlink or a plain file, it is unlinked; a directory the runtime user
  ## created is renamed aside (`.planted-<name>-<time>`, still the runtime's
  ## to delete) rather than deleted recursively — root never walks a tree the
  ## runtime can rearrange under it. Neither is ever chowned to root. Runs
  ## before the ownership script `mkdir -p`s root's own. Returns what was
  ## moved or removed.
  when defined(posix) and not defined(frameosEmbedded) and not defined(frameosWasm):
    for kind, releaseDir in walkDir(installDir / "releases"):
      if kind != pcDir:
        continue
      for sub in ["drivers", "scenes", "vendor"]:
        let path = releaseDir / sub
        var st: Stat
        if lstat(path.cstring, st) != 0:
          continue
        try:
          if S_ISDIR(st.st_mode):
            if int(st.st_uid) != 0:
              let aside = releaseDir / (".planted-" & sub & "-" & $epochTime().int64)
              if renameEntry(path.cstring, aside.cstring) != 0:
                raiseOSError(OSErrorCode(errno), path)
              result.add(path)
          else:
            removeFile(path)
            result.add(path)
        except CatchableError as e:
          setupLog("FrameOS setup: privilege separation: could not move " & path & " aside: " & e.msg)
  else:
    discard

proc applyBuildrootOwnership*(user = BuildrootServiceUser, installDir = "/srv/frameos") =
  ## Stamps the /srv/frameos layout. Safe to repeat; the image composer, the
  ## first-boot service, `frameos setup` and install-release all call it.
  ## Root's half is the shell script; the runtime's half is chownRuntimeTrees.
  if user == "root":
    return
  setupLog("FrameOS setup: privilege separation: applying /srv/frameos ownership for " & user)
  for removed in pruneRuntimePlantedCodeRoots(installDir):
    setupLog("FrameOS setup: privilege separation: removed a runtime-planted " & removed)
  discard runSetupCommand(privilegedCommand("sh -c " & shellQuote(buildrootOwnershipScript(user, installDir))))
  try:
    let report = chownRuntimeTrees(user, installDir)
    for path in report.skipped:
      setupLog("FrameOS setup: privilege separation: refused to hand a hard-linked file to " & user & ": " & path)
    if report.failed.len > 0:
      setupLog("FrameOS setup: privilege separation: could not chown " & $report.failed.len &
        " entr" & (if report.failed.len == 1: "y" else: "ies") & " (first: " & report.failed[0] & ")")
  except CatchableError as e:
    setupLog("FrameOS setup: privilege separation: could not hand runtime files to " & user & ": " & e.msg)

proc installBuildrootPrivilegedUnits*(user: string) =
  ## Installs the door's units and the udev rule, enabling the .path only
  ## for an unprivileged service (a root runtime never needs the door).
  ## Caller holds the writable mount and runs daemon-reload afterwards.
  let systemdDir = "/etc/systemd/system"
  writePrivilegedFile(systemdDir / BuildrootPrivilegedPathUnitName, BuildrootPrivilegedPathUnit)
  writePrivilegedFile(systemdDir / BuildrootPrivilegedServiceUnitName, BuildrootPrivilegedServiceUnit)
  discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/udev/rules.d"), raiseOnError = false)
  writePrivilegedFile("/etc/udev/rules.d" / BuildrootDeviceUdevRulesName, BuildrootDeviceUdevRules)
  if user == "root":
    discard runSetupCommand(privilegedCommand("systemctl disable " & BuildrootPrivilegedPathUnitName),
      raiseOnError = false)
  else:
    discard runSetupCommand(privilegedCommand("systemctl enable " & BuildrootPrivilegedPathUnitName),
      raiseOnError = false)
