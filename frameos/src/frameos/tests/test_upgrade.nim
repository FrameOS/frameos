import std/[base64, json, os, strutils, tables, unittest]

import ../device_setup
import ../ota_pubkey
import ../upgrade

suite "FrameOS upgrade helpers":
  test "distro release normalization maps buildroot to debian bookworm":
    check normalizeDistroRelease({
      "ID": "buildroot",
      "VERSION_ID": "2025.02.13",
    }.toTable) == (distro: "debian", release: "bookworm")

    check normalizeDistroRelease({
      "ID": "raspbian",
      "VERSION_CODENAME": "bookworm",
    }.toTable) == (distro: "debian", release: "bookworm")

    check normalizeDistroRelease({
      "ID": "debian",
      "VERSION_CODENAME": "trixie",
    }.toTable) == (distro: "debian", release: "trixie")

    check normalizeDistroRelease({
      "ID": "ubuntu",
      "VERSION_CODENAME": "noble",
    }.toTable) == (distro: "ubuntu", release: "24.04")

  test "uname arch mapping keeps armv6 separate from armhf":
    check archForUname("aarch64") == "arm64"
    check archForUname("armv7l") == "armhf"
    # Pi Zero W / Pi 1: armhf release artifacts are ARMv7 and SIGILL on the
    # ARM1176, so armv6l must map to its own target.
    check archForUname("armv6l") == "armv6"
    check archForUname("x86_64") == "amd64"
    expect ValueError:
      discard archForUname("riscv64")

  test "release payload selects stable target asset":
    let release = releaseInfoFromPayload(
      %*{
        "tag_name": "v2026.6.27",
        "draft": false,
        "prerelease": false,
        "html_url": "https://github.com/FrameOS/frameos/releases/tag/v2026.6.27",
        "assets": [
          {
            "name": "frameos-2026.6.27-debian-bookworm-arm64.tar.gz",
            "browser_download_url": "https://github.com/FrameOS/frameos/releases/download/v2026.6.27/frameos-2026.6.27-debian-bookworm-arm64.tar.gz",
          },
          {
            "name": "frameos-2026.6.27-debian-bookworm-amd64.tar.gz",
            "browser_download_url": "https://github.com/FrameOS/frameos/releases/download/v2026.6.27/frameos-2026.6.27-debian-bookworm-amd64.tar.gz",
          },
        ],
      },
      "debian-bookworm-amd64",
    )

    check release.version == "2026.6.27"
    check release.tagName == "v2026.6.27"
    check release.assetName == "frameos-2026.6.27-debian-bookworm-amd64.tar.gz"
    check release.assetUrl.endsWith("/frameos-2026.6.27-debian-bookworm-amd64.tar.gz")

  test "release payload rejects prereleases and non github assets":
    expect ValueError:
      discard releaseInfoFromPayload(
        %*{
          "tag_name": "v2026.6.27",
          "prerelease": true,
          "assets": [],
        },
        "debian-bookworm-amd64",
      )

    expect ValueError:
      discard releaseInfoFromPayload(
        %*{
          "tag_name": "v2026.6.27",
          "assets": [
            {
              "name": "frameos-2026.6.27-debian-bookworm-amd64.tar.gz",
              "browser_download_url": "https://example.com/frameos.tar.gz",
            }
          ],
        },
        "debian-bookworm-amd64",
      )

  test "version comparison handles calver and build metadata":
    check compareFrameOSVersions("2026.6.27+abc", "2026.6.28") < 0
    check compareFrameOSVersions("2026.7.0", "2026.6.99") > 0
    check compareFrameOSVersions("v2026.6.27", "2026.6.27+def") == 0

  test "the privileged installer accepts only a strictly newer release":
    check releaseInstallVersionProblem("2026.8.43", "2026.8.44") == ""
    check "not newer" in releaseInstallVersionProblem("2026.8.44", "2026.8.44")
    check "not newer" in releaseInstallVersionProblem("2026.9.0", "2026.8.44")
    check releaseInstallVersionProblem("unknown", "2026.8.44") == ""
    check releaseInstallVersionProblem("2026.8.43", "2026..44").len > 0

  test "the root worker requires a buildroot host and matching config mode":
    let dir = getTempDir() / "frameos-upgrade-os-release-test"
    createDir(dir)
    defer: removeDir(dir)
    let osRelease = dir / "os-release"
    writeFile(osRelease, "NAME=Buildroot\nID=buildroot\n")
    check isBuildrootHost(osRelease)
    check privilegedBuildrootContextProblem("buildroot", osRelease) == ""
    check "config mode" in privilegedBuildrootContextProblem("rpios", osRelease)
    writeFile(osRelease, "NAME=Debian\nID=debian\n")
    check not isBuildrootHost(osRelease)
    check "only available" in privilegedBuildrootContextProblem("buildroot", osRelease)

  test "the extracted archive root is bound to version and target":
    let dir = getTempDir() / "frameos-upgrade-archive-root-test"
    createDir(dir)
    defer: removeDir(dir)
    let release = FrameOSReleaseInfo(version: "2026.8.44", target: "debian-bookworm-arm64")
    let expected = dir / expectedReleaseArchiveRootName(release)
    createDir(expected)
    check extractedReleaseRoot(dir, release) == expected
    writeFile(dir / "unexpected", "x")
    expect ValueError:
      discard extractedReleaseRoot(dir, release)
    removeFile(dir / "unexpected")
    removeDir(expected)
    createDir(dir / "frameos-2026.8.43-debian-bookworm-arm64")
    expect ValueError:
      discard extractedReleaseRoot(dir, release)

  test "latest release status update clears missing or stale errors":
    let release = FrameOSReleaseInfo(
      version: "2026.6.27",
      tagName: "v2026.6.27",
      target: "debian-bookworm-arm64",
      assetName: "frameos-2026.6.27-debian-bookworm-arm64.tar.gz",
      assetUrl: "https://github.com/FrameOS/frameos/releases/download/v2026.6.27/frameos-2026.6.27-debian-bookworm-arm64.tar.gz",
      htmlUrl: "https://github.com/FrameOS/frameos/releases/tag/v2026.6.27",
    )

    var cleanStatus = %*{"status": "idle"}
    applyLatestReleaseToStatus(cleanStatus, release, "2026.6.25")
    check not cleanStatus.hasKey("latest_error")
    check cleanStatus{"latest_version"}.getStr() == "2026.6.27"
    check cleanStatus{"update_available"}.getBool() == true

    var staleErrorStatus = %*{"status": "dry_run", "latest_error": "key not in object"}
    applyLatestReleaseToStatus(staleErrorStatus, release, "2026.6.27")
    check not staleErrorStatus.hasKey("latest_error")
    check staleErrorStatus{"update_available"}.getBool() == false

  test "in-flight detection trusts only fresh starting/running statuses":
    let tempDir = getTempDir() / "frameos-upgrade-inflight-test"
    if dirExists(tempDir):
      removeDir(tempDir)

    let hadFrameosDir = existsEnv("FRAMEOS_DIR")
    let oldFrameosDir = if hadFrameosDir: getEnv("FRAMEOS_DIR") else: ""
    try:
      putEnv("FRAMEOS_DIR", tempDir)

      # No status file at all
      check not frameOSUpgradeInFlight()

      # Fresh "running" blocks a second trigger
      writeUpgradeStatus(%*{"status": "running"})
      check frameOSUpgradeInFlight()

      # Terminal statuses do not
      writeUpgradeStatus(%*{"status": "failed"})
      check not frameOSUpgradeInFlight()
      writeUpgradeStatus(%*{"status": "success"})
      check not frameOSUpgradeInFlight()

      # A "running" entry stamped in the distant past is a crashed upgrade,
      # not one in flight — it must not wedge future triggers.
      writeFile(frameosUpgradeStatusPath(), $(%*{
        "status": "running", "updated_at": "2020-01-01T00:00:00Z"}))
      check not frameOSUpgradeInFlight()

      # As is one whose timestamp cannot be believed at all.
      writeFile(frameosUpgradeStatusPath(), $(%*{
        "status": "starting", "updated_at": "not-a-timestamp"}))
      check not frameOSUpgradeInFlight()
    finally:
      if hadFrameosDir:
        putEnv("FRAMEOS_DIR", oldFrameosDir)
      else:
        delEnv("FRAMEOS_DIR")
      if dirExists(tempDir):
        removeDir(tempDir)

  test "upgrade copies shared admin session salt for legacy release compatibility":
    let tempDir = getTempDir() / "frameos-upgrade-salt-test"
    if dirExists(tempDir):
      removeDir(tempDir)

    let hadFrameosDir = existsEnv("FRAMEOS_DIR")
    let oldFrameosDir = if hadFrameosDir: getEnv("FRAMEOS_DIR") else: ""
    try:
      putEnv("FRAMEOS_DIR", tempDir)
      createDir(tempDir / "current")
      createDir(tempDir / "state")
      createDir(tempDir / "releases" / "release_new")
      writeFile(tempDir / "state" / "admin_session_salt", "shared-salt\n")
      writeFile(tempDir / "current" / "frame.json.admin_session_salt", "legacy-salt\n")

      copyAdminSessionSaltForUpgrade(tempDir / "releases" / "release_new")

      check readFile(tempDir / "releases" / "release_new" / "frame.json.admin_session_salt") == "shared-salt\n"

      removeFile(tempDir / "state" / "admin_session_salt")
      createDir(tempDir / "releases" / "release_legacy")
      copyAdminSessionSaltForUpgrade(tempDir / "releases" / "release_legacy")

      check readFile(tempDir / "releases" / "release_legacy" / "frame.json.admin_session_salt") == "legacy-salt\n"
    finally:
      if hadFrameosDir:
        putEnv("FRAMEOS_DIR", oldFrameosDir)
      else:
        delEnv("FRAMEOS_DIR")
      if dirExists(tempDir):
        removeDir(tempDir)

  test "release signatures must come from the key this build trusts":
    # A well-formed blob signed by another key id is refused before any
    # cryptography runs — the key id check is the cheap half of the trust
    # decision, and a rotated key must not be silently accepted.
    let foreignBlob = "ED" & "\xaa\xbb\xcc\xdd\xee\xff\x00\x11" & repeat("\x42", 64)
    expect ValueError:
      discard parseMinisigSignature("untrusted comment: x\n" & encode(foreignBlob) & "\n")

    # Truncated, mistyped and empty signature files all raise rather than
    # returning something the verifier might treat as valid.
    expect ValueError:
      discard parseMinisigSignature("untrusted comment: x\n" & encode("ED" & repeat("\x00", 8)) & "\n")
    expect ValueError:
      discard parseMinisigSignature("untrusted comment: only a comment\n")
    expect ValueError:
      discard parseMinisigSignature("untrusted comment: x\nnot base64!!\n")

  test "signature URL sits beside the asset":
    check releaseSignatureUrl("https://example.com/frameos-1.2.3-debian-bookworm-arm64.tar.gz") ==
      "https://example.com/frameos-1.2.3-debian-bookworm-arm64.tar.gz.minisig"

  test "a tampered archive fails verification":
    let dir = getTempDir() / "frameos-upgrade-sig-test"
    createDir(dir)
    defer: removeDir(dir)
    let archive = dir / "frameos.tar.gz"
    writeFile(archive, "not really a release")
    # A syntactically valid signature from the trusted key id, but over
    # nothing: verification must fail on the signature, not wave it through.
    let blob = "ED" & parseHexStr(OtaSigningKeyIdHex) & repeat("\x00", 64)
    expect ValueError:
      verifyReleaseArchiveSignature(archive, "untrusted comment: x\n" & encode(blob) & "\n")

suite "upgrade status reporting":
  # A cloud OTA used to log "scheduled" and then nothing at all: the upgrade
  # runs detached, and its status file was read by the local admin page only.
  # The cloud client now watches that file, so the shape of what it logs is
  # part of the contract.
  test "the log line keeps what a person needs and drops the rest":
    let line = upgradeStatusLogLine(%*{
      "status": "running",
      "message": "FrameOS upgrade is running.",
      "current_version": "2026.8.20",
      "latest_version": "2026.8.21",
      "target": "debian-bookworm-arm64",
      "exit_code": 0,
      # Bulk the log has no use for: the whole release object and a path.
      "latest_release": {"version": "2026.8.21", "asset_url": "https://example.com/x.tar.gz"},
      "log_path": "/srv/frameos/logs/upgrade.log",
      "started_at": "2026-08-14T22:07:35Z",
    })
    check line{"event"}.getStr("") == "cloud:upgrade"
    check line{"status"}.getStr("") == "running"
    check line{"message"}.getStr("") == "FrameOS upgrade is running."
    check line{"current_version"}.getStr("") == "2026.8.20"
    check line{"latest_version"}.getStr("") == "2026.8.21"
    check line{"target"}.getStr("") == "debian-bookworm-arm64"
    check line{"exit_code"}.getInt(-1) == 0
    check not line.hasKey("latest_release")
    check not line.hasKey("log_path")
    check not line.hasKey("started_at")

  test "empty and missing fields are omitted rather than logged blank":
    # The provider names no version in notify_update_available, and a status
    # written before a target was detected has an empty target. `"target": ""`
    # in a log line reads as a bug in the frame.
    let line = upgradeStatusLogLine(%*{"status": "failed", "target": "", "message": "boom"})
    check line{"status"}.getStr("") == "failed"
    check line{"message"}.getStr("") == "boom"
    check not line.hasKey("target")
    check not line.hasKey("current_version")

  test "a missing or malformed status file reads as idle, never crashes":
    check upgradeStatusLogLine(nil){"status"}.getStr("") == "idle"
    check upgradeStatusLogLine(newJNull()){"status"}.getStr("") == "idle"
    check upgradeStatusLogLine(%*["not", "an", "object"]){"status"}.getStr("") == "idle"
    check upgradeStatusLogLine(%*{}){"status"}.getStr("") == "idle"

  test "every status the upgrade can end on is recognised as terminal":
    # The watcher stops polling on these; one missing here would leave a
    # finished upgrade being re-checked until the session ends.
    for status in ["success", "reboot_required", "failed", "up_to_date", "idle"]:
      check status in UpgradeTerminalStatuses
    # …and the in-flight ones are not, or the outcome would never be logged.
    for status in ["starting", "running"]:
      check status notin UpgradeTerminalStatuses

  test "an upgrade that needs a boot reboots itself":
    # The frame is on a wall, not on a desk: an upgrade that ends on
    # "reboot required" and then waits for a human leaves the device running
    # the OLD binary with the new release already symlinked in as current.
    check upgradeFinishAction(rebootRequired = false, mayReboot = true) == restartServices
    check upgradeFinishAction(rebootRequired = false, mayReboot = false) == restartServices
    check upgradeFinishAction(rebootRequired = true, mayReboot = true) == rebootDevice
    check upgradeFinishAction(rebootRequired = true, mayReboot = false) == stayPut

  test "--no-reboot is the only way to keep an upgrade from rebooting":
    check not parseFrameOSUpgradeOptions(@["--yes"]).noReboot
    check parseFrameOSUpgradeOptions(@["--yes", "--no-reboot"]).noReboot
    expect ValueError:
      discard parseFrameOSUpgradeOptions(@["--no-restart"])

  test "the mtime probe answers 0 for a device that never upgraded":
    let dir = getTempDir() / "frameos-upgrade-mtime-test"
    createDir(dir)
    defer: removeDir(dir)
    putEnv("FRAMEOS_DIR", dir)
    defer: delEnv("FRAMEOS_DIR")
    check upgradeStatusMtime() == 0.0

    writeUpgradeStatus(%*{"status": "starting"})
    check upgradeStatusMtime() > 0.0


suite "staging refuses to unpack onto a full disk":
  test "the shortfall is the archive times the extraction factor":
    check releaseSpaceShortfall(10_000_000, 30_000_000) == 0
    check releaseSpaceShortfall(10_000_000, 20_000_000) == 0
    check releaseSpaceShortfall(10_000_000, 19_999_999) == 1
    check releaseSpaceShortfall(10_000_000, 0) == 20_000_000
    # Unknown free space (statvfs unavailable) is not a reason to refuse.
    check releaseSpaceShortfall(10_000_000, -1) == 0
    check releaseSpaceShortfall(0, 0) == 0
    # 32-bit devices: a 60 MB archive against a 3 GB card must not overflow.
    check releaseSpaceShortfall(60_000_000, 3_000_000_000'i64) == 0

suite "staging verifies the signature before anything runs":
  # The crypto itself is covered above (wrong key, tampered bytes, malformed
  # sigs) and the transport in test_http_client — but neither pins the WIRING:
  # that stageFrameOSRelease checks the downloaded bytes against the compiled-
  # in key BEFORE tar touches them. `tar -xzf` on unverified bytes already
  # lets an attacker choose file contents and paths on the device, so a
  # refactor that reorders those two lines must fail here, not in the field.
  teardown:
    resetReleaseFetchersForTest()
    resetSetupCommandRunnerForTest()
    delEnv("FRAMEOS_DIR")
    delEnv("FRAMEOS_REMOTE_DIR")
    delEnv("FRAMEOS_ASSETS_DIR")

  test "an archive that fails verification never reaches tar":
    let root = getTempDir() / "frameos-stage-sig-test"
    removeDir(root)
    createDir(root)
    defer: removeDir(root)
    putEnv("FRAMEOS_DIR", root / "frameos")
    putEnv("FRAMEOS_REMOTE_DIR", root / "remote")
    putEnv("FRAMEOS_ASSETS_DIR", root / "assets")

    var commands: seq[string] = @[]
    setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
      commands.add(command)
      (output: "", exitCode: 0))

    var archiveFetched = false
    setReleaseFetchersForTest(
      proc(release: FrameOSReleaseInfo, destination: string) =
        archiveFetched = true
        writeFile(destination, "definitely not the bytes that were signed"),
      proc(release: FrameOSReleaseInfo): string =
        # Well-formed and from the trusted key id, so it passes parsing and
        # the failure is the actual Ed25519 verification of the bytes — the
        # same shape a hijacked download would present.
        let blob = "ED" & parseHexStr(OtaSigningKeyIdHex) & repeat("\x00", 64)
        "untrusted comment: x\n" & encode(blob) & "\n")

    expect ValueError:
      discard stageFrameOSRelease(FrameOSReleaseInfo(
        version: "9.9.9",
        tagName: "v9.9.9",
        target: "debian-bookworm-arm64",
        assetName: "frameos-9.9.9-debian-bookworm-arm64.tar.gz",
        assetUrl: GitHubReleaseDownloadPrefix &
          "v9.9.9/frameos-9.9.9-debian-bookworm-arm64.tar.gz",
      ))

    check archiveFetched
    # The one command that must not have run: nothing may unpack (or execute
    # anything derived from) bytes the key check refused.
    for command in commands:
      check not command.contains("tar ")
