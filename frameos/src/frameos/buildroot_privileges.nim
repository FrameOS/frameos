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
## privileged worker (`apply-setup`, `install-release`) or from a root
## runtime on a not-yet-migrated frame.

import std/[os, strutils]
import frameos/device_setup
import frameos/types

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
  let override = getEnv("FRAMEOS_BUILDROOT_SERVICE_USER").strip()
  if override.len > 0:
    return override
  let backendManaged = frameConfig != nil and (
    frameConfig.serverHost.strip().len > 0 or
    (frameConfig.agent != nil and frameConfig.agent.agentEnabled))
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
    "if grep -q '^" & user & ":' " & shellQuote(group) & "; then :; " &
    "elif grep -q '^[^:]*:[^:]*:" & $gid & ":' " & shellQuote(group) & "; then " &
    "echo 'gid " & $gid & " is taken by another group' >&2; exit 1; " &
    "else printf '%s\\n' " & shellQuote(buildrootGroupLine(user, gid)) & " >> " & shellQuote(group) & "; fi; " &
    "if grep -q '^" & user & ":' " & shellQuote(passwd) & "; then :; " &
    "elif grep -q '^[^:]*:[^:]*:" & $uid & ":' " & shellQuote(passwd) & "; then " &
    "echo 'uid " & $uid & " is taken by another user' >&2; exit 1; " &
    "else printf '%s\\n' " & shellQuote(buildrootPasswdLine(user, uid, gid)) & " >> " & shellQuote(passwd) & "; " &
    "if [ -f " & shellQuote(shadow) & " ] && ! grep -q '^" & user & ":' " & shellQuote(shadow) & "; then " &
    "printf '%s\\n' " & shellQuote(buildrootShadowLine(user)) & " >> " & shellQuote(shadow) & "; fi; fi"

proc buildrootOwnershipScript*(user = BuildrootServiceUser, installDir = "/srv/frameos",
                               assetsDir = "/srv/assets"): string =
  ## POSIX sh (busybox find/chown/chmod): the /srv/frameos layout.
  ##
  ##   /srv/frameos                       root:root  0755   code and symlinks
  ##   /srv/frameos/releases/<r>          root:USER  1775   sticky: USER may add
  ##                                                        files, not replace root's
  ##   /srv/frameos/releases/<r>/frameos  root:root  0755   what root executes
  ##   /srv/frameos/releases/<r>/drivers  root:root         driver .so files
  ##   /srv/frameos/releases/<r>/*.json*  USER:USER         frame.json, scenes, salt
  ##   /srv/frameos/current               root-owned symlink
  ##   /srv/frameos/{state,logs,tmp,runtime,staging}  USER:USER
  ##   /srv/frameos/state/{NetworkManager,wpa_supplicant}  root 0700 (NM/wpa
  ##                                                        refuse other owners)
  ##   /srv/frameos/privileged            root:USER 0755; queue root:USER 1770;
  ##                                      results USER:USER 0770
  ##
  ## /srv/assets is vfat (umask=000): chown is meaningless there and skipped.
  let d = shellQuote(installDir)
  let u = shellQuote(user)
  let ug = shellQuote(user & ":" & user)
  let rg = shellQuote("root:" & user)
  "set -e; " &
    "chown root:root " & d & "; chmod 0755 " & d & "; " &
    "mkdir -p " & d & "/releases " & d & "/state " & d & "/logs " & d & "/tmp " & d & "/runtime " &
      d & "/staging " & d & "/privileged/queue " & d & "/privileged/results; " &
    "chown root:root " & d & "/releases; chmod 0755 " & d & "/releases; " &
    "for r in " & d & "/releases/*/; do [ -d \"$r\" ] || continue; " &
      "chown " & rg & " \"$r\"; chmod 1775 \"$r\"; " &
      "find \"$r\" -mindepth 1 -maxdepth 1 -type f ! -name frameos ! -name frameos.service " &
        "-exec chown " & ug & " {} +; " &
      "find \"$r\" -mindepth 1 -maxdepth 1 -type f -name 'frame.json*' -exec chmod 0600 {} +; " &
      "[ -f \"$r/frameos\" ] && chown root:root \"$r/frameos\" && chmod 0755 \"$r/frameos\"; " &
      "[ -f \"$r/frameos.service\" ] && chown root:root \"$r/frameos.service\"; " &
      "for sub in drivers vendor; do [ -d \"$r/$sub\" ] && chown -R root:root \"$r/$sub\"; done; " &
    "done; " &
    "[ -L " & d & "/current ] && chown -h root:root " & d & "/current; " &
    "for p in logs tmp runtime staging privileged/results; do " &
      "chown -R " & ug & " " & d & "/$p; chmod 0770 " & d & "/$p; done; " &
    "chown " & ug & " " & d & "/state; chmod 0750 " & d & "/state; " &
    "find " & d & "/state -mindepth 1 " &
      "\\( -path " & d & "/state/NetworkManager -o -path " & d & "/state/wpa_supplicant \\) -prune -o " &
      "-exec chown -h " & ug & " {} +; " &
    "for p in NetworkManager wpa_supplicant; do [ -d " & d & "/state/$p ] && chown -R root:root " & d &
      "/state/$p && chmod 0700 " & d & "/state/$p; done; " &
    "chown " & rg & " " & d & "/privileged; chmod 0755 " & d & "/privileged; " &
    "chown " & rg & " " & d & "/privileged/queue; chmod 1770 " & d & "/privileged/queue; " &
    "chown " & ug & " " & d & "/privileged/results; chmod 0770 " & d & "/privileged/results; " &
    "true"

# ---------------------------------------------------------------------------
# Applying it (root)
# ---------------------------------------------------------------------------

proc ensureBuildrootServiceUser*(user = BuildrootServiceUser): bool =
  ## Creates the user/group on the (remounted) rootfs. True when the user
  ## exists afterwards.
  if user == "root":
    return true
  if commandSucceeds("grep -q '^" & user & ":' /etc/passwd"):
    return true
  setupLog("FrameOS setup: privilege separation: creating user " & user &
    " (uid " & $BuildrootServiceUid & ")")
  withWritableMount("/etc/passwd"):
    let res = runSetupCommand(privilegedCommand("sh -c " & shellQuote(buildrootUserSetupScript(user))),
      raiseOnError = false)
    if res.exitCode != 0:
      setupLog("FrameOS setup: privilege separation: could not create user " & user)
      return false
  true

proc applyBuildrootOwnership*(user = BuildrootServiceUser, installDir = "/srv/frameos") =
  ## Stamps the /srv/frameos layout. Safe to repeat; the image composer, the
  ## first-boot service, `frameos setup` and install-release all call it.
  if user == "root":
    return
  setupLog("FrameOS setup: privilege separation: applying /srv/frameos ownership for " & user)
  discard runSetupCommand(privilegedCommand("sh -c " & shellQuote(buildrootOwnershipScript(user, installDir))),
    raiseOnError = false)

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
