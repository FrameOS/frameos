import Foundation

/// The AI chat (docs/ai-chat.md): one agent loop with the same NDJSON events
/// on both planes (`chat`, `delta`, `tool`, `scenes`, `proposal`, `done`,
/// `error`, `ping`). The app has no scene editor, so it sends `editor: false`
/// and the model acts through the plane's tools itself; an install the cloud
/// proposes arrives as a `proposal` the person approves here.
public enum ChatEvent: Sendable, Equatable {
    case started(chatId: String, turnId: String?)
    case delta(String)
    case tool(name: String, label: String, status: String, detail: String?)
    case proposal(JSONValue)
    case done(reply: String?)
    case failed(String)
}

public struct ChatSummary: Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var updatedAt: String?
    public var messageCount: Int
}

public struct ChatMessage: Identifiable, Hashable, Sendable {
    public var id: String
    public var role: String
    public var content: String
    public var tool: String?
    public var proposals: [JSONValue]

    public init(id: String = UUID().uuidString, role: String, content: String, tool: String? = nil, proposals: [JSONValue] = []) {
        self.id = id
        self.role = role
        self.content = content
        self.tool = tool
        self.proposals = proposals
    }
}

extension FrameOSService {
    /// Send a prompt; events stream in as the turn runs. `frame` puts the
    /// frame in the model's context (the frame page's chat box).
    public func chat(prompt: String, chatId: String?, frame: Frame?) -> AsyncThrowingStream<ChatEvent, Error> {
        var body: [String: JSONValue] = [
            "prompt": .string(prompt),
            "editor": false,
            "timeZone": .string(TimeZone.current.identifier),
        ]
        if let chatId { body["chatId"] = .string(chatId) }
        if let frame {
            body["frameId"] = kind == .backend ? .number(Double(Int(frame.id) ?? 0)) : .string(frame.id)
        }
        let lines = client.lines("POST", "/api/ai/chat", body: .json(.object(body)))
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await event in lines {
                        if let parsed = Self.chatEvent(event) { continuation.yield(parsed) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func chatEvent(_ event: JSONValue) -> ChatEvent? {
        switch event["type"]?.stringValue {
        case "chat":
            return .started(chatId: event["chatId"]?.stringValue ?? "", turnId: event["turnId"]?.stringValue)
        case "delta":
            return .delta(event["text"]?.stringValue ?? "")
        case "tool":
            return .tool(name: event["name"]?.stringValue ?? "", label: event["label"]?.stringValue ?? event["name"]?.stringValue ?? "",
                         status: event["status"]?.stringValue ?? "", detail: event["detail"]?.stringValue)
        case "proposal":
            return .proposal(event)
        case "done":
            return .done(reply: event["reply"]?.stringValue)
        case "error":
            return .failed(event["detail"]?.stringValue ?? "The AI could not answer.")
        default:
            return nil // ping, scenes (no editor here), listing
        }
    }

    public func chats(frame: Frame?) async throws -> [ChatSummary] {
        var query: [String: String?] = ["limit": "50"]
        if let frame { query["frameId"] = frame.id } else { query["frameless"] = "1" }
        let answer = try await client.get("/api/ai/chats", query: query)
        return (answer["chats"]?.arrayValue ?? []).compactMap { chat in
            guard let id = chat["id"]?.stringValue else { return nil }
            let title = chat["title"]?.stringValue ?? ""
            return ChatSummary(id: id, title: title.isEmpty ? "Chat" : title, updatedAt: chat["updatedAt"]?.stringValue,
                               messageCount: chat["messageCount"]?.intValue ?? 0)
        }
    }

    public func chatMessages(_ chatId: String) async throws -> [ChatMessage] {
        let answer = try await client.get("/api/ai/chats/\(ApiPaths.segment(chatId))")
        return (answer["messages"]?.arrayValue ?? []).map { message in
            ChatMessage(id: message["id"]?.stringValue ?? UUID().uuidString, role: message["role"]?.stringValue ?? "assistant",
                        content: message["content"]?.stringValue ?? "", tool: message["tool"]?.stringValue,
                        proposals: message["payload"]?["proposals"]?.arrayValue ?? [])
        }
    }

    public func deleteChat(_ chatId: String) async throws {
        try await client.call("DELETE", "/api/ai/chats/\(ApiPaths.segment(chatId))")
    }

    /// Approve the cloud chat's "install this scene" card: the install route,
    /// as the SPA's addCloudFrameStoreScene does.
    public func approveProposal(_ proposal: JSONValue) async throws -> ActionOutcome {
        guard let frameId = proposal["frame"]?["id"]?.stringValue, let sceneId = proposal["scene"]?["id"]?.stringValue else {
            throw APIError(status: 0, message: "This proposal names no frame or scene.")
        }
        var body: [String: JSONValue] = ["scene_id": .string(sceneId)]
        if let version = proposal["scene"]?["version"], !version.isNull { body["scene_version"] = version }
        if let groups = proposal["declared_settings_groups"], !groups.isNull { body["settings_groups"] = groups }
        try await client.call("POST", Self.framePath(frameId, "/scenes/add"), body: .json(.object(body)))
        return ActionOutcome(kind: .queued, message: "Installed; the push lands when the frame reconnects.")
    }
}
