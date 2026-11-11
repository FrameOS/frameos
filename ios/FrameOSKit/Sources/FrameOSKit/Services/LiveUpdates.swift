import Foundation

/// A message from the plane's live socket (the SPA's socketLogic.tsx):
/// `{"event": name, "data": {...}}` on both planes.
public enum LiveEvent: Sendable {
    /// A frame row changed. A backend often sends only the keys that did:
    /// merge by id.
    case updateFrame([String: JSONValue])
    case newFrame([String: JSONValue])
    case deleteFrame(String)
    case newLog(LogLine)
    case newMetrics(frameId: String, MetricSample)
    /// A new picture (backend `frame_rendered` / `new_scene_image`).
    case rendered(frameId: String)
    /// The socket (re)connected: refetch what is on screen (`socketReconnected`).
    case connected
}

/// Keeps the plane's live socket open while the app is in front, and
/// reconnects with a backoff. Both planes authenticate the socket with the
/// session cookie alone; when that is gone (a backend signed in with a token
/// whose login cookie expired), the app falls back to polling.
public final class LiveUpdates: @unchecked Sendable {
    let client: APIClient
    private var task: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?
    private let handler: @Sendable (LiveEvent) -> Void
    public private(set) var isConnected = false

    public init(client: APIClient, handler: @escaping @Sendable (LiveEvent) -> Void) {
        self.client = client
        self.handler = handler
    }

    public func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                let opened = await self.runOnce()
                if Task.isCancelled { break }
                delay = opened ? 1 : min(delay * 2, 60)
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            }
        }
    }

    public func stop() {
        loop?.cancel()
        loop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
    }

    /// One connection, until it closes. True when it got as far as a message.
    private func runOnce() async -> Bool {
        let socket = client.webSocket()
        task = socket
        socket.resume()
        var received = false
        // Both planes answer "ping" with a pong: the first one says the
        // socket is open (a backend sends nothing else until something happens).
        let pinger = Task {
            while !Task.isCancelled {
                try? await socket.send(.string("ping"))
                try? await Task.sleep(nanoseconds: 25_000_000_000)
            }
        }
        defer {
            pinger.cancel()
            isConnected = false
        }
        while true {
            do {
                let message = try await socket.receive()
                if !received {
                    received = true
                    isConnected = true
                    handler(.connected)
                }
                let text: String
                switch message {
                case .string(let value): text = value
                case .data(let data): text = String(decoding: data, as: UTF8.self)
                @unknown default: continue
                }
                guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
                      let event = Self.parse(value) else { continue }
                handler(event)
            } catch {
                return received
            }
        }
    }

    static func parse(_ message: JSONValue) -> LiveEvent? {
        let data = message["data"] ?? message["payload"] ?? .null
        switch message["event"]?.stringValue {
        case "update_frame": return data.objectValue.map(LiveEvent.updateFrame)
        case "new_frame": return data.objectValue.map(LiveEvent.newFrame)
        case "delete_frame": return data["id"]?.stringValue.map(LiveEvent.deleteFrame)
        case "new_log": return data.objectValue.map { .newLog(LogLine(raw: $0)) }
        case "new_metrics":
            guard let object = data.objectValue else { return nil }
            return .newMetrics(frameId: object["frame_id"]?.stringValue ?? "", MetricSample(raw: object))
        case "frame_rendered", "new_scene_image":
            return (data["frameId"]?.stringValue ?? data["frame_id"]?.stringValue).map { .rendered(frameId: $0) }
        default:
            return nil
        }
    }
}
