import Foundation

/// The frames list's order: Active, Inactive, Archived, each by name (the
/// SPA's groupFramesByStatus, frontend/src/scenes/workspace/frameStatusGroups.ts).
/// Pinned with it by the `groups` section of docs/frame-status-fixtures.json.
public enum FrameGroups {
    public struct Group: Identifiable, Sendable {
        public let key: String
        public let label: String
        public let frames: [Frame]
        public var id: String { key }
    }

    public static func byStatus(_ frames: [Frame], now: Double = FrameTime.nowMs()) -> [Group] {
        var active: [Frame] = []
        var inactive: [Frame] = []
        var archived: [Frame] = []
        for frame in frames {
            if frame["archived"]?.boolValue == true {
                archived.append(frame)
            } else if FrameStatus.isActive(frame, now: now) {
                active.append(frame)
            } else {
                inactive.append(frame)
            }
        }
        return [
            Group(key: "active", label: "Active", frames: sorted(active)),
            Group(key: "inactive", label: "Inactive", frames: sorted(inactive)),
            Group(key: "archived", label: "Archived", frames: sorted(archived)),
        ].filter { !$0.frames.isEmpty }
    }

    /// Every frame in list order, for a picker.
    public static func ordered(_ frames: [Frame], now: Double = FrameTime.nowMs()) -> [Frame] {
        byStatus(frames, now: now).flatMap(\.frames)
    }

    /// `name ?? frameHost(frame)`: an empty name stays empty, as in the SPA.
    static func sortName(_ frame: Frame) -> String {
        if let name = frame["name"]?.stringValueIfString { return name.trimmingCharacters(in: .whitespaces) }
        let host = frame.frameHost ?? ""
        let user = frame["ssh_user"]?.stringValue ?? ""
        return (user.isEmpty || user == "pi" ? host : "\(user)@\(host)").trimmingCharacters(in: .whitespaces)
    }

    /// localeCompare with `numeric` and `sensitivity: "base"`, then the id.
    static func sorted(_ frames: [Frame]) -> [Frame] {
        frames.sorted { first, second in
            let byName = sortName(first).compare(sortName(second),
                                                 options: [.caseInsensitive, .diacriticInsensitive, .numeric],
                                                 locale: Locale(identifier: "en"))
            if byName != .orderedSame { return byName == .orderedAscending }
            return first.id < second.id
        }
    }
}
