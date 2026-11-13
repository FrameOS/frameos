import Foundation
import Testing
@testable import FrameOSKit

/// Layouts on a real plane (docs/scene-layouts.md), the same steps on both:
/// a starter added (on every scene when none wore one), one scene's layout
/// with settings, taken off again, and the layout removed. Called from
/// CloudIntegrationTests and BackendIntegrationTests.
enum LayoutRoundTrip {
    static func run(_ service: FrameOSService, frameId: String) async throws {
        var frame = try await service.frame(frameId)
        var installed = try await service.installedScenes(frame)

        // A scene to dress: the store's first, or the repo's Word clock as a
        // private scene of the account (a fresh cloud has no store).
        if installed.allSatisfy(\.isLayout) {
            var item = try await service.catalog().items.first { !$0.needsShell }
            if item == nil, service.kind == .cloud {
                let sample = try RepoFixtures.json("repo/scenes/samples/Word clock/scenes.json")
                _ = try await service.client.call("POST", "/api/account/scenes", body: .json([
                    "name": "Word clock", "scenes": sample,
                ]), timeout: 120)
                item = try await service.catalog(mine: true).items.first
            }
            let picked = try #require(item, "nothing to install")
            _ = try await service.install(picked, on: frame, activate: false)
            frame = try await service.frame(frameId)
            installed = try await service.installedScenes(frame)
        }
        let content = try #require(installed.first { !$0.isLayout })
        let layoutsBefore = Set(installed.filter(\.isLayout).map(\.id))
        let woreNone = SceneLayouts.commonId(installed.filter { !$0.isLayout }.map(\.scene), layoutIds: layoutsBefore) == ""

        // A starter: a new layout, with an id of its own.
        let starter = try #require(LayoutStarters.all.first { $0.name == "Top bar" })
        _ = try await service.addLayout(frame, starter: starter, installed: installed)
        frame = try await service.frame(frameId)
        installed = try await service.installedScenes(frame)
        let layout = try #require(installed.first { $0.isLayout && !layoutsBefore.contains($0.id) }, "the layout is not on the list")
        #expect(layout.name == "Top bar")
        #expect(layout.id != starter.scene["id"]?.stringValue)
        let layoutIds = Set(installed.filter(\.isLayout).map(\.id))
        if woreNone {
            #expect(SceneLayouts.commonId(installed.filter { !$0.isLayout }.map(\.scene), layoutIds: layoutIds) == layout.id,
                    "a frame wearing none puts the first on every scene")
        }

        // One scene: this layout, with settings.
        _ = try await service.setSceneLayouts(frame, installed: installed, changes: [
            content.id: SceneLayouts.ref(layoutId: layout.id, state: ["title": "IT bar"]),
        ])
        frame = try await service.frame(frameId)
        installed = try await service.installedScenes(frame)
        let dressed = try #require(installed.first { $0.id == content.id })
        #expect(dressed.scene["layout"] == ["sceneId": .string(layout.id), "state": ["title": "IT bar"]])

        // Off again.
        _ = try await service.setSceneLayouts(frame, installed: installed, changes: [content.id: .null])
        frame = try await service.frame(frameId)
        installed = try await service.installedScenes(frame)
        #expect(installed.first { $0.id == content.id }?.scene["layout"] == nil)

        // And the layout goes.
        _ = try await service.removeScene(frame, layout)
        frame = try await service.frame(frameId)
        #expect(try await service.installedScenes(frame).contains { $0.id == layout.id } == false)
    }
}
