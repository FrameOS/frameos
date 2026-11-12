import Testing
@testable import FrameOSKit

/// What a scene installed on a backend gets as its picture (the SPA's
/// `templateImageSource` and `getScenesWithoutParents` in frameLogic.ts).
struct SceneCoverTests {
    @Test func sources() {
        let store = "https://scenes.frameos.net/api/store/scenes/851052e6-6ec7-4f17-b20d-9ab733bea572/image?v=6"
        #expect(FrameOSService.coverSource(store) == .copy(["url": .string(store)]))
        let bundled = "/api/repositories/system/samples/templates/Analog clock face/image"
        #expect(FrameOSService.coverSource(bundled) == .copy(["url": .string(bundled)]))
        #expect(FrameOSService.coverSource("/api/templates/42/image") == .copy(["template_id": "42"]))
        #expect(FrameOSService.coverSource("/api/projects/3/templates/abc/image") == .copy(["template_id": "abc"]))
        #expect(FrameOSService.coverSource("/api/cloud/store/drive/image/9") == .upload("/api/cloud/store/drive/image/9"))
        #expect(FrameOSService.coverSource(nil) == nil)
        #expect(FrameOSService.coverSource("") == nil)
        #expect(FrameOSService.coverSource("./image.jpg") == nil)
    }

    @Test func targets() {
        // A split drawing two panels: only the split gets the cover.
        let scenes: [JSONValue] = [
            ["id": "split", "nodes": [
                ["id": "n1", "type": "scene", "data": ["keyword": "left"]],
                ["id": "n2", "type": "scene", "data": ["keyword": "right"]],
            ]],
            ["id": "left", "nodes": []],
            ["id": "right", "nodes": []],
            ["id": "older", "nodes": [["id": "n3", "type": "scene", "data": ["keyword": "split"]]]],
        ]
        #expect(FrameOSService.coverTargets(["split", "left", "right"], frameScenes: scenes) == ["split"])
        // A scene already on the frame drawing a new one does not count.
        #expect(FrameOSService.coverTargets(["split"], frameScenes: scenes) == ["split"])
        #expect(FrameOSService.coverTargets(["a", "b"], frameScenes: []) == ["a", "b"])
    }
}
