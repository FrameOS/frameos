# The standalone frame's auto-updater (frameos/auto_updater.nim,
# docs/auto-updates.md "Standalone Pi"): the gates, and one pass end to end
# with the network, the clock and the upgrade stubbed.
import std/[json, unittest]
import frameos/auto_updater

proc goFacts(): AutoUpdateFacts =
  AutoUpdateFacts(autoUpdate: true, backendManaged: false, cloudManaged: false,
                  localHour: 3, msSinceInput: -1, upgradeInFlight: false)

let manifest = %*{
  "version": 1,
  "defaultRollout": [{"afterHours": 0, "percent": 100}],
  "releases": [
    {"version": "2026.11.13", "at": "2026-11-20T00:00:00Z"},
    {"version": "2026.11.14", "at": "2026-11-21T00:00:00Z"},
    {"version": "2026.11.15", "at": "2026-11-22T00:00:00Z",
     "blockedTargets": {"linux/debian-buster-*": "glibc"}},
  ],
}

type Recorded = ref object
  scheduled: seq[string]
  logs: seq[JsonNode]
  fetches: int

proc hooksFor(recorded: Recorded, facts: AutoUpdateFacts, current = "2026.11.13",
              target = "debian-bookworm-arm64", manifestToServe = manifest): AutoUpdateHooks =
  AutoUpdateHooks(
    facts: proc(): AutoUpdateFacts {.gcsafe.} = facts,
    fetchManifest: proc(): JsonNode {.gcsafe.} =
      inc recorded.fetches
      manifestToServe,
    currentVersion: proc(): string {.gcsafe.} = current,
    target: proc(): string {.gcsafe.} =
      if target.len == 0: raise newException(ValueError, "unsupported distro")
      target,
    frameKey: proc(): string {.gcsafe.} = "device:test",
    schedule: proc(version: string) {.gcsafe.} = recorded.scheduled.add(version),
    log: proc(payload: JsonNode) {.gcsafe.} = recorded.logs.add(payload),
    nowIso: proc(): string {.gcsafe.} = "2026-11-25T03:00:00Z",
  )

suite "auto-updater gates":
  test "every gate open: go":
    check autoUpdateGate(goFacts()) == ""

  test "each gate closes it":
    var facts = goFacts()
    facts.autoUpdate = false
    check autoUpdateGate(facts) == "disabled"
    facts = goFacts()
    facts.backendManaged = true
    check autoUpdateGate(facts) == "backend"
    facts = goFacts()
    facts.cloudManaged = true
    check autoUpdateGate(facts) == "cloud"
    facts = goFacts()
    facts.upgradeInFlight = true
    check autoUpdateGate(facts) == "in_flight"

  test "only between 02:00 and 05:00":
    var facts = goFacts()
    for hour in 0 .. 23:
      facts.localHour = hour
      check (autoUpdateGate(facts) == "") == (hour in 2 .. 4)

  test "not while someone is at the frame":
    var facts = goFacts()
    facts.msSinceInput = 60_000
    check autoUpdateGate(facts) == "in_use"
    facts.msSinceInput = 15 * 60 * 1000
    check autoUpdateGate(facts) == ""

suite "an auto-update pass":
  test "a closed gate fetches nothing":
    let recorded = Recorded()
    var facts = goFacts()
    facts.localHour = 14
    check runAutoUpdatePass(hooksFor(recorded, facts)) == apSkipped
    check recorded.fetches == 0
    check recorded.scheduled.len == 0
    check nextCheckDelaySeconds(apSkipped) == 0

  test "the decided version is installed, pinned":
    let recorded = Recorded()
    check runAutoUpdatePass(hooksFor(recorded, goFacts())) == apScheduled
    check recorded.scheduled == @["2026.11.15"]
    check recorded.logs[^1]["event"].getStr() == "autoupdate:check"
    check recorded.logs[^1]["status"].getStr() == "installing"
    check nextCheckDelaySeconds(apScheduled) == AutoUpdateCheckEverySeconds

  test "a target the latest is blocked for takes the release under it":
    let recorded = Recorded()
    check runAutoUpdatePass(hooksFor(recorded, goFacts(), target = "debian-buster-armhf")) == apScheduled
    check recorded.scheduled == @["2026.11.14"]
    check recorded.logs[^1]["reason"].getStr() == "held_back"

  test "up to date: nothing installed":
    let recorded = Recorded()
    check runAutoUpdatePass(hooksFor(recorded, goFacts(), current = "2026.11.15")) == apChecked
    check recorded.scheduled.len == 0
    check recorded.logs[^1]["status"].getStr() == "none"
    check recorded.logs[^1]["reason"].getStr() == "up_to_date"

  test "no manifest: nothing installed, try again in an hour":
    let recorded = Recorded()
    check runAutoUpdatePass(hooksFor(recorded, goFacts(), manifestToServe = nil)) == apFailed
    check recorded.scheduled.len == 0
    check recorded.logs[^1]["status"].getStr() == "error"
    check nextCheckDelaySeconds(apFailed) == AutoUpdateRetrySeconds

  test "no release target: nothing fetched":
    let recorded = Recorded()
    check runAutoUpdatePass(hooksFor(recorded, goFacts(), target = "")) == apFailed
    check recorded.fetches == 0

  test "a dev build is never updated":
    let recorded = Recorded()
    check runAutoUpdatePass(hooksFor(recorded, goFacts(), current = "unknown")) == apChecked
    check recorded.scheduled.len == 0
