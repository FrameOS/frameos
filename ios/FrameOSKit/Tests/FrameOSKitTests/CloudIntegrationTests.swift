import Foundation
import Testing
@testable import FrameOSKit

/// The app's cloud path, signed in, against a cloud you can write to (a
/// local dev server, never production): the session and its Origin, frames
/// and their commands, a store scene installed, activated and removed,
/// settings, schedule and button actions, photos, the account, sign-out.
/// Skipped unless FRAMEOS_IT_CLOUD_EMAIL and FRAMEOS_IT_CLOUD_PASSWORD name a
/// verified account without two-factor sign-in on FRAMEOS_IT_CLOUD. The
/// frame steps need a frame on the account (a virtual frame does: the hub
/// runs its device); the install takes FRAMEOS_IT_CLOUD_SCENE from the store
/// (default "Word clock", which asks for no keys).
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["FRAMEOS_IT_CLOUD_EMAIL"] != nil))
struct CloudIntegrationTests {
    static var environment: [String: String] { ProcessInfo.processInfo.environment }
    static var baseURL: URL { URL(string: environment["FRAMEOS_IT_CLOUD"] ?? "http://localhost:3000")! }

    func signedIn() async throws -> FrameOSService {
        let step = try await AuthService.cloudSignIn(baseURL: Self.baseURL, email: Self.environment["FRAMEOS_IT_CLOUD_EMAIL"] ?? "",
                                                     password: Self.environment["FRAMEOS_IT_CLOUD_PASSWORD"] ?? "")
        guard case .signedIn(let account, let client) = step else {
            throw APIError(status: 0, message: "The test account has two-factor sign-in: use one without.")
        }
        #expect(client.cookies().contains { $0.name.contains("session") }, "the session cookie")
        // What the Keychain keeps brings the same account back.
        let restored = APIClient(account: account, credentials: AccountCredentials.load(accountId: account.id) ?? AccountCredentials())
        return FrameOSService(client: restored)
    }

    @Test func endToEnd() async throws {
        let service = try await signedIn()
        let client = service.client

        // The account.
        _ = try await service.accountSummary()
        _ = try await service.serviceSettings()
        _ = try await service.chats(frame: nil)

        // The store, both shelves.
        let store = try await service.catalog()
        _ = try await service.catalog(mine: true)

        // A frame: commands, a store scene, settings.
        if var frame = try await service.frames().first {
            frame = try await service.frame(frame.id)
            let rendered = try await service.render(frame)
            if case .failed(let error) = rendered.kind { Issue.record("render: \(error)") }
            _ = try await service.commands(frame)
            _ = try await service.logs(frame)
            _ = try await service.metrics(frame)

            let wanted = Self.environment["FRAMEOS_IT_CLOUD_SCENE"] ?? "Word clock"
            if let item = store.items.first(where: { $0.name == wanted }) ?? store.items.first(where: { !$0.needsShell }) {
                let outcome = try await service.install(item, on: frame, activate: true)
                if case .failed(let error) = outcome.kind { Issue.record("install: \(error)") }
                frame = try await service.frame(frame.id)
                let scenes = try await service.installedScenes(frame)
                let installed = try #require(scenes.first { $0.name == item.name }, "\(item.name) is not on the list: \(scenes.map(\.name))")
                _ = try await service.states(frame)
                _ = try await service.activate(frame, sceneId: installed.id)

                // Settings, schedule and button actions, as the frame's profile allows.
                let editable = service.editableSettings(frame)
                if editable.contains("interval") {
                    _ = try await service.saveSettings(frame, ["interval": 900])
                }
                _ = try await service.saveSchedule(frame, events: [ScheduleEvent.new(sceneId: installed.id, hour: 7, minute: 15, weekday: 8)], disabled: false)
                frame = try await service.frame(frame.id)
                #expect(service.schedule(frame).events.first?.hour == 7)

                _ = try await service.removeScene(frame, installed)
                frame = try await service.frame(frame.id)
                #expect(try await service.installedScenes(frame).contains { $0.id == installed.id } == false)
            }
        }

        // Photos: the contract both planes serve.
        let status = try await service.photosStatus()
        if status.ready {
            let album = "iOS test \(Int(Date().timeIntervalSince1970))"
            try await service.createAlbum(album)
            let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==")!
            let stored = try await service.uploadPhoto(folder: album, filename: "dot.png", data: png)
            #expect(stored == "\(album)/dot.png")
            let photo = try #require(try await service.photos(in: album).first)
            #expect(photo.width == 2)
            _ = try await service.photoThumbnail(photo.path, version: photo.version)
            try await service.renamePhoto(photo.path, to: "pixel.png")
            let share = try await service.createShare(path: album, name: "iOS")
            #expect(share.token.hasPrefix("pk_"))
            #expect(service.shareURL(share).hasPrefix("http"))
            try await service.deleteShare(share)
            try await service.deletePhotos([album])
        }

        // Sign out: the session is gone.
        let cookies = client.cookies()
        await AuthService.signOut(client)
        let byCookie = APIClient(account: client.account, credentials: AccountCredentials(cookies: cookies.map(StoredCookie.init)))
        do {
            _ = try await byCookie.call("GET", "/api/frames")
            Issue.record("the session still works after signing out")
        } catch let error as APIError {
            #expect(error.isUnauthorized)
        }
    }
}
