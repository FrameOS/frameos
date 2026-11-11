import Foundation

/// A frame's layouts (docs/scene-layouts.md), as the SPA's Layouts settings
/// change them (frameLayoutsLogic, sceneLayoutLogic): which layout each scene
/// wears, its settings for that scene, and adding a starter. What a scene
/// wears is the install's: on a backend `layout` on the frame's scene entry
/// (saved, then deployed), on the cloud the assignment row's `layouts` by
/// runtime scene id (cloudFrameScenesSave.ts).
extension FrameOSService {
    /// Sets what scenes wear: `changes` maps runtime scene ids to a layout ref
    /// (`{sceneId, state?}`) or `.null` for none. `installed` is the list the
    /// app shows (it says which cloud row holds which runtime scene).
    public func setSceneLayouts(_ frame: Frame, installed: [InstalledScene],
                                changes: [String: JSONValue]) async throws -> ActionOutcome
    {
        guard !changes.isEmpty else { return ActionOutcome(kind: .done, message: "Nothing changed.") }
        switch kind {
        case .backend:
            let scenes = (frame["scenes"]?.arrayValue ?? []).map { scene -> JSONValue in
                guard let id = scene["id"]?.stringValue, let change = changes[id] else { return scene }
                return SceneLayouts.with(scene, layout: change)
            }
            try await client.call("POST", Self.framePath(frame.id), body: .json(["scenes": .array(scenes)]))
            return try await deploy(frame)
        case .cloud:
            let answer = try await client.get(Self.framePath(frame.id, "/scenes"))
            let rows = answer["scenes"]?.arrayValue ?? []
            try await pushCloudRows(frame, rows, layouts: cloudLayouts(rows, installed: installed, changes: changes))
            return ActionOutcome(kind: .queued, message: "Saved. The frame gets it when it next checks in.")
        }
    }

    /// Each touched row's new `layouts` (`.null` when none is left): rows
    /// that keep theirs are left out, which the cloud reads as "keep".
    func cloudLayouts(_ rows: [JSONValue], installed: [InstalledScene], changes: [String: JSONValue]) -> [String: JSONValue] {
        var runtimeIds: [String: [String]] = [:]
        for scene in installed {
            if let storeId = scene.storeSceneId { runtimeIds[storeId, default: []].append(scene.id) }
        }
        var result: [String: JSONValue] = [:]
        for row in rows {
            guard let storeId = row["scene_id"]?.stringValue else { continue }
            let ids = (runtimeIds[storeId] ?? []).filter { changes[$0] != nil }
            guard !ids.isEmpty else { continue }
            var layouts = row["layouts"]?.objectValue ?? [:]
            for id in ids {
                layouts[id] = SceneLayouts.ref(changes[id])
            }
            result[storeId] = layouts.isEmpty ? .null : .object(layouts)
        }
        return result
    }

    /// Adds a starter as a new layout. A frame whose scenes wear none puts it
    /// on every scene; next to one already in use it waits to be picked (the
    /// SPA's addStarterLayout). Cloud: the starter becomes a private scene of
    /// the account first (each added layout its own), then joins the list.
    public func addLayout(_ frame: Frame, starter: LayoutStarter, installed: [InstalledScene]) async throws -> ActionOutcome {
        let scene = LayoutStarters.newScene(from: starter)
        let newId = scene["id"]?.stringValue ?? ""
        let layoutIds = Set(installed.filter(\.isLayout).map(\.id))
        let contents = installed.filter { !$0.isLayout && !SceneIds.isBuiltIn($0.id) }
        let wearsNone = SceneLayouts.commonId(contents.map(\.scene), layoutIds: layoutIds) == ""
        switch kind {
        case .backend:
            var scenes = frame["scenes"]?.arrayValue ?? []
            scenes.append(scene)
            if wearsNone { scenes = SceneLayouts.onEveryScene(scenes, layoutId: newId) }
            try await client.call("POST", Self.framePath(frame.id), body: .json(["scenes": .array(scenes)]))
            return try await deploy(frame)
        case .cloud:
            let created = try await client.call("POST", "/api/account/scenes", body: .json([
                "name": .string(starter.name), "scenes": .array([scene]),
            ]), timeout: 120)
            guard let storeId = created["scene"]?["id"]?.stringValue else {
                throw APIError(status: 0, message: "The layout could not be saved to your scenes.")
            }
            let answer = try await client.get(Self.framePath(frame.id, "/scenes"))
            var rows = answer["scenes"]?.arrayValue ?? []
            var layouts: [String: JSONValue] = [:]
            if wearsNone {
                var changes: [String: JSONValue] = [:]
                for content in contents { changes[content.id] = ["sceneId": .string(newId)] }
                layouts = cloudLayouts(rows, installed: installed, changes: changes)
            }
            rows.append(["scene_id": .string(storeId), "granted_settings_groups": []])
            try await pushCloudRows(frame, rows, layouts: layouts)
            return ActionOutcome(kind: .queued, message: wearsNone
                ? "Added and put on every scene. The frame gets it when it next checks in."
                : "Added. Pick it for the scenes that should wear it.")
        }
    }
}
