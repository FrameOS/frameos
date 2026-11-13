import Foundation

/// A frame as either control plane serves it (`GET /api/frames`,
/// `GET /api/frames/:id`). The two planes send different subsets of one
/// snake_case shape (the SPA's `FrameType` in frontend/src/types.tsx), so the
/// app keeps the whole object and reads fields by their wire names, the way
/// the SPA does: a field one plane lacks reads as absent, and a settings save
/// sends back what it did not touch exactly as it came.
public struct Frame: Identifiable, Hashable, Sendable, Decodable {
    public var raw: [String: JSONValue]

    public init(raw: [String: JSONValue]) {
        self.raw = raw
    }

    public init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard let object = value.objectValue else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "frame is not an object"))
        }
        self.raw = object
    }

    public subscript(key: String) -> JSONValue? { raw[key] }

    /// Backend ids are integers, cloud ids uuids: both travel as text here.
    public var id: String { raw["id"]?.stringValue ?? "" }
    public var name: String { raw["name"]?.stringValue ?? "" }
    public var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { return trimmed }
        if let host = raw["frame_host"]?.stringValue, !host.isEmpty { return host }
        return "Frame \(id)"
    }

    public var status: String { raw["status"]?.stringValue ?? "" }
    public var connected: Bool? { raw["connected"]?.boolValue }
    public var activeConnections: Int { raw["active_connections"]?.intValue ?? 0 }
    public var lastLogAt: String? { raw["last_log_at"]?.stringValue }
    public var lastSeenAt: String? { raw["last_seen_at"]?.stringValue }
    public var nextWakeAt: String? { raw["next_wake_at"]?.stringValue }
    public var nextRenderAt: String? { raw["next_render_at"]?.stringValue }
    public var sleepReason: String? { raw["sleep_reason"]?.stringValue }
    public var frameosVersion: String? { raw["frameos_version"]?.stringValue }
    public var managedBy: String? { raw["managed_by"]?.stringValue }
    public var mode: String? { raw["mode"]?.stringValue }
    public var device: String? { raw["device"]?.stringValue }
    public var frameHost: String? { raw["frame_host"]?.stringValue }
    public var width: Int? { raw["width"]?.intValue }
    public var height: Int? { raw["height"]?.intValue }
    public var rotate: Int? { raw["rotate"]?.intValue }
    public var interval: Double? { raw["interval"]?.doubleValue }
    public var scenesChecksum: String? { raw["scenes_checksum"]?.stringValue }
    public var lastSuccessfulDeployAt: String? { raw["last_successful_deploy_at"]?.stringValue }
    public var pendingCommandTypes: [String] {
        raw["pending_command_types"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }
    public var deviceConfig: [String: JSONValue] { raw["device_config"]?.objectValue ?? [:] }
    public var lastMetrics: [String: JSONValue] { raw["last_metrics"]?.objectValue ?? [:] }
    public var deployProgress: JSONValue? { raw["deploy_progress"] }
    public var firmwareUpdate: JSONValue? { raw["firmware_update"] }
    public var scenePreview: JSONValue? { raw["scene_preview"] }

    /// `hardware.platform` as the device reports it (cloud), else the
    /// backend's `mode`. Used only to choose what to draw, never trusted.
    public var hardware: [String: JSONValue] { raw["hardware"]?.objectValue ?? [:] }

    public var isEmbedded: Bool {
        if mode == "embedded" { return true }
        if let platform = hardware["platform"]?.stringValue?.lowercased() {
            return platform.hasPrefix("esp32")
        }
        return false
    }

    public func deviceConfigValue(_ camel: String, _ snake: String) -> JSONValue? {
        deviceConfig[camel] ?? deviceConfig[snake]
    }

    /// Cloud frames carry no last_log_at, only the hub's last_seen_at.
    public var activityTimestamp: String? { lastLogAt ?? lastSeenAt }

    /// The rotation-corrected aspect ratio of the panel, for image placeholders.
    public var aspectRatio: Double {
        guard let width, let height, width > 0, height > 0 else { return 4.0 / 3.0 }
        let rotated = (rotate ?? 0) % 180 != 0
        return rotated ? Double(height) / Double(width) : Double(width) / Double(height)
    }
}
