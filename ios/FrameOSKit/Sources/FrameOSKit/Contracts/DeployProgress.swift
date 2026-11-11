import Foundation

/// docs/deploy-progress-contract.json, as the generator hands it to the app
/// (Generated/DeployProgressContract.gen.swift). The same tables the SPA
/// reads from deployProgress.gen.ts.
public struct DeployProgressContract: Decodable, Sendable {
    public struct Record: Decodable, Sendable {
        public var doneShownSeconds: Double
        public var errorShownSeconds: Double
        public var wakeGraceSeconds: Double
    }

    public struct Stage: Decodable, Sendable {
        public var label: String
        public var staleAfterSeconds: Double
        public var freshWhileSleeping: Bool?
    }

    public struct KindStage: Decodable, Sendable {
        public var stage: String
    }

    public struct Kind: Decodable, Sendable {
        public var label: String
        public var planes: [String]
        public var stages: [KindStage]
    }

    public var version: Int
    public var record: Record
    public var stages: [String: Stage]
    public var kinds: [String: Kind]

    public static let shared: DeployProgressContract = {
        do {
            return try JSONDecoder().decode(DeployProgressContract.self, from: Data(DeployProgressContractSource.json.utf8))
        } catch {
            fatalError("Generated/DeployProgressContract.gen.swift does not decode: \(error)")
        }
    }()
}

/// The deploy / update / restart in flight, as the control plane recorded it
/// in `deploy_progress`. A line-for-line port of the SPA's
/// `frameDeployProgress` (frontend/src/decorators/frame.tsx); the stale and
/// percent sections of docs/deploy-progress-fixtures.json and the cases of
/// docs/frame-status-fixtures.json replay on both.
public struct DeployProgressView: Equatable, Sendable {
    public enum Status: String, Sendable { case running, done, error }

    public var kind: String
    public var kindLabel: String
    public var stage: String
    public var status: Status
    public var label: String
    public var detail: String?
    public var error: String?
    public var caption: String
    public var title: String
    public var percent: Int
    public var startedAt: Double
    public var at: Double
}

public struct DeployProgressStep: Equatable, Sendable {
    public enum State: String, Sendable { case done, current, pending, error }
    public var stage: String
    public var label: String
    public var state: State
    public var detail: String?
}

public enum DeployProgress {
    static let doneWords: [String: String] = [
        "restart": "restarted",
        "reboot": "rebooted",
        "upgrade": "updated",
        "firmware": "firmware updated",
        "virtual": "rendered",
    ]

    static let errorWords: [String: String] = [
        "backend_managed": "a self-hosted backend controls this frame",
    ]

    public static func view(_ frame: Frame, now: Double = FrameTime.nowMs(),
                            contract: DeployProgressContract = .shared) -> DeployProgressView?
    {
        guard let record = frame.deployProgress?.objectValue,
              let kind = record["kind"]?.stringValueIfString,
              let stage = record["stage"]?.stringValueIfString,
              let kindSpec = contract.kinds[kind]
        else { return nil }
        guard let at = FrameTime.parse(record["at"]) else { return nil }
        let startedAt = FrameTime.parse(record["started_at"])
        let ageMs = now - at
        let rawStatus = record["status"]?.stringValueIfString
        let status: DeployProgressView.Status = rawStatus == "done" ? .done : rawStatus == "error" ? .error : .running
        let stageNames = kindSpec.stages.map(\.stage)
        let stageIndex = stageNames.firstIndex(of: stage)
        let stageSpec = contract.stages[stage]
        switch status {
        case .running:
            guard let stageSpec, stageIndex != nil else { return nil }
            let wakeAt = FrameTime.parse(frame.nextWakeAt)
            let freshWhileSleeping = stageSpec.freshWhileSleeping == true && wakeAt != nil
                && now < wakeAt! + contract.record.wakeGraceSeconds * 1000
            if !freshWhileSleeping && ageMs > stageSpec.staleAfterSeconds * 1000 { return nil }
        case .done:
            if ageMs > contract.record.doneShownSeconds * 1000 { return nil }
        case .error:
            if ageMs > contract.record.errorShownSeconds * 1000 { return nil }
        }
        let detail = record["detail"]?.stringValueIfString.flatMap { $0.isEmpty ? nil : $0 }
        let error = record["error"]?.stringValueIfString.flatMap { $0.isEmpty ? nil : (errorWords[$0] ?? $0) }
        let progress = record["progress"]?.objectValue
        let current = progress?["current"]?.numberValueIfNumber
        let total = progress?["total"]?.numberValueIfNumber
        var percent = 0
        if status == .done {
            percent = 100
        } else if let stageIndex, !stageNames.isEmpty {
            var fraction = 0.3
            if let current, let total, total > 0 {
                fraction = max(0, min(1, current / total))
            }
            percent = FrameTime.jsRound(100 * (Double(stageIndex) + fraction) / Double(stageNames.count))
        }
        let label: String
        switch status {
        case .done: label = doneWords[kind] ?? "deployed"
        case .error: label = "failed"
        case .running: label = stageSpec?.label ?? stage
        }
        var bytes: String?
        if status == .running, let current, let total, total > 0 {
            bytes = "\(FrameTime.jsRound(100 * current / total))%"
        }
        let caption: String
        switch status {
        case .error: caption = "\(label): \(error ?? "deploy did not complete")"
        case .done: caption = detail.map { "\(label) · \($0)" } ?? label
        case .running: caption = [label, bytes ?? detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
        let title = [kindSpec.label, status == .running ? label : caption, status == .running ? detail : nil]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return DeployProgressView(
            kind: kind, kindLabel: kindSpec.label, stage: stage, status: status, label: label,
            detail: detail, error: error, caption: caption, title: title, percent: percent,
            startedAt: startedAt ?? at, at: at
        )
    }

    /// The deploy drawer's step list (the SPA's frameDeployProgressSteps).
    public static func steps(_ frame: Frame, now: Double = FrameTime.nowMs(),
                             contract: DeployProgressContract = .shared) -> [DeployProgressStep]
    {
        guard let view = view(frame, now: now, contract: contract), let kindSpec = contract.kinds[view.kind] else { return [] }
        let stages = kindSpec.stages.map(\.stage)
        let current = view.status == .done ? stages.count : (stages.firstIndex(of: view.stage) ?? -1)
        return stages.enumerated().map { index, stage in
            let spec = contract.stages[stage]
            let word = spec?.label ?? stage
            let label = word.prefix(1).uppercased() + word.dropFirst()
            if index < current { return DeployProgressStep(stage: stage, label: label, state: .done, detail: nil) }
            if index == current {
                if view.status == .error {
                    return DeployProgressStep(stage: stage, label: label, state: .error, detail: view.error)
                }
                return DeployProgressStep(stage: stage, label: label, state: .current,
                                          detail: view.caption == view.label ? nil : view.caption)
            }
            return DeployProgressStep(stage: stage, label: label, state: .pending, detail: nil)
        }
    }

    public static func isRunning(_ frame: Frame, now: Double = FrameTime.nowMs()) -> Bool {
        view(frame, now: now)?.status == .running
    }
}

extension JSONValue {
    /// The string only when the JSON value IS a string (the SPA's `typeof x === 'string'`).
    var stringValueIfString: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// The number only when the JSON value IS a number (`typeof x === 'number'`).
    var numberValueIfNumber: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}
