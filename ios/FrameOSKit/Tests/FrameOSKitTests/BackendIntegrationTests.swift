import Foundation
import Testing
@testable import FrameOSKit

/// The app's backend path against a real self-hosted backend: sign-up (an
/// empty backend) or sign-in (ios/bin/test-backend's user), the API token,
/// frames, scenes through the backend's MCP, settings, photos, the live
/// socket, sign-out. Skipped unless FRAMEOS_IT_BACKEND names one (e.g.
/// http://127.0.0.1:8997): it creates a frame there and deletes it.
/// ios/README.md "Tests" has the recipe.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["FRAMEOS_IT_BACKEND"] != nil))
struct BackendIntegrationTests {
    static var baseURL: URL { URL(string: ProcessInfo.processInfo.environment["FRAMEOS_IT_BACKEND"] ?? "http://127.0.0.1:8997")! }
    // ios/bin/test-backend's first user; an empty backend gets it too.
    static let email = ProcessInfo.processInfo.environment["FRAMEOS_IT_EMAIL"] ?? "tester@example.com"
    static let password = ProcessInfo.processInfo.environment["FRAMEOS_IT_PASSWORD"] ?? "frameos-test-1"

    func signedIn() async throws -> FrameOSService {
        let signUp = try await !AuthService.backendHasFirstUser(baseURL: Self.baseURL)
        let (account, client) = try await AuthService.backendSignIn(baseURL: Self.baseURL, email: Self.email,
                                                                    password: Self.password, signUp: signUp)
        #expect(account.projectId != nil)
        #expect(client.currentCredentials.bearer?.hasPrefix("fb_api") == true, "a year-long token, not the JWT")
        #expect(client.cookies().contains { $0.name == "frameos_session" }, "the socket's cookie")
        // What the Keychain keeps brings the same account back.
        let restored = APIClient(account: account, credentials: AccountCredentials.load(accountId: account.id) ?? AccountCredentials())
        return FrameOSService(client: restored)
    }

    /// Layouts on a frame of its own (LayoutRoundTrip), deleted after.
    @Test func layouts() async throws {
        let service = try await signedIn()
        let created = try await service.client.call("POST", "/api/frames/new", body: .json([
            "name": "iOS layouts frame", "frame_host": "127.0.0.1", "server_host": "127.0.0.1:8997", "mode": "rpios",
        ]))
        let frameId = try #require(created["frame"]?["id"]?.stringValue)
        var failure: Error?
        do { try await LayoutRoundTrip.run(service, frameId: frameId) } catch { failure = error }
        try await service.delete(try await service.frame(frameId))
        if let failure { throw failure }
    }

    @Test func endToEnd() async throws {
        let service = try await signedIn()
        let client = service.client

        // A frame (the app does not add frames; the web does).
        let created = try await client.call("POST", "/api/frames/new", body: .json([
            "name": "iOS test frame", "frame_host": "127.0.0.1", "server_host": "127.0.0.1:8997", "mode": "rpios",
        ]))
        let frameId = try #require(created["frame"]?["id"]?.stringValue)
        var frame = try await service.frame(frameId)
        #expect(try await service.frames().contains { $0.id == frameId })
        #expect(FrameStatus.activity(frame, plane: .backend) == "waiting for first deploy")
        #expect(try await service.installedScenes(frame).isEmpty)

        // Install raw scenes through the backend's own MCP tool: fresh ids.
        let scene: JSONValue = [
            "id": "ios-test-scene", "name": "Hello", "nodes": [], "edges": [],
            "fields": [["name": "title", "type": "string", "access": "public", "value": "Hi"]],
            "settings": ["execution": "interpreted"],
        ]
        let cover = "/api/repositories/system/samples/templates/Analog clock face/image"
        _ = try await service.backendInstall(frame, ["scenes": [scene], "name": "Hello"], activate: false, cover: cover)
        frame = try await service.frame(frameId)
        let installed = try await service.installedScenes(frame)
        #expect(installed.count == 1)
        #expect(installed.first?.name == "Hello")
        #expect(installed.first?.id != "ios-test-scene", "ids are made fresh")
        #expect(installed.first?.fields.map(\.name) == ["title", "refreshInterval"])
        // Its picture is the catalog cover until the frame draws it, not the
        // backend's placeholder (which it serves with no-store).
        let picturePath = FrameOSService.framePath(frameId, "/scene_images/\(ApiPaths.encodePath(try #require(installed.first?.id)))")
        let (_, picture) = try await client.bytes(picturePath)
        #expect(picture.value(forHTTPHeaderField: "Cache-Control") == "private, max-age=86400")

        // A store scene is granted the keys it declares, as on the cloud.
        let storeScene: JSONValue = [
            "id": "ios-store-scene", "name": "Store photos", "edges": [],
            "origin": ["storeSceneId": "0b3f7c1e-1111-4222-8333-944455556666"],
            "nodes": [["id": "n1", "type": "app", "position": ["x": 0, "y": 0],
                       "data": ["keyword": "photos", "sources": ["config.json": #"{"name":"Photos","settings":["unsplash"]}"#]]]],
        ]
        _ = try await service.backendInstall(frame, ["scenes": [storeScene], "name": "Store photos"], activate: false)
        frame = try await service.frame(frameId)
        #expect(frame["service_setting_groups"]?.arrayValue?.compactMap(\.stringValue) == ["unsplash"])
        let storeInstalled = try #require(try await service.installedScenes(frame).first { $0.name == "Store photos" })
        _ = try await service.removeScene(frame, storeInstalled)
        frame = try await service.frame(frameId)

        // Settings, schedule, button actions and voice switches save on the backend.
        _ = try await service.saveSettings(frame, ["interval": 600, "rotate": 90])
        frame = try await service.frame(frameId)
        #expect(frame.interval == 600 && frame.rotate == 90)
        let sceneId = try #require(installed.first?.id)
        _ = try await service.saveSchedule(frame, events: [ScheduleEvent.new(sceneId: sceneId, hour: 8, minute: 30, weekday: 8)], disabled: false)
        let binding = ButtonBinding(gesture: .button(label: "LEFT", action: "longPress"), kind: "prevScene")
        _ = try await service.saveEventMap(frame, rules: ButtonBindings.rules([binding], others: []))
        try await service.saveVoicePermissions(frame, VoicePermissions(values: ["use_albums": false]))
        frame = try await service.frame(frameId)
        #expect(service.schedule(frame).events.first?.hour == 8)
        #expect(ButtonBindings.split(service.eventMap(frame) ?? []).bindings == [binding])
        #expect(VoicePermissions.of(frame, plane: .backend).values["use_albums"] == false)
        #expect(VoicePermissions.of(frame, plane: .backend).values["use_scenes"] == true)

        // Remove it again (saved without it, deploy queued).
        _ = try await service.removeScene(frame, try #require(installed.first))
        frame = try await service.frame(frameId)
        #expect(try await service.installedScenes(frame).isEmpty)

        // Reads that need no device.
        #expect(try await service.commands(frame).isEmpty)
        _ = try await service.logs(frame)
        _ = try await service.metrics(frame)
        _ = try await service.catalog()

        // Photos: the same contract as the cloud.
        let status = try await service.photosStatus()
        #expect(status.ready)
        try await service.createAlbum("iOS test")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==")!
        try await service.uploadPhoto(folder: "iOS test", filename: "dot.png", data: png)
        let photos = try await service.photos(in: "iOS test")
        let photo = try #require(photos.first)
        #expect(photo.name == "dot.png" && photo.width == 2)
        _ = try await service.photoThumbnail(photo.path, version: photo.version)
        try await service.renamePhoto(photo.path, to: "pixel.png")
        let share = try await service.createShare(path: "iOS test", name: "iOS")
        #expect(share.token.hasPrefix("pk_"))
        #expect(service.shareURL(share).hasPrefix("http"))
        try await service.deleteShare(share)
        try await service.deletePhotos(["iOS test"])
        #expect(try await service.photos(in: "").isEmpty)

        // The live socket opens with the login's cookie.
        final class Seen: @unchecked Sendable { var connected = false }
        let seen = Seen()
        let live = LiveUpdates(client: client) { event in
            if case .connected = event { seen.connected = true }
        }
        live.start()
        for _ in 0..<50 where !seen.connected { try await Task.sleep(nanoseconds: 100_000_000) }
        live.stop()
        #expect(seen.connected)

        // Clean up and sign out: the session and the token are both gone.
        try await service.delete(frame)
        let cookie = try #require(client.cookies().first { $0.name == "frameos_session" })
        let token = try #require(client.currentCredentials.bearer)
        await AuthService.signOut(client)
        await #expect(throws: APIError.self) { try await client.call("GET", "/api/frames") }
        let byCookie = APIClient(account: client.account, credentials: AccountCredentials(cookies: [StoredCookie(cookie)]))
        await #expect(throws: APIError.self) { try await byCookie.call("GET", "/api/frames") }
        let byToken = APIClient(account: client.account, credentials: AccountCredentials(bearer: token))
        await #expect(throws: APIError.self) { try await byToken.call("GET", "/api/frames") }
    }
}
