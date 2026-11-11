import Foundation

/// What only FrameOS Cloud has for a frame (docs/api-triality.md "The fourth
/// plane"): confirming a claimed frame, the scenes a frame brought with it,
/// local network access (docs/lan-access.md) and the frame's two link
/// switches. Each is the route the SPA calls for it.
extension FrameOSService {
    /// A frame enrolled with a claim token waits for its owner: `POST …/confirm`.
    public func confirmFrame(_ frame: Frame) async throws {
        try await client.call("POST", Self.framePath(frame.id, "/confirm"))
    }

    /// The scenes a frame ran before it joined (`GET …/device-scenes`),
    /// when there are some to import (the SPA's CloudDeviceScenesBanner).
    public func deviceScenes(_ frame: Frame) async throws -> (count: Int, names: [String])? {
        guard kind == .cloud else { return nil }
        let answer = try await client.get(Self.framePath(frame.id, "/device-scenes"))
        guard let summary = answer["device_scenes"], summary["status"]?.stringValue == "ready" else { return nil }
        let names = (summary["scenes"]?.arrayValue ?? []).compactMap { $0["name"]?.stringValue }
        let count = summary["scene_count"]?.intValue ?? names.count
        return count > 0 ? (count, names) : nil
    }

    /// Import them into the account and the frame's list, or leave them.
    public func resolveDeviceScenes(_ frame: Frame, importThem: Bool) async throws -> ActionOutcome {
        let answer = try await client.call("POST", Self.framePath(frame.id, "/device-scenes"),
                                           body: .json(["action": importThem ? "import" : "dismiss"]), timeout: 120)
        if !importThem { return ActionOutcome(kind: .done, message: "Left as they are.") }
        let imported = answer["imported"]?.arrayValue?.count ?? 0
        let reused = answer["reused"]?.arrayValue?.count ?? 0
        return ActionOutcome(kind: .done, message: "Imported \(imported + reused) scene\(imported + reused == 1 ? "" : "s").")
    }

    /// Local network access as the frame reports it (`lan_access`); nil when
    /// its firmware does not say.
    public func lanAccess(_ frame: Frame) -> Bool? {
        guard kind == .cloud else { return nil }
        if case .bool(let value)? = frame["lan_access"] { return value }
        return nil
    }

    /// Ask the frame to draw the six-digit code. true: it shows it now;
    /// false: queued for a frame that is asleep or offline.
    public func showLanAccessCode(_ frame: Frame) async throws -> Bool {
        let answer = try await client.call("POST", Self.framePath(frame.id, "/lan_access/challenge"), body: .json([:]), timeout: 45)
        return answer["status"]?.stringValue != "queued"
    }

    /// Turn it on (with the code from the panel) or off (no code needed).
    public func setLanAccess(_ frame: Frame, enabled: Bool, code: String?) async throws -> ActionOutcome {
        var body: [String: JSONValue] = ["enabled": .bool(enabled)]
        if let code, !code.isEmpty { body["code"] = .string(code) }
        let answer = try await client.call("POST", Self.framePath(frame.id, "/lan_access"), body: .json(.object(body)), timeout: 45)
        if answer["status"]?.stringValue == "queued" {
            return ActionOutcome(kind: .queued, message: "Queued. The frame changes it when it next checks in.")
        }
        return ActionOutcome(kind: .done, message: enabled ? "Local network access is on." : "Local network access is off.")
    }

    /// Whether the frame may read the account's API keys, and whether it
    /// sends its logs and metrics (`service_settings_enabled`, `telemetry_enabled`).
    public func setLinkSwitch(_ frame: Frame, telemetry: Bool, enabled: Bool) async throws {
        let route = telemetry ? "/telemetry/enabled" : "/service-settings/enabled"
        try await client.call("POST", Self.framePath(frame.id, route), body: .json(["enabled": .bool(enabled)]))
    }
}
