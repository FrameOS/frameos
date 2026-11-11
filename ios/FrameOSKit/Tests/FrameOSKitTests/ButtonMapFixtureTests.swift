import Testing
@testable import FrameOSKit

/// The iOS runner of docs/button-map-fixtures.json.
@Suite struct ButtonMapFixtureTests {
    @Test func buttonMapCorpus() throws {
        let fixtures = try RepoFixtures.json("docs/button-map-fixtures.json")
        let cases = try #require(fixtures["cases"]?.arrayValue)
        #expect(cases.count > 10)
        for (index, kase) in cases.enumerated() {
            let rule = try #require(kase["rule"])
            let binding = ButtonBindings.binding(of: rule)
            guard let expected = kase["expect"], !expected.isNull else {
                #expect(binding == nil, "rule \(index) is not a row")
                continue
            }
            let row = try #require(binding, "rule \(index) is a row")
            let gesture = expected["binding"]?["gesture"]
            switch row.gesture {
            case .button(let label, let action):
                #expect(gesture?["label"]?.stringValue == label && gesture?["action"]?.stringValue == action, "rule \(index) gesture")
            case .edge(let edge):
                #expect(gesture?["edge"]?.stringValue == edge, "rule \(index) gesture")
            }
            #expect(row.kind == expected["binding"]?["action"]?["kind"]?.stringValue, "rule \(index) kind")
            #expect(row.sceneId == expected["binding"]?["action"]?["sceneId"]?.stringValue, "rule \(index) scene")
            #expect(ButtonBindings.gestureTitle(row.gesture) == expected["gestureTitle"]?.stringValue, "rule \(index) gesture title")
            #expect(ButtonBindings.actionTitle(row) { $0 == "weather" ? "Weather" : nil } == expected["actionTitle"]?.stringValue,
                    "rule \(index) action title")
            #expect(ButtonBindings.rule(row) == expected["rule"], "rule \(index) written back")
        }
    }
}
