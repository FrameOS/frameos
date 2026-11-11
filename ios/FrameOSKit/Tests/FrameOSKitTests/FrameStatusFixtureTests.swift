import Foundation
import Testing
@testable import FrameOSKit

/// The iOS runner of docs/frame-status-fixtures.json (the SPA's runner is
/// cloud/apps/auth-web/src/test/shared-spa/frame-status-fixtures.test.ts)
/// and of the reader sections of docs/deploy-progress-fixtures.json.
@Suite struct FrameStatusFixtureTests {
    @Test func frameStatusCorpus() throws {
        let fixtures = try RepoFixtures.json("docs/frame-status-fixtures.json")
        let now = try #require(FrameTime.parse(fixtures["now"]?.stringValue))
        let cases = try #require(fixtures["cases"]?.arrayValue)
        #expect(cases.count > 10)
        for kase in cases {
            let name = kase["name"]?.stringValue ?? "?"
            let plane = PlaneKind(rawValue: kase["plane"]?.stringValue ?? "") ?? .backend
            let frame = Frame(raw: kase["frame"]?.objectValue ?? [:])
            let expect = try #require(kase["expect"])
            #expect(FrameStatus.label(frame, now: now) == expect["label"]?.stringValue, "\(name): label")
            #expect(FrameStatus.activity(frame, plane: plane, now: now) == expect["activity"]?.stringValue, "\(name): activity")

            let deploy = DeployProgress.view(frame, now: now)
            if let expected = expect["deploy"], !expected.isNull {
                #expect(deploy?.status.rawValue == expected["status"]?.stringValue, "\(name): deploy status")
                #expect(deploy?.label == expected["label"]?.stringValue, "\(name): deploy label")
                #expect(deploy?.caption == expected["caption"]?.stringValue, "\(name): deploy caption")
                #expect(deploy?.percent == expected["percent"]?.intValue, "\(name): deploy percent")
            } else {
                #expect(deploy == nil, "\(name): no deploy bar")
            }

            let firmware = FrameStatus.firmwareUpdate(frame, now: now)
            if let expected = expect["firmware"], !expected.isNull {
                #expect(firmware?.kind.rawValue == expected["kind"]?.stringValue, "\(name): firmware kind")
                #expect(firmware?.label == expected["label"]?.stringValue, "\(name): firmware label")
                #expect(firmware?.percent == expected["percent"]?.intValue, "\(name): firmware percent")
            } else {
                #expect(firmware == nil, "\(name): no firmware word")
            }
        }
    }

    /// The `stale` and `percent` sections of the deploy-progress corpus, as
    /// the SPA's deploy-progress.test.tsx replays them.
    @Test func deployProgressReaderSections() throws {
        let fixtures = try RepoFixtures.json("docs/deploy-progress-fixtures.json")
        let now = try #require(FrameTime.parse("2026-10-12T12:00:00Z"))
        func record(_ kind: String, _ stage: String, ageSeconds: Double, status: String?, progress: JSONValue?) -> [String: JSONValue] {
            var record: [String: JSONValue] = [
                "id": "deploy:1", "kind": .string(kind), "stage": .string(stage),
                "status": .string(status ?? "running"),
                "started_at": .string(FrameTime.iso(now - (ageSeconds + 60) * 1000)),
                "at": .string(FrameTime.iso(now - ageSeconds * 1000)),
            ]
            if let progress { record["progress"] = progress }
            return record
        }
        for kase in fixtures["stale"]?.arrayValue ?? [] {
            // A finished record is never "stale": the view forgets it on its
            // own clock, which these cases do not pin (the SPA skips them too).
            if kase["status"] != nil { continue }
            let kind = kase["kind"]?.stringValue ?? ""
            let stage = kase["stage"]?.stringValue ?? ""
            let age = kase["ageSeconds"]?.doubleValue ?? 0
            var raw: [String: JSONValue] = ["id": "f1", "deploy_progress": .object(record(kind, stage, ageSeconds: age, status: kase["status"]?.stringValue, progress: nil))]
            if let wake = kase["nextWakeInSeconds"]?.doubleValue {
                raw["next_wake_at"] = .string(FrameTime.iso(now + wake * 1000))
            }
            let stale = DeployProgress.view(Frame(raw: raw), now: now) == nil
            #expect(stale == kase["expect"]?.boolValue, "stale \(kind)/\(stage) after \(age)s")
        }
        for kase in fixtures["percent"]?.arrayValue ?? [] {
            let kind = kase["kind"]?.stringValue ?? ""
            let stage = kase["stage"]?.stringValue ?? ""
            let raw: [String: JSONValue] = ["id": "f1", "deploy_progress": .object(record(kind, stage, ageSeconds: 5, status: kase["status"]?.stringValue, progress: kase["progress"]))]
            #expect(DeployProgress.view(Frame(raw: raw), now: now)?.percent == kase["expect"]?.intValue, "percent \(kind)/\(stage)")
        }
    }

    @Test func timestampsParseLikeTheSPA() {
        let base = FrameTime.parse("2026-10-12T12:00:00Z")!
        #expect(FrameTime.parse("2026-10-12T12:00:00") == base)
        #expect(FrameTime.parse("2026-10-12T12:00:00.500000") == base + 500)
        #expect(FrameTime.parse("2026-10-12T14:00:00+02:00") == base)
        #expect(FrameTime.parse("2026-10-12T14:00:00+0200") == base)
        #expect(FrameTime.parse("2026-10-12 12:00:00") == base)
        #expect(FrameTime.parse("nonsense") == nil)
        #expect(FrameTime.parse("") == nil)
    }
}
