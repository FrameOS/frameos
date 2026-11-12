import Foundation

/// Where an ESP32's scenes run (docs/server-rendering.md): on the frame's own
/// runtime, or on its control plane, which hands it the finished picture.
/// A port of frontend/src/utils/renderOnServer.ts and of the backend Power
/// section's board rule (embeddedPowerProfileFor, isThinClientEmbeddedPlatform);
/// both replay docs/render-on-server-fixtures.json.
public enum RenderMode: String, Sendable, CaseIterable {
    case local, remote
}

public enum RenderOnServer {
    // What the backend reads as remote (embedded_render_mode_for_frame): `remote` and three old aliases.
    static let remoteSpellings: Set<String> = ["remote", "thin_client", "thinclient", "backend"]
    static let localSpellings: Set<String> = ["local", "on_device", "ondevice"]
    // Boards without a runtime of their own: the plane renders every picture for them.
    static let thinPlatformPrefixes = ["esp32-c3", "pico", "virtual"]
    // The backend's thin-client platforms (devices.ts isThinClientEmbeddedPlatform), matched exactly.
    static let backendThinPlatforms: Set<String> = ["esp32-c3", "pico-w", "pico-2w"]

    /// A stored render mode in any of its spellings, or nil when unset or unknown.
    public static func normalize(_ value: JSONValue?) -> RenderMode? {
        guard case .string(let text)? = value else { return nil }
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .replacingOccurrences(of: "-", with: "_")
        if remoteSpellings.contains(normalized) { return .remote }
        if localSpellings.contains(normalized) { return .local }
        return nil
    }

    /// Whether the board the frame reported can run its own scenes: an
    /// ESP32-S3 can, a C3, a Pico and a virtual frame cannot. A frame that
    /// never reported its hardware is given the benefit of the doubt.
    public static func canRenderItself(hardware: [String: JSONValue]?) -> Bool {
        guard let hardware else { return true }
        if case .bool(false)? = hardware["localRenderSupported"] { return false }
        let platform: String
        if case .string(let text)? = hardware["platform"] { platform = text.lowercased() } else { platform = "" }
        return !thinPlatformPrefixes.contains { platform.hasPrefix($0) }
    }

    /// The render mode a backend frame is set to: its device_config, then
    /// its embedded block, `local` by default.
    public static func backendMode(deviceConfig: JSONValue?, embedded: JSONValue?) -> RenderMode {
        for source in [deviceConfig, embedded] {
            guard let record = source?.objectValue else { continue }
            let value = record["renderMode"].nonNull ?? record["render_mode"]
            if let mode = normalize(value) { return mode }
        }
        return .local
    }

    /// The render mode a cloud frame is set to: the owner's setting, else what the device reports.
    public static func cloudMode(renderMode: JSONValue?, hardware: [String: JSONValue]?) -> RenderMode {
        normalize(renderMode) ?? normalize(hardware?["renderMode"]) ?? .local
    }

    /// The backend Power section's profile for a board (nil: no section, a virtual frame).
    public static func backendPowerProfile(platform: String?) -> String? {
        if platform == "virtual" { return nil }
        return (platform ?? "").lowercased().hasPrefix("pico") ? "pico" : "esp32"
    }

    /// Whether a backend frame's Power section offers "Render scenes": an
    /// ESP32 that is not a thin client already.
    public static func backendOffers(platform: String?) -> Bool {
        backendPowerProfile(platform: platform) == "esp32" && !backendThinPlatforms.contains(platform ?? "")
    }
}
