import Foundation
import Testing
@testable import FrameOSKit

/// Layouts (docs/scene-layouts.md): the starters the app offers are the
/// repo's layout samples, and what scenes wear follows the SPA's rules
/// (frontend/src/utils/sceneLayouts.ts).
@Suite struct LayoutTests {
    func scene(_ id: String, layout: String? = nil, state: [String: JSONValue] = [:], isLayout: Bool = false) -> JSONValue {
        var object: [String: JSONValue] = ["id": .string(id), "name": .string(id)]
        if isLayout { object["settings"] = ["isLayout": true] }
        if let layout { object["layout"] = SceneLayouts.ref(layoutId: layout, state: state) }
        return .object(object)
    }

    @Test func startersAreTheRepoLayoutSamples() throws {
        // As frontend/scripts/generateLayoutStarters.mjs picks them: every
        // sample whose first scene is a layout. A sample added without
        // re-running the script fails here.
        let samples = RepoFixtures.repoRoot.appendingPathComponent("repo/scenes/samples")
        var expected: [String] = []
        for folder in try FileManager.default.contentsOfDirectory(atPath: samples.path) {
            let file = samples.appendingPathComponent(folder).appendingPathComponent("scenes.json")
            guard let data = try? Data(contentsOf: file),
                  let first = try JSONDecoder().decode(JSONValue.self, from: data).arrayValue?.first,
                  SceneLayouts.isLayout(first), let name = first["name"]?.stringValue else { continue }
            expected.append(name)
        }
        #expect(!expected.isEmpty)
        #expect(Set(LayoutStarters.all.map(\.name)) == Set(expected))
        for starter in LayoutStarters.all {
            #expect(SceneLayouts.isLayout(starter.scene), "\(starter.name) is not a layout")
            #expect(starter.image?.starts(with: [0xFF, 0xD8]) == true, "\(starter.name) has no JPEG picture")
            #expect(!starter.description.isEmpty)
        }
    }

    @Test func anAddedStarterGetsAFreshIdAndNoBootFlag() throws {
        let starter = try #require(LayoutStarters.all.first)
        let one = LayoutStarters.newScene(from: starter)
        let two = LayoutStarters.newScene(from: starter)
        #expect(one["id"]?.stringValue != starter.scene["id"]?.stringValue)
        #expect(one["id"]?.stringValue != two["id"]?.stringValue)
        #expect(one["default"] == nil)
        #expect(SceneLayouts.isLayout(one))
        #expect(one["nodes"] == starter.scene["nodes"])
    }

    @Test func whatEveryScenesWears() {
        let layouts: Set<String> = ["bar", "rail"]
        let none = [scene("a"), scene("b")]
        #expect(SceneLayouts.commonId(none, layoutIds: layouts) == "")
        let same = [scene("a", layout: "bar"), scene("b", layout: "bar", state: ["dark": true])]
        #expect(SceneLayouts.commonId(same, layoutIds: layouts) == "bar")
        let mixed = [scene("a", layout: "bar"), scene("b")]
        #expect(SceneLayouts.commonId(mixed, layoutIds: layouts) == nil)
        // A layout the frame no longer has reads as none.
        let gone = [scene("a", layout: "removed"), scene("b")]
        #expect(SceneLayouts.commonId(gone, layoutIds: layouts) == "")
        #expect(SceneLayouts.current(scene("a", layout: "removed"), layoutIds: layouts) == nil)
    }

    @Test func pickingOneForEveryScene() {
        let scenes = [
            scene("a", layout: "bar", state: ["dark": true]),
            scene("b", layout: "rail"),
            scene("c"),
            scene("bar", isLayout: true),
        ]
        let worn = SceneLayouts.onEveryScene(scenes, layoutId: "bar")
        // A scene already wearing it keeps its settings; layouts are left alone.
        #expect(worn[0]["layout"] == ["sceneId": "bar", "state": ["dark": true]])
        #expect(worn[1]["layout"] == ["sceneId": "bar"])
        #expect(worn[2]["layout"] == ["sceneId": "bar"])
        #expect(worn[3]["layout"] == nil)
        let bare = SceneLayouts.onEveryScene(worn, layoutId: "")
        #expect(bare.allSatisfy { $0["layout"] == nil })
        // Empty settings are no settings (sceneLayoutRef).
        #expect(SceneLayouts.ref(["sceneId": "bar", "state": [:]]) == ["sceneId": "bar"])
        #expect(SceneLayouts.ref(["state": ["x": 1]]) == nil)
    }

    @Test func cloudRowsGetTheirOwnScenesLayouts() {
        let client = APIClient(account: Account(kind: .cloud, baseURL: URL(string: "https://cloud.example")!, email: "a@b.c"),
                               credentials: AccountCredentials())
        let service = FrameOSService(client: client)
        let installed = [
            InstalledScene(scene: scene("clock"), storeSceneId: "store-1", packSize: 2),
            InstalledScene(scene: scene("weather"), storeSceneId: "store-1", packSize: 2),
            InstalledScene(scene: scene("photos", layout: "bar"), storeSceneId: "store-2"),
            InstalledScene(scene: scene("bar", isLayout: true), storeSceneId: "store-3"),
        ]
        let rows: [JSONValue] = [
            ["scene_id": "store-1", "position": 0, "layouts": ["clock": ["sceneId": "old"]]],
            ["scene_id": "store-2", "position": 1, "layouts": ["photos": ["sceneId": "bar"]]],
            ["scene_id": "store-3", "position": 2],
        ]
        let changes: [String: JSONValue] = ["clock": ["sceneId": "bar"], "weather": ["sceneId": "bar"], "photos": .null]
        let layouts = service.cloudLayouts(rows, installed: installed, changes: changes)
        #expect(layouts["store-1"] == ["clock": ["sceneId": "bar"], "weather": ["sceneId": "bar"]])
        // The last layout gone: null clears the row's.
        #expect(layouts["store-2"] == .null)
        // Untouched rows are left out, which the cloud reads as "keep".
        #expect(layouts["store-3"] == nil)
    }
}
