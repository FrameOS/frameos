import Foundation

/// A scene on a frame's list. On a backend the frame row holds the scene
/// JSON; on the cloud a row is a store scene assignment whose runtime scenes
/// come from the store's scenes.json (the SPA's fetchCloudFrameScenes,
/// frontend/src/models/framesModel.tsx).
public struct InstalledScene: Identifiable, Hashable, Sendable {
    /// The runtime scene JSON (a stub with no nodes when the store could not be read).
    public var scene: JSONValue
    /// Cloud: the store scene this runtime scene came with.
    public var storeSceneId: String?
    /// Cloud: the version the frame holds (`assigned_version ?? scene_version`).
    public var heldVersion: Int?
    public var latestVersion: Int?
    public var updateAvailable: Bool
    /// Cloud: how many runtime scenes ride the same store scene (they go together).
    public var packSize: Int
    public var declaredSettingsGroups: [String]
    public var grantedSettingsGroups: [String]

    public init(scene: JSONValue, storeSceneId: String? = nil, heldVersion: Int? = nil, latestVersion: Int? = nil,
                updateAvailable: Bool = false, packSize: Int = 1, declaredSettingsGroups: [String] = [],
                grantedSettingsGroups: [String] = [])
    {
        self.scene = scene
        self.storeSceneId = storeSceneId
        self.heldVersion = heldVersion
        self.latestVersion = latestVersion
        self.updateAvailable = updateAvailable
        self.packSize = packSize
        self.declaredSettingsGroups = declaredSettingsGroups
        self.grantedSettingsGroups = grantedSettingsGroups
    }

    public var id: String { scene["id"]?.stringValue ?? storeSceneId ?? "" }
    public var name: String {
        let name = scene["name"]?.stringValue ?? ""
        return name.isEmpty ? "Untitled scene" : name
    }
    public var isLayout: Bool { scene["settings"]?["isLayout"]?.boolValue == true }
    public var isDefault: Bool { scene["default"]?.boolValue == true }
    public var fields: [SceneField] { SceneForm.stateFields(scene) }
    public var hasNodes: Bool { !(scene["nodes"]?.arrayValue ?? []).isEmpty }
    public var refreshInterval: Double? { scene["settings"]?["refreshInterval"]?.doubleValue }
    public var missingSettingsGroups: [String] {
        declaredSettingsGroups.filter { !grantedSettingsGroups.contains($0) }
    }
}

/// `scene_preview` on the frame: a scene shown for now (docs/scene-previews.md).
public struct ScenePreview: Hashable, Sendable {
    public var sceneId: String?
    public var name: String
    public var source: String
    public var at: String?

    public init?(_ value: JSONValue?) {
        guard let value, let object = value.objectValue else { return nil }
        sceneId = object["scene_id"]?.stringValue
        name = object["name"]?.stringValue ?? "Preview"
        source = object["source"]?.stringValue ?? "editor"
        at = object["at"]?.stringValue
    }
}

/// The values of every scene's fields as the frame last reported them
/// (`GET …/states`, both planes).
public struct FrameStates: Sendable, Equatable {
    public var activeSceneId: String?
    public var states: [String: [String: JSONValue]]
    /// The plane is fetching newer values: ask again after `retryAfter` seconds.
    public var refreshing: Bool
    public var retryAfter: Double?

    public init(activeSceneId: String? = nil, states: [String: [String: JSONValue]] = [:], refreshing: Bool = false, retryAfter: Double? = nil) {
        self.activeSceneId = activeSceneId
        self.states = states
        self.refreshing = refreshing
        self.retryAfter = retryAfter
    }
}

/// Legacy runtimes report a handed scene as `uploaded/<id>` (the SPA's
/// publicSceneId, frontend/src/utils/systemScenes.ts).
public enum SceneIds {
    public static func publicId(_ id: String) -> String {
        id.hasPrefix("uploaded/") ? String(id.dropFirst("uploaded/".count)) : id
    }

    public static func refer(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b, !a.isEmpty, !b.isEmpty else { return false }
        return publicId(a) == publicId(b)
    }

    /// The scenes every runtime has built in: never on a list.
    public static func isBuiltIn(_ id: String) -> Bool {
        id == "system/sceneSwitcher" || id == "system/sceneSettings" || id == "system/index"
    }
}

/// The store's scenes.json, cached by `scene_id@version` (a version never changes).
actor StoreSceneCache {
    static let shared = StoreSceneCache()
    private var entries: [String: [JSONValue]] = [:]

    func get(_ key: String) -> [JSONValue]? { entries[key] }
    func set(_ key: String, _ value: [JSONValue]) { entries[key] = value }
}

extension FrameOSService {
    /// The scenes on a frame's list, layouts left out (they wrap scenes, they
    /// are never shown alone), in the plane's order.
    public func installedScenes(_ frame: Frame) async throws -> [InstalledScene] {
        switch kind {
        case .backend:
            let scenes = (frame["scenes"]?.arrayValue ?? []).filter { $0.objectValue != nil }
            return scenes.map { InstalledScene(scene: $0) }
        case .cloud:
            let answer = try await client.get(Self.framePath(frame.id, "/scenes"))
            let rows = answer["scenes"]?.arrayValue ?? []
            return try await withThrowingTaskGroup(of: (Int, [InstalledScene]).self) { group in
                for (index, row) in rows.enumerated() {
                    group.addTask { (index, await self.hydrateCloudRow(row)) }
                }
                var results: [(Int, [InstalledScene])] = []
                for try await result in group { results.append(result) }
                return results.sorted { $0.0 < $1.0 }.flatMap(\.1)
            }
        }
    }

    /// One assignment row → its runtime scenes (cloudFrameScenes.ts).
    func hydrateCloudRow(_ row: JSONValue) async -> [InstalledScene] {
        let storeId = row["scene_id"]?.stringValue ?? ""
        let held = row["assigned_version"]?.intValue ?? row["scene_version"]?.intValue
        let latest = row["latest_version"]?.intValue
        let updateAvailable = row["update_available"]?.boolValue == true && (latest ?? 0) > (held ?? 0)
        let declared = row["declared_settings_groups"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let granted = row["granted_settings_groups"]?.arrayValue?.compactMap(\.stringValue) ?? []
        var scenes: [JSONValue]
        let key = "\(storeId)@\(held.map(String.init) ?? "latest")"
        if let cached = await StoreSceneCache.shared.get(key) {
            scenes = cached
        } else if let fetched = try? await client.get("/api/store/scenes/\(ApiPaths.segment(storeId))/scenes.json",
                                                      query: ["version": held.map(String.init)]),
            let list = fetched.arrayValue, !list.isEmpty
        {
            scenes = list
            await StoreSceneCache.shared.set(key, list)
        } else {
            let name = row["name"]?.stringValue ?? row["slug"]?.stringValue ?? "Untitled scene"
            scenes = [["id": .string(storeId), "name": .string(name), "nodes": [], "edges": []]]
        }
        let eventMaps = row["event_maps"]?.objectValue ?? [:]
        let layouts = row["layouts"]?.objectValue ?? [:]
        return scenes.map { scene in
            var object = scene.objectValue ?? [:]
            let id = object["id"]?.stringValue ?? ""
            if let map = eventMaps[id] { object["eventMap"] = map }
            if let layout = layouts[id] { object["layout"] = layout }
            return InstalledScene(scene: .object(object), storeSceneId: storeId, heldVersion: held, latestVersion: latest,
                                  updateAvailable: updateAvailable, packSize: scenes.count,
                                  declaredSettingsGroups: declared, grantedSettingsGroups: granted)
        }
    }

    /// The scene the frame shows, from the row (no request).
    public func activeSceneId(_ frame: Frame) -> String? {
        switch kind {
        case .backend: return frame["active_scene_id"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        case .cloud: return frame["last_state"]?["active_scene"]?.stringValue
        }
    }

    public func states(_ frame: Frame, refresh: Bool = false) async throws -> FrameStates {
        let answer = try await client.get(Self.framePath(frame.id, "/states"),
                                          query: ["refresh": refresh && kind == .backend ? "true" : nil])
        var states: [String: [String: JSONValue]] = [:]
        for (key, value) in answer["states"]?.objectValue ?? [:] {
            states[SceneIds.publicId(key)] = value.objectValue ?? [:]
        }
        let active = answer["sceneId"]?.stringValue.flatMap { $0.isEmpty ? nil : SceneIds.publicId($0) }
        return FrameStates(activeSceneId: active ?? activeSceneId(frame), states: states,
                           refreshing: answer["cache"]?["refreshing"]?.boolValue ?? false,
                           retryAfter: answer["cache"]?["retry_after"]?.doubleValue)
    }

    /// "Activate" and the scene form's "Apply": `POST …/event/setCurrentScene
    /// {sceneId, state?}` on both planes (controlLogic.setCurrentScene).
    public func activate(_ frame: Frame, sceneId: String, state: [String: JSONValue] = [:]) async throws -> ActionOutcome {
        var payload: [String: JSONValue] = ["sceneId": .string(sceneId)]
        if !state.isEmpty { payload["state"] = .object(state) }
        let answer = try await client.call("POST", Self.framePath(frame.id, "/event/setCurrentScene"), body: .json(.object(payload)))
        if answer["type"]?.stringValue == "set_scenes" {
            return ActionOutcome(kind: .queued, message: "Pushed with the frame's scenes; it shows it when it next checks in.")
        }
        return ActionOutcome.from(answer, queuedMessage: "Queued. The frame switches when it next checks in.")
    }

    /// Remove a scene from the frame's list and push the rest.
    /// Cloud: the scene's store scene goes, with every runtime scene it brought.
    public func removeScene(_ frame: Frame, _ scene: InstalledScene) async throws -> ActionOutcome {
        switch kind {
        case .backend:
            let scenes = (frame["scenes"]?.arrayValue ?? []).filter { $0["id"]?.stringValue != scene.id }
            try await client.call("POST", Self.framePath(frame.id), body: .json(["scenes": .array(scenes)]))
            return try await deploy(frame)
        case .cloud:
            guard let storeId = scene.storeSceneId else { throw APIError(status: 0, message: "This scene has no store scene to remove.") }
            let answer = try await client.get(Self.framePath(frame.id, "/scenes"))
            let rows = (answer["scenes"]?.arrayValue ?? []).filter { $0["scene_id"]?.stringValue != storeId }
            try await pushCloudRows(frame, rows)
            return ActionOutcome(kind: .queued, message: "Removed. The frame gets the new list when it next checks in.")
        }
    }

    /// The cloud's whole-list push (`POST …/scenes`), every row kept as the
    /// frame holds it (the SPA's pushCloudFrameSceneList).
    func pushCloudRows(_ frame: Frame, _ rows: [JSONValue], activeSceneId: String? = nil) async throws {
        let list: [JSONValue] = rows.map { row in
            var entry: [String: JSONValue] = ["scene_id": row["scene_id"] ?? .null]
            if let version = row["scene_version"], !version.isNull { entry["scene_version"] = version }
            entry["settings_groups"] = row["granted_settings_groups"] ?? []
            return .object(entry)
        }
        var body: [String: JSONValue] = ["scenes": .array(list)]
        if let activeSceneId { body["scene_id"] = .string(activeSceneId) }
        try await client.call("POST", Self.framePath(frame.id, "/scenes"), body: .json(.object(body)))
    }

    /// "Update to latest" (cloud): `POST …/scenes/update`, keeping what shows on screen.
    public func updateScene(_ frame: Frame, storeSceneId: String) async throws -> ActionOutcome {
        var body: [String: JSONValue] = ["scene_id": .string(storeSceneId)]
        if let active = activeSceneId(frame) { body["active_scene_id"] = .string(active) }
        let answer = try await client.call("POST", Self.framePath(frame.id, "/scenes/update"), body: .json(.object(body)))
        if answer["status"]?.stringValue == "up_to_date" {
            return ActionOutcome(kind: .done, message: "Already the newest version.")
        }
        return ActionOutcome(kind: .queued, message: "Updated. The frame gets it when it next checks in.")
    }

    /// Grant a cloud scene the account's API keys it asks for.
    public func grantSettings(_ frame: Frame, storeSceneId: String, groups: [String]) async throws {
        let answer = try await client.get(Self.framePath(frame.id, "/scenes"))
        let rows = (answer["scenes"]?.arrayValue ?? []).map { row -> JSONValue in
            guard row["scene_id"]?.stringValue == storeSceneId, var object = row.objectValue else { return row }
            object["granted_settings_groups"] = .array(groups.map { .string($0) })
            return .object(object)
        }
        try await pushCloudRows(frame, rows, activeSceneId: activeSceneId(frame))
    }

    // MARK: the preview row

    func previewPath(_ frame: Frame) -> String {
        // The backend's route has an underscore, the cloud's a hyphen.
        Self.framePath(frame.id, kind == .backend ? "/scene_preview" : "/scene-preview")
    }

    /// Discard the preview the frame shows and push the saved list back.
    public func discardPreview(_ frame: Frame) async throws -> ActionOutcome {
        do {
            try await client.call("DELETE", previewPath(frame))
        } catch let error as APIError where error.status == 404 {
            // Nothing to discard.
        }
        switch kind {
        case .backend:
            return try await deploy(frame)
        case .cloud:
            let answer = try await client.get(Self.framePath(frame.id, "/scenes"))
            try await pushCloudRows(frame, answer["scenes"]?.arrayValue ?? [])
            return ActionOutcome(kind: .queued, message: "Discarded. The frame goes back to its scenes when it next checks in.")
        }
    }

    /// Put the previewed scene on the frame's list, its id kept (scenesLogic.installPreviewScene).
    public func installPreview(_ frame: Frame) async throws -> ActionOutcome {
        let answer = try await client.get(previewPath(frame))
        guard let scene = answer["scene"], let sceneId = scene["id"]?.stringValue else {
            throw APIError(status: 404, message: "The frame shows no preview.")
        }
        switch kind {
        case .backend:
            var scenes = frame["scenes"]?.arrayValue ?? []
            if !scenes.contains(where: { $0["id"]?.stringValue == sceneId }) {
                var copy = scene.objectValue ?? [:]
                copy["default"] = nil
                scenes.append(.object(copy))
            }
            try await client.call("POST", Self.framePath(frame.id), body: .json(["scenes": .array(scenes)]))
            return try await deploy(frame)
        case .cloud:
            let name = scene["name"]?.stringValue ?? "Preview"
            let created = try await client.call("POST", "/api/account/scenes", body: .json([
                "name": .string(name), "scenes": .array([scene]),
            ]))
            guard let storeId = created["scene"]?["id"]?.stringValue else {
                throw APIError(status: 0, message: "The scene could not be saved to your scenes.")
            }
            let list = try await client.get(Self.framePath(frame.id, "/scenes"))
            var rows = list["scenes"]?.arrayValue ?? []
            rows.append(["scene_id": .string(storeId)])
            try await pushCloudRows(frame, rows, activeSceneId: sceneId)
            return ActionOutcome(kind: .queued, message: "Installed. It stays on the frame's list.")
        }
    }
}
