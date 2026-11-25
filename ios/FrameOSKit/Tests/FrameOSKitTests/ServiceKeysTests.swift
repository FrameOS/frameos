import Foundation
import Testing
@testable import FrameOSKit

/// Service keys (docs/service-keys.md): a service is any name an app's
/// config.json `settings` lists, and a cloud row's key choices follow its grant.
struct ServiceKeysTests {
    func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    @Test func installGrantsWhatTheScenesDeclare() throws {
        let scenes = try json("""
        [{"id": "a", "apps": {"w": {"sources": {"config.json": "{\\"settings\\": [\\"acmeWeather\\", \\"openAI\\"]}"}}},
          "nodes": [{"type": "app", "data": {"sources": {"config.json": "{\\"settings\\": [\\"tides\\"]}"}}}]}]
        """)
        let groups = FrameOSService.declaredServiceSettingGroups(scenes)
        #expect(groups.starts(with: FrameOSService.serviceSettingGroups))
        #expect(groups.contains("acmeWeather"))
        #expect(groups.contains("tides"))
        #expect(groups.filter { $0 == "openAI" }.count == 1)
        #expect(FrameOSService.declaredServiceSettingGroups(nil) == FrameOSService.serviceSettingGroups)
    }

    @Test func keyChoicesFollowTheGrant() throws {
        let keys = try json("""
        {"rt-1": {"openAI": "k_work00000001", "unsplash": null}, "rt-2": {"openAI": "default"}}
        """)
        let followed = try #require(FrameOSService.serviceKeysFollowingGrant(keys, ["unsplash"]))
        let expected = try json("""
        {"rt-1": {"openAI": null, "unsplash": "default"}, "rt-2": {"openAI": null}}
        """)
        #expect(followed == expected)
        #expect(FrameOSService.serviceKeysFollowingGrant(nil, ["openAI"]) == nil)
    }
}
