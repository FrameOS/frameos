import std/[algorithm, os, sequtils, strutils, times, unittest]
import ../release_space

const MB = 1024'i64 * 1024

proc release(name: string, at: float, bytes = 110 * MB, complete = true): ReleaseEntry =
  ReleaseEntry(name: name, installedAt: at, bytes: bytes, complete: complete)

proc fifteen(): seq[ReleaseEntry] =
  ## Cloud-W's releases dir the day it stopped upgrading: fifteen complete
  ## releases, current the newest, and a failed attempt's empty stub.
  for i in 1 .. 15:
    result.add(release("r" & $i, i.float))
  result.add(release("failed-stub", 20.0, bytes = 4096, complete = false))

suite "planReleasePrune":
  test "never touches current or the release before it":
    let plan = planReleasePrune(fifteen(), "r15", availableBytes = 0, neededBytes = high(int64) div 2)
    check "r15" notin plan
    check "r14" notin plan
    check plan.len == 14 # the stub and r1..r13: everything else, still short

  test "keeps up to ten releases when there is room for the next upgrade":
    let plan = planReleasePrune(fifteen(), "r15", availableBytes = 900 * MB, neededBytes = 220 * MB)
    check plan == @["failed-stub", "r1", "r2", "r3", "r4", "r5"]

  test "space wins over the count: deletes oldest first until the next upgrade fits":
    # Eight releases, under the count; 40 MB free and 220 MB needed: the two
    # oldest 110 MB releases go, and no more.
    var eight: seq[ReleaseEntry]
    for i in 1 .. 8:
      eight.add(release("r" & $i, i.float))
    check planReleasePrune(eight, "r8", availableBytes = 40 * MB, neededBytes = 220 * MB) == @["r1", "r2"]

  test "a partition with room keeps what it has":
    let few = @[release("a", 1.0), release("b", 2.0), release("c", 3.0)]
    check planReleasePrune(few, "c", availableBytes = 1500 * MB, neededBytes = 220 * MB).len == 0

  test "protects the release being staged, even unfinished":
    var entries = fifteen()
    entries.add(release("staging", 30.0, bytes = 0, complete = false))
    let plan = planReleasePrune(entries, "r15", 900 * MB, 220 * MB, protect = @["staging"])
    check "staging" notin plan
    check "failed-stub" in plan

  test "rolled back: current is older than the newest release, which stays":
    let entries = @[release("a", 1.0), release("b", 2.0), release("c", 3.0)]
    let plan = planReleasePrune(entries, "b", availableBytes = 0, neededBytes = 1000 * MB)
    check plan == @["a"]

  test "no current, no plan":
    check planReleasePrune(fifteen(), "", 0, 220 * MB).len == 0

  test "unknown free space: only the count applies":
    check planReleasePrune(fifteen(), "r15", availableBytes = -1, neededBytes = 220 * MB) ==
      @["failed-stub", "r1", "r2", "r3", "r4", "r5"]

  test "headroom is twice a release":
    check upgradeHeadroomBytes(113 * MB) == 226 * MB
    check upgradeHeadroomBytes(0) == 0

suite "pruneReleases on disk":
  test "deletes the planned releases here and under the remote install":
    let root = getTempDir() / ("frameos-release-space-" & $getCurrentProcessId())
    removeDir(root)
    let install = root / "frameos"
    let remote = install / "remote"
    for i in 1 .. 13:
      let dir = install / "releases" / ("release_" & $i)
      createDir(dir)
      writeFile(dir / "frameos", "binary " & $i)
      setLastModificationTime(dir / "frameos", fromUnix(1_700_000_000 + i * 60))
      createDir(remote / "releases" / ("release_" & $i))
    createDir(install / "releases" / "release_upgrade_stub")
    createDir(install / "releases" / ".install-20260922")
    createSymlink(install / "releases" / "release_13", install / "current")
    createSymlink(remote / "releases" / "release_13", remote / "current")

    var lines: seq[string]
    let removed = pruneReleases(install, remote, neededBytes = 0,
      log = proc(message: string) = lines.add(message))
    check removed.sorted() == @["release_1", "release_2", "release_3", "release_upgrade_stub"].sorted()
    check not dirExists(install / "releases" / "release_1")
    check not dirExists(remote / "releases" / "release_1")
    check dirExists(install / "releases" / "release_13")
    check dirExists(install / "releases" / "release_12")
    check dirExists(install / "releases" / ".install-20260922") # the upgrade's own work dir
    check lines.anyIt(it.contains("removed 4 old release"))
    removeDir(root)

  test "an install without a current release is left alone":
    let root = getTempDir() / ("frameos-release-space-nocurrent-" & $getCurrentProcessId())
    createDir(root / "releases" / "release_1")
    check pruneReleases(root, neededBytes = high(int64) div 2).len == 0
    check dirExists(root / "releases" / "release_1")
    removeDir(root)
