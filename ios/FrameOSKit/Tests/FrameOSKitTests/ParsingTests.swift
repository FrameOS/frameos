import Foundation
import Testing
@testable import FrameOSKit

/// The shapes both planes answer in, read the same way.
@Suite struct ParsingTests {
    @Test func actionOutcomes() {
        // The cloud's queue, a Linux frame's "OK", an ESP32 command outcome.
        #expect(ActionOutcome.from(["command_id": "x", "status": "queued"]).kind == .queued)
        #expect(ActionOutcome.from("OK").kind == .done)
        #expect(ActionOutcome.from(["status": "applied", "applied": true]).kind == .done)
        #expect(ActionOutcome.from(["status": "failed", "error": "busy"]).kind == .failed("busy"))
        #expect(ActionOutcome.from(["message": "Success"]).message == "Success")
    }

    @Test func liveEvents() {
        guard case .updateFrame(let patch)? = LiveUpdates.parse(["event": "update_frame", "data": ["id": 3, "status": "ready"]]) else {
            Issue.record("update_frame")
            return
        }
        #expect(patch["status"] == "ready")
        guard case .newLog(let line)? = LiveUpdates.parse(["event": "new_log", "data": [
            "id": 9, "frame_id": 3, "type": "webhook", "line": "{\"event\":\"render:done\"}",
        ]]) else {
            Issue.record("new_log")
            return
        }
        #expect(line.event == "render:done" && line.frameId == "3")
        guard case .rendered(let frameId)? = LiveUpdates.parse(["event": "frame_rendered", "data": ["frameId": 3]]) else {
            Issue.record("frame_rendered")
            return
        }
        #expect(frameId == "3")
        #expect(LiveUpdates.parse(["event": "pong", "payload": "ping"]) == nil)
    }

    @Test func chatEvents() {
        #expect(FrameOSService.chatEvent(["type": "chat", "chatId": "c", "turnId": "t"]) == .started(chatId: "c", turnId: "t"))
        #expect(FrameOSService.chatEvent(["type": "delta", "text": "Hi"]) == .delta("Hi"))
        #expect(FrameOSService.chatEvent(["type": "error", "detail": "no"]) == .failed("no"))
        #expect(FrameOSService.chatEvent(["type": "ping"]) == nil)
    }

    @Test func errors() {
        let cloud = APIError.from(status: 409, data: Data(#"{"error":"frame_not_active"}"#.utf8), headers: [:])
        #expect(cloud.code == "frame_not_active" && cloud.message == "This frame is not active.")
        let backend = APIError.from(status: 400, data: Data(#"{"detail":"Frame not found"}"#.utf8), headers: [:])
        #expect(backend.message == "Frame not found")
        let validation = APIError.from(status: 422, data: Data(#"{"detail":[{"loc":["body","x"],"msg":"field required"}]}"#.utf8), headers: [:])
        #expect(validation.message == "field required")
        let limited = APIError.from(status: 429, data: Data(#"{"error":"rate_limited","retry_after":12}"#.utf8), headers: [:])
        #expect(limited.retryAfter == 12)
        #expect(APIError.from(status: 401, data: Data(), headers: [:]).isUnauthorized)
    }

    @Test func assetPathsAreRelative() {
        let client = APIClient(account: Account(kind: .backend, baseURL: URL(string: "http://b")!, email: "", projectId: 1),
                               credentials: AccountCredentials())
        let service = FrameOSService(client: client)
        let frame = Frame(raw: ["id": 1, "assets_path": "/srv/assets/"])
        #expect(service.relativeAssetPath("/srv/assets/photos/a.jpg", frame) == "photos/a.jpg")
        #expect(service.relativeAssetPath("/srv/assets", frame) == "")
        #expect(service.relativeAssetPath("fonts/x.ttf", frame) == "fonts/x.ttf")
    }

    @Test func sceneIds() {
        #expect(SceneIds.refer("uploaded/abc", "abc"))
        #expect(!SceneIds.refer(nil, "abc"))
        #expect(SceneIds.isBuiltIn("system/sceneSwitcher"))
    }

    @Test func pathsAreEncodedOnce() {
        let client = APIClient(account: Account(kind: .cloud, baseURL: Account.defaultCloudURL, email: ""), credentials: AccountCredentials())
        let service = FrameOSService(client: client)
        _ = service
        let path = FrameOSService.framePath("f 1", "/scene_images/\(ApiPaths.encodePath("my scene/ä"))")
        #expect(client.url(path).absoluteString == "https://cloud.frameos.net/api/frames/f%201/scene_images/my%20scene/%C3%A4")
        #expect(client.url("/api/frames/x/scene_images/system/index").path == "/api/frames/x/scene_images/system/index")
        #expect(client.url("/api/ai/chats/\(ApiPaths.segment("a%b"))").absoluteString.hasSuffix("/api/ai/chats/a%25b"))
    }

    @Test func unknownErrorCodesReadAsWords() {
        let error = APIError.from(status: 400, data: Data(#"{"error":"weird_thing_happened"}"#.utf8), headers: [:])
        #expect(error.message == "Weird thing happened.")
        let known = APIError.from(status: 403, data: Data(#"{"error":"second_factor_required"}"#.utf8), headers: [:])
        #expect(known.message.contains("code"))
    }

    @Test func activeLayout() {
        let layout: JSONValue = ["id": "chrome", "settings": ["isLayout": true]]
        let a: JSONValue = ["id": "a", "layout": ["sceneId": "chrome", "state": ["h": 40]]]
        let b: JSONValue = ["id": "b", "layout": ["sceneId": "chrome"]]
        let bare: JSONValue = ["id": "c"]
        #expect(SceneLayouts.active([layout, a, b]) == ["sceneId": "chrome", "state": ["h": 40]])
        #expect(SceneLayouts.active([layout, a, bare]) == nil, "the scenes differ")
        #expect(SceneLayouts.active([a, b]) == nil, "a layout the frame no longer has")
        #expect(SceneLayouts.active([layout]) == nil)
    }

    @Test func eventMapLimits() {
        let contract = CloudSettingsContract.shared
        #expect(contract.maxItems("event_map", profile: "esp32") == 8)
        #expect(contract.maxItems("event_map", profile: "linux") == 32)
    }

    /// `Origin` as a browser writes it: the cloud compares it as text.
    @Test func originIsWrittenLikeABrowsers() {
        func origin(_ url: String) -> String { Account(kind: .cloud, baseURL: URL(string: url)!, email: "").origin }
        #expect(origin("https://cloud.frameos.net") == "https://cloud.frameos.net")
        #expect(origin("https://Cloud.FrameOS.net") == "https://cloud.frameos.net")
        #expect(origin("HTTPS://cloud.frameos.net:443/") == "https://cloud.frameos.net")
        #expect(origin("http://Frames.local:8989") == "http://frames.local:8989")
        #expect(origin("http://localhost:80") == "http://localhost")
        #expect(origin("http://[::1]:3003") == "http://[::1]:3003")
    }
}
