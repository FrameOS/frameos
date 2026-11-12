import Foundation

/// The settings a cloud-managed frame takes over `set_settings`
/// (docs/cloud-frames-contract.json `settings`, generated into
/// Generated/CloudFramesContract.gen.swift). The cloud refuses a whole push
/// with one key the frame's profile or firmware does not know, so the app
/// offers only what `keys(for:)` allows, the way the SPA's
/// cloudFrameSettings.ts does.
public struct CloudSettingsContract: Decodable, Sendable {
    public struct Entry: Decodable, Sendable {
        public var since: String?
        public var restart: Bool?
        public var companion: String?
        /// A profile's own rule, where it differs (the ESP32's 8-rule button map).
        public var rule: JSONValue?
    }

    public var profiles: [String: [String: Entry]]
    public var rules: [String: JSONValue]

    public static let shared: CloudSettingsContract = {
        do {
            return try JSONDecoder().decode(CloudSettingsContract.self, from: Data(CloudFramesContractSource.json.utf8))
        } catch {
            fatalError("Generated/CloudFramesContract.gen.swift does not decode: \(error)")
        }
    }()

    /// `esp32` for an ESP32 (`hardware.platform` starts with esp32), else `linux`
    /// (the SPA's frameHardwareIsEsp32).
    public static func profile(for frame: Frame) -> String {
        frame.isEmbedded ? "esp32" : "linux"
    }

    /// The keys this frame's firmware takes (the SPA's keysForVersion):
    /// every ungated key, plus each gated batch the reported version reaches.
    /// Companion keys ride only next to their key, so they are left out.
    public func keys(for frame: Frame) -> Set<String> {
        keys(profile: Self.profile(for: frame), frameosVersion: frame.frameosVersion)
    }

    public func keys(profile: String, frameosVersion: String?) -> Set<String> {
        guard let entries = profiles[profile] else { return [] }
        var result = Set<String>()
        for (key, entry) in entries where entry.companion == nil {
            if let since = entry.since {
                if Self.supports(from: since, frameosVersion: frameosVersion) { result.insert(key) }
            } else {
                result.insert(key)
            }
        }
        return result
    }

    /// The firmware version a profile's key needs (`since`), or nil when ungated.
    public func since(_ key: String, profile: String) -> String? {
        profiles[profile]?[key]?.since
    }

    public func restarts(_ key: String, frame: Frame) -> Bool {
        profiles[Self.profile(for: frame)]?[key]?.restart == true
    }

    /// The SPA's cloudFrameSupportsSettingsFrom: no version → no gated keys;
    /// a version that does not parse → assume a development build.
    public static func supports(from minVersion: String, frameosVersion: String?) -> Bool {
        guard let version = frameosVersion?.trimmingCharacters(in: .whitespaces), !version.isEmpty else { return false }
        guard let reported = parse(version) else { return true }
        let floor = parse(minVersion) ?? [0, 0, 0]
        return reported.lexicographicallyPrecedes(floor) == false
    }

    static func parse(_ version: String) -> [Int]? {
        var text = version.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("v") { text.removeFirst() }
        let pieces = text.split(separator: ".", maxSplits: 2, omittingEmptySubsequences: false)
        guard pieces.count == 3 else { return nil }
        let third = pieces[2].prefix { $0.isASCIIDigitCharacter }
        guard let major = Int(pieces[0]), let minor = Int(pieces[1]), let patch = Int(third) else { return nil }
        return [major, minor, patch]
    }

    /// The enum a key takes (`rotate`: 0/90/180/270, `scaling_mode`: ...).
    public func options(_ key: String) -> [JSONValue] {
        rules[key]?["enum"]?.arrayValue ?? []
    }

    /// The most items a list setting takes on this profile.
    public func maxItems(_ key: String, profile: String) -> Int? {
        (profiles[profile]?[key]?.rule ?? rules[key])?["maxItems"]?.intValue
    }

    public func range(_ key: String) -> ClosedRange<Double>? {
        guard let min = rules[key]?["min"]?.doubleValue, let max = rules[key]?["max"]?.doubleValue else { return nil }
        return min...max
    }
}
