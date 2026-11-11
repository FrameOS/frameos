import Foundation

/// Everything the app asks a control plane, as one value per signed-in
/// account. Each method calls the route the SPA calls for the same action,
/// and where the planes differ the branch is here, commented with the SPA
/// file that makes the same choice. docs/ios-app.md lists every action and
/// its route on both planes.
public struct FrameOSService: Sendable {
    public let client: APIClient

    public init(client: APIClient) { self.client = client }

    public var kind: PlaneKind { client.kind }
    public var account: Account { client.account }

    static func framePath(_ frameId: String, _ rest: String = "") -> String {
        "/api/frames/\(ApiPaths.segment(frameId))\(rest)"
    }
}

// MARK: - Frames

/// What a queued or pushed action answered (both planes' shapes).
public struct ActionOutcome: Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case done, queued, failed(String) }
    public var kind: Kind
    public var message: String

    public init(kind: Kind, message: String) {
        self.kind = kind
        self.message = message
    }

    /// The cloud's `{command_id, status: "queued"}`, a backend's `"OK"` /
    /// `"Success"`, or an ESP32 command outcome `{status, applied, error}`.
    static func from(_ answer: JSONValue, queuedMessage: String = "Sent. The frame applies it when it next checks in.") -> ActionOutcome {
        if let status = answer["status"]?.stringValue {
            switch status {
            case "queued": return ActionOutcome(kind: .queued, message: queuedMessage)
            case "failed":
                let error = answer["error"]?.stringValue ?? "The frame refused it."
                return ActionOutcome(kind: .failed(error), message: error)
            default: return ActionOutcome(kind: .done, message: answer["message"]?.stringValue ?? "Done.")
            }
        }
        if answer["command_id"] != nil { return ActionOutcome(kind: .queued, message: queuedMessage) }
        return ActionOutcome(kind: .done, message: answer["message"]?.stringValue ?? "Done.")
    }
}

extension FrameOSService {
    public func frames() async throws -> [Frame] {
        let answer = try await client.get("/api/frames")
        let list = (answer["frames"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(Frame.init)
        // A backend lists archived frames too; the workspace hides them.
        return list.filter { $0["archived"]?.boolValue != true }
    }

    public func frame(_ id: String) async throws -> Frame {
        let answer = try await client.get(Self.framePath(id))
        guard let object = answer["frame"]?.objectValue else {
            throw APIError(status: 0, message: "The frame did not come back.")
        }
        return Frame(raw: object)
    }

    /// Rename: `POST /api/frames/{id} {name}` on both (the cloud takes only `name` there).
    public func rename(_ frame: Frame, to name: String) async throws {
        try await client.call("POST", Self.framePath(frame.id), body: .json(["name": .string(name)]))
    }

    /// Delete the frame from the control plane (the device keeps running).
    /// The cloud wants a recent sign-in (`reauth_required`).
    public func delete(_ frame: Frame) async throws {
        try await client.call("DELETE", Self.framePath(frame.id))
    }

    /// `POST …/event/{name}` with a JSON payload, the canonical event route.
    @discardableResult
    public func sendEvent(_ frame: Frame, _ event: String, payload: [String: JSONValue] = [:]) async throws -> ActionOutcome {
        let answer = try await client.call("POST", Self.framePath(frame.id, "/event/\(ApiPaths.segment(event))"),
                                           body: .json(.object(payload)))
        return ActionOutcome.from(answer)
    }

    public func render(_ frame: Frame) async throws -> ActionOutcome {
        try await sendEvent(frame, "render")
    }

    /// Restart FrameOS (the runtime): `POST …/restart` on both planes.
    public func restart(_ frame: Frame) async throws -> ActionOutcome {
        ActionOutcome.from(try await client.call("POST", Self.framePath(frame.id, "/restart")))
    }

    public func reboot(_ frame: Frame) async throws -> ActionOutcome {
        ActionOutcome.from(try await client.call("POST", Self.framePath(frame.id, "/reboot")))
    }

    /// Screen on / off (`turnOn` / `turnOff`; Linux frames).
    public func setDisplay(_ frame: Frame, on: Bool) async throws -> ActionOutcome {
        try await sendEvent(frame, on ? "turnOn" : "turnOff")
    }

    /// The newest signed FrameOS release (`GET /api/frames/firmware`, both planes).
    public func latestRelease() async throws -> String? {
        let answer = try await client.get("/api/frames/firmware")
        return answer["release"]?.stringValue
    }

    /// "Update FrameOS" / "Update firmware": the cloud's
    /// `notify_update_available` verb (framesModel.updateFrameFirmware);
    /// a backend's ESP32 OTA or a Linux frame's signed self-upgrade.
    public func updateFirmware(_ frame: Frame) async throws -> ActionOutcome {
        switch kind {
        case .cloud:
            let answer = try await client.call("POST", Self.framePath(frame.id, "/command"),
                                               body: .json(["type": "notify_update_available"]))
            return ActionOutcome.from(answer, queuedMessage: "Update queued. The frame downloads it when it next checks in.")
        case .backend:
            if frame.isEmbedded {
                let answer = try await client.call("POST", Self.framePath(frame.id, "/embedded/firmware/ota"))
                return ActionOutcome(kind: .done, message: answer["message"]?.stringValue ?? "Update sent to the frame.")
            }
            let answer = try await client.call("POST", Self.framePath(frame.id, "/device/upgrade"),
                                               body: .json(["dry_run": false]), timeout: 120)
            return ActionOutcome(kind: .done, message: answer["message"]?.stringValue ?? "Update started on the frame.")
        }
    }

    /// Backend only: send the saved settings and scenes to the frame
    /// ("Deploy scenes & settings"). Fast unless the frame was never deployed.
    public func deploy(_ frame: Frame, full: Bool = false) async throws -> ActionOutcome {
        guard kind == .backend else { return ActionOutcome(kind: .done, message: "Saved.") }
        let fast = !full && !(frame.lastSuccessfulDeployAt ?? "").isEmpty
        let route = fast ? "/fast_deploy" : "/deploy"
        let taskId = "\(fast ? "fast-deploy" : "deploy"):\(frame.id):\(UUID().uuidString.lowercased())"
        do {
            try await client.call("POST", Self.framePath(frame.id, route), query: ["task_id": taskId])
        } catch let error as APIError where error.status == 409 {
            // A deploy is already queued: the newer one replaces it.
            try await client.call("POST", Self.framePath(frame.id, route), query: ["task_id": taskId, "force": "true"])
        }
        return ActionOutcome(kind: .done, message: fast ? "Deploying scenes & settings." : "Deploying FrameOS, scenes & settings.")
    }

    // MARK: pending commands ("Waiting for the frame")

    public func commands(_ frame: Frame) async throws -> [PendingCommand] {
        let answer = try await client.get(Self.framePath(frame.id, "/commands"))
        return (answer["commands"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(PendingCommand.init)
    }

    public func cancelCommand(_ frame: Frame, _ command: PendingCommand) async throws {
        try await client.call("DELETE", Self.framePath(frame.id, "/commands/\(ApiPaths.segment(command.id))"))
    }

    // MARK: logs and metrics

    public func logs(_ frame: Frame, afterId: Int? = nil, limit: Int? = nil) async throws -> [LogLine] {
        var query: [String: String?] = [:]
        if let afterId { query["after_id"] = String(afterId) }
        if let limit, kind == .cloud { query["limit"] = String(limit) }
        let answer = try await client.get(Self.framePath(frame.id, "/logs"), query: query)
        return (answer["logs"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(LogLine.init)
    }

    public func metrics(_ frame: Frame) async throws -> [MetricSample] {
        let answer = try await client.get(Self.framePath(frame.id, "/metrics"))
        return (answer["metrics"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(MetricSample.init)
    }

    /// Ask the frame for a fresh metrics sample (`metrics` event).
    public func requestMetrics(_ frame: Frame) async throws {
        _ = try await sendEvent(frame, "metrics")
    }

    // MARK: images

    /// The frame's current picture. `fresh`: ask the frame (the cloud waits
    /// up to 25 s for it); otherwise the cached copy, at once.
    public func frameImage(_ frame: Frame, fresh: Bool = false) async throws -> Data {
        let t = fresh ? String(Int(Date().timeIntervalSince1970 * 1000)) : "-1"
        let (data, _) = try await client.bytes(Self.framePath(frame.id, "/image"), query: ["t": t], timeout: fresh ? 45 : 30)
        return data
    }

    public func sceneImage(_ frame: Frame, sceneId: String, thumb: Bool = true) async throws -> Data {
        // The scene id is a path on both planes (`system/index`).
        let (data, _) = try await client.bytes(Self.framePath(frame.id, "/scene_images/\(ApiPaths.encodePath(sceneId))"),
                                               query: ["thumb": thumb ? "1" : nil], timeout: 30)
        return data
    }
}

/// A row of "Waiting for the frame" (`GET …/commands`, same shape on both planes).
public struct PendingCommand: Identifiable, Hashable, Sendable {
    public var raw: [String: JSONValue]
    public init(raw: [String: JSONValue]) { self.raw = raw }
    public var id: String { raw["id"]?.stringValue ?? "" }
    public var type: String { raw["type"]?.stringValue ?? "" }
    public var status: String { raw["status"]?.stringValue ?? "" }
    public var createdAt: String? { raw["created_at"]?.stringValue }
    public var expiresAt: String? { raw["expires_at"]?.stringValue }

    /// The SPA's words for a queued verb (`commandLabels` in
    /// frontend/src/scenes/workspace/framePendingCommandsLogic.ts; the
    /// PendingCommandLabelTests read that file and compare).
    public static let labels: [String: String] = [
        "asset_get": "Fetch a file for a preview",
        "get_metrics": "Collect metrics",
        "image_get": "Fetch the current image",
        "lan_access_challenge": "Show local network access code",
        "lan_access_set": "Change local network access",
        "notify_update_available": "Check for a firmware update",
        "reboot": "Reboot",
        "refresh_service_settings": "Re-read service API keys",
        "render": "Render now",
        "restart_runtime": "Restart FrameOS",
        "scenes_get": "Read the frame's own scenes",
        "set_current_scene": "Switch scene",
        "set_schedule": "Update the schedule",
        "set_scenes": "Push scenes",
        "set_settings": "Deploy settings",
    ]

    public var label: String {
        Self.labels[type] ?? type.replacingOccurrences(of: "_", with: " ")
    }
}

/// One log row (`GET …/logs`, `new_log` on both sockets).
public struct LogLine: Identifiable, Hashable, Sendable {
    public var raw: [String: JSONValue]
    public init(raw: [String: JSONValue]) { self.raw = raw }
    public var id: Int { raw["id"]?.intValue ?? 0 }
    public var frameId: String { raw["frame_id"]?.stringValue ?? "" }
    public var timestamp: String { raw["timestamp"]?.stringValue ?? "" }
    public var type: String { raw["type"]?.stringValue ?? "" }
    public var line: String { raw["line"]?.stringValue ?? "" }

    /// The device's structured line (`{"event": "render:done", ...}`), when it is one.
    public var payload: JSONValue? {
        guard line.hasPrefix("{") else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8))
    }

    public var event: String? { payload?["event"]?.stringValue }

    public var isError: Bool {
        if type == "stderr" { return true }
        if let event = event, event.contains("error") || event.hasSuffix(":failed") { return true }
        return payload?["error"] != nil
    }
}

/// One metrics sample.
public struct MetricSample: Identifiable, Hashable, Sendable {
    public var raw: [String: JSONValue]
    public init(raw: [String: JSONValue]) { self.raw = raw }
    public var id: String { raw["id"]?.stringValue ?? timestamp }
    public var timestamp: String { raw["timestamp"]?.stringValue ?? "" }
    public var metrics: [String: JSONValue] { raw["metrics"]?.objectValue ?? [:] }
}
