import Foundation

/// The frames list's words for a frame: "online", "asleep · wakes in 5 min",
/// "updating firmware 42%", "last seen 3 minutes ago". A port of the SPA's
/// decorators (frontend/src/decorators/frame.tsx), pinned to it by
/// docs/frame-status-fixtures.json, which both replay
/// (cloud/apps/auth-web/src/test/shared-spa/frame-status-fixtures.test.ts and
/// FrameStatusFixtureTests). Change one, change the other and the corpus.
public enum FrameStatus {
    /// A wake is a cold boot, so the socket lands a good minute after the timer.
    static let checkinGraceMs: Double = 2 * 60 * 1000
    /// The firmware's own "a cell is present" threshold (FOS_BATTERY_PRESENT_MV).
    static let batteryPresentMillivolts: Double = 2500
    public static let statusesWithSpinner: Set<String> = ["deploying", "preparing", "rendering", "restarting", "starting"]

    public struct Checkin: Equatable, Sendable {
        public enum Kind: String, Sendable { case sleeping, overdue }
        public var kind: Kind
        public var wakeAt: Double
        public var renderAt: Double?
        public var announced: Bool
        public var reason: String?
    }

    static func estimatedCheckinPeriodSeconds(_ frame: Frame) -> Double? {
        let deepSleep = frame["deep_sleep"].nonNull ?? frame.deviceConfigValue("deepSleep", "deep_sleep").nonNull
        let deepSleepOnBattery = frame["deep_sleep_on_battery"].nonNull
            ?? frame.deviceConfigValue("deepSleepOnBattery", "deep_sleep_on_battery").nonNull
        let metrics = frame.lastMetrics
        let onBattery: Bool
        if case .bool(let value)? = metrics["onBattery"] {
            onBattery = value
        } else if let millivolts = metrics["batteryMillivolts"]?.numberValueIfNumber {
            onBattery = millivolts >= batteryPresentMillivolts
        } else {
            onBattery = false
        }
        let sleeps = deepSleep == .bool(true) || (deepSleepOnBattery == .bool(true) && onBattery)
        if !sleeps { return nil }
        let wakeCheck = (frame["wake_check_seconds"].nonNull ?? frame.deviceConfigValue("wakeCheckSeconds", "wake_check_seconds").nonNull)?.doubleValue ?? 0
        let interval = (frame.interval ?? 0) > 0 ? frame.interval! : 300
        let period = wakeCheck >= 60 && wakeCheck < interval ? wakeCheck : interval
        return min(max(period, 60), 7 * 86400)
    }

    public static func checkin(_ frame: Frame, now: Double = FrameTime.nowMs()) -> Checkin? {
        if frame.connected == true || frame.activeConnections > 0 { return nil }
        if let announcedWakeAt = FrameTime.parse(frame.nextWakeAt) {
            let renderAt = FrameTime.parse(frame.nextRenderAt)
            return Checkin(
                kind: now > announcedWakeAt + checkinGraceMs ? .overdue : .sleeping,
                wakeAt: announcedWakeAt,
                renderAt: renderAt.flatMap { $0 > announcedWakeAt + 60_000 ? $0 : nil },
                announced: true,
                reason: frame.sleepReason
            )
        }
        guard let period = estimatedCheckinPeriodSeconds(frame),
              let lastSeenAt = FrameTime.parse(frame.activityTimestamp)
        else { return nil }
        let wakeAt = lastSeenAt + period * 1000
        let graceMs = checkinGraceMs + (period * 1000) / 2
        return Checkin(kind: now > wakeAt + graceMs ? .overdue : .sleeping, wakeAt: wakeAt, renderAt: nil,
                       announced: false, reason: nil)
    }

    public static func checkinDescription(_ frame: Frame, now: Double = FrameTime.nowMs()) -> String? {
        guard let checkin = checkin(frame, now: now) else { return nil }
        let approx = checkin.announced ? "" : "~"
        if checkin.kind == .sleeping {
            var parts = ["asleep · wakes \(FrameTime.relativeFuture(checkin.wakeAt, now: now, approx: approx))"]
            if let renderAt = checkin.renderAt {
                parts.append("renders \(FrameTime.relativeFuture(renderAt, now: now))")
            }
            return parts.joined(separator: " · ")
        }
        let lastSeen = FrameTime.relative(frame.activityTimestamp, now: now)
        return "overdue · expected \(approx)\(FrameTime.relative(checkin.wakeAt, now: now) ?? "")"
            + (lastSeen.map { " · last seen \($0)" } ?? "")
    }

    public static func isStale(_ frame: Frame, now: Double = FrameTime.nowMs()) -> Bool {
        if checkin(frame, now: now)?.kind == .sleeping { return false }
        guard let activity = frame.activityTimestamp, !activity.isEmpty,
              let lastActivityAt = FrameTime.parse(activity) else { return false }
        return now - lastActivityAt > 1000 * 60 * 60
    }

    public static func hasActivityLog(_ frame: Frame) -> Bool {
        FrameTime.parse(frame.activityTimestamp) != nil
    }

    /// "online" / "offline" / "stale" on the cloud, the backend's status word
    /// ("ready", "deploying", "connected") on a backend.
    public static func label(_ frame: Frame, now: Double = FrameTime.nowMs()) -> String {
        if frame.status == "active", let connected = frame.connected {
            return connected ? "online" : isStale(frame, now: now) ? "stale" : "offline"
        }
        var status = frame.status
        if isStale(frame, now: now) { status = "stale" }
        if frame.status == "ready" && frame.activeConnections > 0 { status = "connected" }
        return status
    }

    public static func needsInitialDeploy(_ frame: Frame, plane: PlaneKind) -> Bool {
        if plane == .cloud || frame.managedBy == "cloud" {
            return (frame.scenesChecksum ?? "").isEmpty && !hasActivityLog(frame)
        }
        if (frame.mode ?? "rpios") == "embedded" && hasActivityLog(frame) { return false }
        return (frame.lastSuccessfulDeployAt ?? "").isEmpty
    }

    /// The one line under a frame's name (the SPA's frameActivityDescription).
    public static func activity(_ frame: Frame, plane: PlaneKind, now: Double = FrameTime.nowMs()) -> String {
        if let deploy = DeployProgress.view(frame, now: now), deploy.status == .running {
            return deploy.caption
        }
        if needsInitialDeploy(frame, plane: plane) { return "waiting for first deploy" }
        if let checkin = checkinDescription(frame, now: now) { return checkin }
        if let relative = FrameTime.relative(frame.activityTimestamp, now: now) { return "last seen \(relative)" }
        return "no logs yet"
    }

    /// The healthy / busy / trouble colour of the status dot.
    public enum Tone: String, Sendable { case good, busy, warn, bad, idle }

    public static func tone(_ frame: Frame, now: Double = FrameTime.nowMs()) -> Tone {
        if DeployProgress.isRunning(frame, now: now) || firmwareUpdate(frame, now: now)?.kind == .running { return .busy }
        if firmwareUpdate(frame, now: now)?.kind == .failed { return .bad }
        let word = label(frame, now: now)
        switch word {
        case "online", "connected", "ready": return .good
        case "stale", "offline": return checkin(frame, now: now)?.kind == .sleeping ? .idle : .warn
        default:
            if statusesWithSpinner.contains(word) { return .busy }
            if word.contains("fail") || word.contains("error") || word == "revoked" { return .bad }
            return .idle
        }
    }

    // MARK: firmware updates

    public struct FirmwareUpdateProgress: Equatable, Sendable {
        public enum Kind: String, Sendable { case running, failed }
        public var kind: Kind
        public var label: String
        public var title: String
        public var percent: Int?
        public var version: String?
    }

    static let firmwareUpdateStaleMs: Double = 15 * 60 * 1000
    static let firmwareUpdateNoProgressStaleMs: Double = 45 * 60 * 1000
    static let firmwareUpdateFailureShownMs: Double = 6 * 60 * 60 * 1000

    /// The SPA's frameFirmwareUpdateProgress.
    public static func firmwareUpdate(_ frame: Frame, now: Double = FrameTime.nowMs()) -> FirmwareUpdateProgress? {
        guard let update = frame.firmwareUpdate?.objectValue, let status = update["status"]?.stringValueIfString else { return nil }
        let at = FrameTime.parse(update["at"])
        let age = at.map { now - $0 } ?? .infinity
        let version = update["version"]?.stringValueIfString.flatMap { $0.isEmpty ? nil : $0 }
        let versionSuffix = version.map { " \($0)" } ?? ""
        let detail = update["detail"]?.stringValueIfString ?? ""
        switch status {
        case "waiting", "downloading", "progress":
            var percent: Int?
            var isByteCount = false
            let pieces = detail.split(separator: "/", omittingEmptySubsequences: false)
            if pieces.count == 2, !pieces[0].isEmpty, !pieces[1].isEmpty,
               pieces[0].allSatisfy(\.isASCIIDigitCharacter), pieces[1].allSatisfy(\.isASCIIDigitCharacter),
               let written = Double(pieces[0]), let total = Double(pieces[1])
            {
                isByteCount = true
                if total > 0 && written >= 0 { percent = min(100, FrameTime.jsRound((written / total) * 100)) }
            }
            if age > (percent == nil ? firmwareUpdateNoProgressStaleMs : firmwareUpdateStaleMs) {
                if age > firmwareUpdateFailureShownMs { return nil }
                return FirmwareUpdateProgress(
                    kind: .failed, label: "update stalled",
                    title: "The firmware update\(versionSuffix) stopped reporting\(percent.map { " at \($0)%" } ?? ""); the frame may have lost its connection or restarted. See the ota or cloud:upgrade lines in Logs.",
                    percent: percent, version: version
                )
            }
            let phrase = !detail.isEmpty && !isByteCount && detail != version ? ": \(detail)" : ""
            let title = status == "waiting"
                ? "Waiting for the frame's render to finish before downloading FrameOS\(versionSuffix)"
                : "Downloading FrameOS\(versionSuffix)\(percent.map { " (\($0)%)" } ?? "")\(phrase)"
            return FirmwareUpdateProgress(
                kind: .running, label: percent.map { "updating firmware \($0)%" } ?? "updating firmware",
                title: title, percent: percent, version: version
            )
        case "verified":
            if age > firmwareUpdateStaleMs { return nil }
            if let version, frame.frameosVersion == version { return nil }
            return FirmwareUpdateProgress(
                kind: .running, label: "rebooting into\(versionSuffix.isEmpty ? " the update" : versionSuffix)",
                title: "Firmware verified; the frame restarts into FrameOS\(versionSuffix)", percent: 100, version: version
            )
        case "error":
            if age > firmwareUpdateFailureShownMs { return nil }
            return FirmwareUpdateProgress(
                kind: .failed, label: "update failed",
                title: "The firmware update failed: \(detail.isEmpty ? "unknown error" : detail). See the ota or cloud:upgrade lines in Logs.",
                percent: nil, version: version
            )
        default:
            return nil
        }
    }

    /// The cloud's notify_update_available is queued and unapplied.
    public static func upgradeIsQueued(_ frame: Frame) -> Bool {
        frame.pendingCommandTypes.contains("notify_update_available")
    }

    /// The status word the frames list shows: firmware first, then the label.
    public static func headline(_ frame: Frame, now: Double = FrameTime.nowMs()) -> String {
        if let update = firmwareUpdate(frame, now: now) { return update.label }
        if upgradeIsQueued(frame) { return "update queued" }
        return label(frame, now: now)
    }
}

extension Optional where Wrapped == JSONValue {
    /// The value unless it is absent or JSON null (JavaScript's `??`).
    var nonNull: JSONValue? {
        if case .some(let value) = self, !value.isNull { return value }
        return nil
    }
}

extension Character {
    var isASCIIDigitCharacter: Bool { ("0"..."9").contains(self) }
}
