import Foundation

/// The frame timestamps both planes send, and the SPA's words for them
/// (frontend/src/decorators/frame.tsx: parseFrameTimestamp,
/// formatFrameRelativeTime, formatFrameDuration, formatFrameRelativeFuture).
/// Times are milliseconds since the epoch, as in the SPA, so the fixture
/// corpus (docs/frame-status-fixtures.json) reads the same on both sides.
public enum FrameTime {
    /// An ISO timestamp with or without a zone (a backend row written by
    /// Python's isoformat() has none: it is UTC), or epoch milliseconds.
    /// nil when it does not parse (the SPA's NaN).
    public static func parse(_ value: JSONValue?) -> Double? {
        guard let value else { return nil }
        switch value {
        case .number(let ms): return ms
        case .string(let text): return parse(text)
        default: return nil
        }
    }

    public static func parse(_ text: String?) -> Double? {
        guard var text = text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        if let space = text.firstIndex(of: " "), text.distance(from: text.startIndex, to: space) == 10 {
            text.replaceSubrange(space...space, with: "T")
        }
        // Split off the zone.
        var zoneSeconds = 0
        if text.hasSuffix("Z") || text.hasSuffix("z") {
            text.removeLast()
        } else if let match = text.range(of: #"[+-]\d{2}:?\d{2}$"#, options: .regularExpression) {
            let zone = text[match].replacingOccurrences(of: ":", with: "")
            let sign = zone.hasPrefix("-") ? -1 : 1
            let digits = zone.dropFirst()
            let hours = Int(digits.prefix(2)) ?? 0
            let minutes = Int(digits.suffix(2)) ?? 0
            zoneSeconds = sign * (hours * 3600 + minutes * 60)
            text.removeSubrange(match)
        }
        // Fractional seconds of any length.
        var fraction = 0.0
        if let dot = text.firstIndex(of: ".") {
            let digits = text[text.index(after: dot)...]
            if !digits.isEmpty, digits.allSatisfy({ $0.isNumber }) {
                fraction = Double("0." + digits) ?? 0
            } else {
                return nil
            }
            text = String(text[..<dot])
        }
        let parts = text.split(separator: "T", omittingEmptySubsequences: false)
        guard let datePart = parts.first else { return nil }
        let ymd = datePart.split(separator: "-").compactMap { Int($0) }
        guard ymd.count == 3 else { return nil }
        var hms = [0, 0, 0]
        if parts.count == 2 {
            let values = parts[1].split(separator: ":").map { Int($0) }
            guard values.count >= 2, values.count <= 3, values.allSatisfy({ $0 != nil }) else { return nil }
            for (index, value) in values.enumerated() { hms[index] = value ?? 0 }
        } else if parts.count > 2 {
            return nil
        }
        var components = DateComponents()
        components.year = ymd[0]
        components.month = ymd[1]
        components.day = ymd[2]
        components.hour = hms[0]
        components.minute = hms[1]
        components.second = hms[2]
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let date = calendar.date(from: components) else { return nil }
        return (date.timeIntervalSince1970 - Double(zoneSeconds) + fraction) * 1000
    }

    public static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    private static func pluralize(_ value: Int, _ unit: String) -> String {
        "\(value) \(unit)\(value == 1 ? "" : "s") ago"
    }

    /// "just now", "5 minutes ago", "1 day ago".
    public static func relative(_ time: Double?, now: Double = nowMs()) -> String? {
        guard let time else { return nil }
        let seconds = max(0, jsRound((now - time) / 1000))
        if seconds < 45 { return "just now" }
        if seconds < 90 { return "1 minute ago" }
        let minutes = jsRound(Double(seconds) / 60)
        if minutes < 60 { return pluralize(minutes, "minute") }
        if minutes < 90 { return "1 hour ago" }
        let hours = jsRound(Double(minutes) / 60)
        if hours < 24 { return pluralize(hours, "hour") }
        if hours < 36 { return "1 day ago" }
        let days = jsRound(Double(hours) / 24)
        return pluralize(days, "day")
    }

    public static func relative(_ timestamp: String?, now: Double = nowMs()) -> String? {
        relative(parse(timestamp), now: now)
    }

    /// "5 min", "2 h 10 min", "3 d 4 h".
    public static func duration(_ ms: Double) -> String {
        let totalMinutes = jsRound(max(0, ms) / 60000)
        if totalMinutes < 1 { return "under a minute" }
        if totalMinutes < 60 { return "\(totalMinutes) min" }
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours < 24 { return minutes > 0 ? "\(hours) h \(minutes) min" : "\(hours) h" }
        let days = hours / 24
        let remainingHours = hours % 24
        return remainingHours > 0 ? "\(days) d \(remainingHours) h" : "\(days) day\(days == 1 ? "" : "s")"
    }

    /// "in 5 min" / "any moment now"; `approx` prefixes the duration.
    public static func relativeFuture(_ time: Double, now: Double = nowMs(), approx: String = "") -> String {
        let ms = time - now
        if ms < 45_000 { return "any moment now" }
        return "in \(approx)\(duration(ms))"
    }

    /// JavaScript's Math.round: halves round up (towards +∞), not away from zero.
    static func jsRound(_ value: Double) -> Int {
        Int((value + 0.5).rounded(.down))
    }

    /// An ISO timestamp for a time in ms (used by the fixture runner and logs).
    public static func iso(_ ms: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}
