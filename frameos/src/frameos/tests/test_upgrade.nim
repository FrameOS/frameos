import std/[base64, json, os, strutils, tables, unittest]

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
