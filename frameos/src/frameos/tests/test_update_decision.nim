# The Nim runner of docs/update-decision-fixtures.json: the update decision
# (frameos/update_decision.nim), shared with the backend
# (backend/app/utils/tests/test_update_decision.py) and the cloud
# (cloud/apps/auth-web/src/lib/update-decision.test.ts).
import std/[json, options, os, unittest]
import frameos/update_decision

const fixturesPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "update-decision-fixtures.json"
const manifestPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "update-manifest.json"
let fixtures = parseFile(fixturesPath)

suite "update decision fixtures":
  test "versions":
    for c in fixtures["versions"]:
      checkpoint $c
      let parsed = parseUpdateVersion(c["input"].getStr())
      if c["version"].kind == JNull:
        check parsed.isNone
      else:
        check parsed.isSome and versionText(parsed.get) == c["version"].getStr()

  test "buckets":
    for c in fixtures["buckets"]:
      checkpoint $c
      check cohortBucket(c["frameKey"].getStr(), c["version"].getStr()) == c["bucket"].getInt()

  test "rollout":
    for c in fixtures["rollout"]:
      checkpoint $c
      let now = parseUpdateTime(c["now"].getStr())
      check now.isSome
      check rolloutPercent(c["release"], fixtures["defaultRollout"], now.get) == c["percent"].getFloat()

  test "decisions":
    for c in fixtures["decisions"]:
      checkpoint c["name"].getStr()
      let manifest = if c["manifest"].kind == JNull: newJNull() else: fixtures["manifests"][c["manifest"].getStr()]
      let got = decideUpdate(manifest, c["request"])
      let held = got["held"]
      let comparable = %*{
        "version": got["version"],
        "reason": got["reason"],
        "latest": got["latest"],
        "held": (if held.kind == JNull: newJNull() else: %*{"version": held["version"], "why": held["why"]}),
      }
      check comparable == c["expect"]
      if held.kind != JNull:
        check held["detail"].getStr().len > 0

  test "the published manifest reads and decides":
    let manifest = parseFile(manifestPath)
    let got = decideUpdate(manifest, %*{"current": "2000.1.1", "platform": "linux",
                                        "target": "debian-bookworm-arm64", "frameKey": "x", "manual": true})
    # Whatever it is blocked or paused for today, it lists a latest release.
    check got["latest"].kind == JString
