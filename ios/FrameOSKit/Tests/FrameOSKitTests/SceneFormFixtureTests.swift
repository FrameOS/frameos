import Testing
@testable import FrameOSKit

/// The iOS runner of docs/scene-form-fixtures.json (the SPA's is
/// cloud/apps/auth-web/src/test/shared-spa/scene-form-fixtures.test.ts).
@Suite struct SceneFormFixtureTests {
    @Test func sceneFormCorpus() throws {
        let fixtures = try RepoFixtures.json("docs/scene-form-fixtures.json")
        let cases = try #require(fixtures["cases"]?.arrayValue)
        #expect(cases.count > 10)
        for kase in cases {
            let name = kase["name"]?.stringValue ?? "?"
            let fields = SceneForm.stateFields(kase["scene"])
            let expectedFields = kase["expect"]?["fields"]?.arrayValue ?? []
            #expect(fields.count == expectedFields.count, "\(name): field count")
            for (field, expected) in zip(fields, expectedFields) {
                #expect(field.name == expected["name"]?.stringValue, "\(name): name")
                #expect(field.raw["label"] ?? .null == expected["label"] ?? .null, "\(name): \(field.name) label")
                #expect(field.type == expected["type"]?.stringValue, "\(name): \(field.name) type")
                #expect(field.raw["value"] ?? .null == expected["value"] ?? .null, "\(name): \(field.name) value")
                #expect(field.raw["access"] ?? .null == expected["access"] ?? .null, "\(name): \(field.name) access")
                #expect(field.raw["role"] ?? .null == expected["role"] ?? .null, "\(name): \(field.name) role")
            }
            let sources = (kase["values"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
            let visible = SceneForm.visiblePublicFields(fields, sources).map(\.name)
            let expectedVisible = (kase["expect"]?["visible"]?.arrayValue ?? []).compactMap(\.stringValue)
            #expect(visible == expectedVisible, "\(name): visible")
        }
    }

    @Test func applyStateTypesValues() {
        let fields = [
            SceneField(raw: ["name": "on", "type": "boolean"]),
            SceneField(raw: ["name": "count", "type": "integer"]),
            SceneField(raw: ["name": "zoom", "type": "float"]),
            SceneField(raw: ["name": "title", "type": "string"]),
        ]
        let state = SceneForm.applyState(fields, values: ["on": "true", "count": "7.9", "zoom": "1.25", "title": "Hi"])
        #expect(state["on"] == .bool(true))
        #expect(state["count"] == .number(7))
        #expect(state["zoom"] == .number(1.25))
        #expect(state["title"] == "Hi")
    }
}
