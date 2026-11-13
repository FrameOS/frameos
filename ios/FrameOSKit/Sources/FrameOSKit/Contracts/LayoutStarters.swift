import Foundation

/// The layout starters (docs/scene-layouts.md "Starters"): every repo sample
/// whose scene is a layout, as the SPA offers them (frontend/src/generated/
/// layoutStarters.ts). Both lists are written by
/// frontend/scripts/generateLayoutStarters.mjs from repo/scenes/samples;
/// LayoutStarterTests checks this one against the samples.
public struct LayoutStarter: Identifiable, Sendable {
    public var name: String
    public var description: String
    /// The sample's thumb.jpg.
    public var image: Data?
    /// The layout scene, as the sample has it (its id is replaced when added).
    public var scene: JSONValue

    public var id: String { name }
}

public enum LayoutStarters {
    public static let all: [LayoutStarter] = {
        guard let url = Bundle.module.url(forResource: "LayoutStarters", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode(JSONValue.self, from: data).arrayValue
        else { return [] }
        return list.compactMap { entry in
            guard let name = entry["name"]?.stringValue, let scene = entry["scene"], scene.objectValue != nil else { return nil }
            let image = entry["image"]?.stringValue.flatMap { url -> Data? in
                guard let comma = url.firstIndex(of: ",") else { return nil }
                return Data(base64Encoded: String(url[url.index(after: comma)...]))
            }
            return LayoutStarter(name: name, description: entry["description"]?.stringValue ?? "", image: image, scene: scene)
        }
    }()

    /// The starter as a new scene for a frame: a fresh id, so the same
    /// starter can be added twice (the SPA's applyTemplate gives template
    /// scenes new ids too), and never the frame's boot scene.
    public static func newScene(from starter: LayoutStarter, id: String = UUID().uuidString.lowercased()) -> JSONValue {
        var scene = starter.scene.objectValue ?? [:]
        scene["id"] = .string(id)
        scene["default"] = nil
        scene["layout"] = nil
        return .object(scene)
    }
}

/// Which layout each scene wears, as the SPA reads and writes it
/// (frontend/src/utils/sceneLayouts.ts): `layout: {sceneId, state?}` on the
/// installed scene, the install's and never the scene's.
extension SceneLayouts {
    public static func isLayout(_ scene: JSONValue) -> Bool {
        scene["settings"]?["isLayout"]?.boolValue == true
    }

    /// The layout a scene wears, by what the frame still has: one removed
    /// since reads as none (the runtime draws such a scene without one too).
    public static func current(_ scene: JSONValue, layoutIds: Set<String>) -> JSONValue? {
        guard let ref = ref(scene["layout"]), let id = ref["sceneId"]?.stringValue, layoutIds.contains(id) else { return nil }
        return ref
    }

    /// The layout id every scene shares ("" when none of them wears one), or
    /// nil when they differ (commonSceneLayoutId).
    public static func commonId(_ contents: [JSONValue], layoutIds: Set<String>) -> String? {
        let ids = Set(contents.map { current($0, layoutIds: layoutIds)?["sceneId"]?.stringValue ?? "" })
        return ids.count > 1 ? nil : (ids.first ?? "")
    }

    /// The scene wearing `layout` (a ref, or nil for none).
    public static func with(_ scene: JSONValue, layout: JSONValue?) -> JSONValue {
        var object = scene.objectValue ?? [:]
        if let layout = ref(layout) {
            object["layout"] = layout
        } else {
            object["layout"] = nil
        }
        return .object(object)
    }

    /// What every scene wears once one layout (or "" for none) is picked for
    /// all of them: layouts are left alone, and a scene already wearing it
    /// keeps its settings (withLayoutOnEveryScene).
    public static func onEveryScene(_ scenes: [JSONValue], layoutId: String) -> [JSONValue] {
        scenes.map { scene in
            if isLayout(scene) { return scene }
            if layoutId.isEmpty { return with(scene, layout: nil) }
            if let worn = ref(scene["layout"]), worn["sceneId"]?.stringValue == layoutId { return with(scene, layout: worn) }
            return with(scene, layout: ["sceneId": .string(layoutId)])
        }
    }

    /// A ref to `layoutId` with these settings; empty settings are left off.
    public static func ref(layoutId: String, state: [String: JSONValue]) -> JSONValue {
        state.isEmpty ? ["sceneId": .string(layoutId)] : ["sceneId": .string(layoutId), "state": .object(state)]
    }
}
