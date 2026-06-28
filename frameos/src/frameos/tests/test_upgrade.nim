import std/[json, strutils, unittest]

import ../upgrade

suite "FrameOS upgrade helpers":
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
