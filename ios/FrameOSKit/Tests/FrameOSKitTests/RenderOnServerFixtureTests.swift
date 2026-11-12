import Foundation
import Testing
@testable import FrameOSKit

/// The iOS runner of docs/render-on-server-fixtures.json, and what the
/// settings offer from it on each plane ("Render scenes", "Processor speed").
@Suite struct RenderOnServerFixtureTests {
    @Test func renderOnServerCorpus() throws {
        let fixtures = try RepoFixtures.json("docs/render-on-server-fixtures.json")

        let canRender = try #require(fixtures["canRenderItself"]?.arrayValue)
        #expect(canRender.count > 5)
        for kase in canRender {
            let hardware = kase["hardware"]?.objectValue
            #expect(RenderOnServer.canRenderItself(hardware: hardware) == kase["expect"]?.boolValue, "\(kase)")
        }

        let cloud = try #require(fixtures["cloudRenderMode"]?.arrayValue)
        for kase in cloud {
            let frame = kase["frame"]
            let mode = RenderOnServer.cloudMode(renderMode: frame?["render_mode"], hardware: frame?["hardware"]?.objectValue)
            #expect(mode.rawValue == kase["expect"]?.stringValue, "\(kase)")
        }

        let backend = try #require(fixtures["backendRenderMode"]?.arrayValue)
        for kase in backend {
            let frame = kase["frame"]
            let mode = RenderOnServer.backendMode(deviceConfig: frame?["device_config"], embedded: frame?["embedded"])
            #expect(mode.rawValue == kase["expect"]?.stringValue, "\(kase)")
        }

        let boards = try #require(fixtures["backendBoards"]?.arrayValue)
        for kase in boards {
            let platform = kase["platform"]?.stringValueIfString
            #expect(RenderOnServer.backendPowerProfile(platform: platform) == kase["powerProfile"]?.stringValueIfString, "\(kase)")
            #expect(RenderOnServer.backendOffers(platform: platform) == kase["offersRenderOnServer"]?.boolValue, "\(kase)")
        }
    }

    func service(_ kind: PlaneKind) -> FrameOSService {
        let account = kind == .cloud
            ? Account(kind: .cloud, baseURL: Account.defaultCloudURL, email: "")
            : Account(kind: .backend, baseURL: URL(string: "http://b")!, email: "", projectId: 1)
        return FrameOSService(client: APIClient(account: account, credentials: AccountCredentials()))
    }

    @Test func cloudOffersRenderScenesOnAnS3() throws {
        let cloud = service(.cloud)
        let s3 = Frame(raw: ["id": "a", "hardware": ["platform": "esp32-s3", "cpuMhz": 160], "frameos_version": "2026.11.7"])
        let choice = try #require(cloud.renderOnServerChoice(s3))
        #expect(choice.serverName == "FrameOS Cloud" && choice.disabledReason == nil && choice.note != nil)
        #expect(cloud.renderMode(s3) == .local)
        #expect(cloud.cpuModeChoice(s3) == CpuModeChoice(disabledReason: nil, reportedMhz: 160))

        // The floor comes from the generated contract, not from this file.
        let since = try #require(CloudSettingsContract.shared.since("render_mode", profile: "esp32"))
        let old = Frame(raw: ["id": "a", "hardware": ["platform": "esp32-s3"], "frameos_version": "2026.11.6"])
        #expect(cloud.renderOnServerChoice(old)?.disabledReason == "Rendering on the server needs FrameOS \(since) or newer on the frame.")
        #expect(cloud.cpuModeChoice(old)?.disabledReason != nil)

        // A C3 is rendered by the cloud anyway; a Pi has neither field.
        let c3 = Frame(raw: ["id": "c", "hardware": ["platform": "esp32-c3"], "frameos_version": "2026.11.7"])
        #expect(cloud.renderOnServerChoice(c3) == nil)
        #expect(cloud.cpuModeChoice(c3) != nil)
        let pi = Frame(raw: ["id": "p", "hardware": ["platform": "buildroot"], "frameos_version": "2026.11.7"])
        #expect(cloud.renderOnServerChoice(pi) == nil && cloud.cpuModeChoice(pi) == nil)

        let remote = Frame(raw: ["id": "a", "hardware": ["platform": "esp32-s3"], "render_mode": "remote", "cpu_mode": "performance"])
        #expect(cloud.renderMode(remote) == .remote)
        #expect(cloud.cpuMode(remote) == "performance")
    }

    @Test func backendOffersRenderScenesOnAnEmbeddedS3() throws {
        let backend = service(.backend)
        let s3 = Frame(raw: ["id": 1, "mode": "embedded", "embedded": ["platform": "esp32-s3"],
                             "device_config": ["renderMode": "remote", "cpu_mode": "battery"]])
        let choice = try #require(backend.renderOnServerChoice(s3))
        #expect(choice.serverName == "the backend" && choice.disabledReason == nil && choice.note == nil)
        #expect(backend.renderMode(s3) == .remote)
        #expect(backend.cpuMode(s3) == "battery")
        #expect(backend.cpuModeChoice(s3) == CpuModeChoice(disabledReason: nil, reportedMhz: nil))

        let c3 = Frame(raw: ["id": 2, "mode": "embedded", "embedded": ["platform": "esp32-c3"]])
        #expect(backend.renderOnServerChoice(c3) == nil && backend.cpuModeChoice(c3) != nil)
        let pico = Frame(raw: ["id": 3, "mode": "embedded", "embedded": ["platform": "pico-2w"]])
        #expect(backend.renderOnServerChoice(pico) == nil && backend.cpuModeChoice(pico) == nil)
        let virtual = Frame(raw: ["id": 4, "mode": "embedded", "embedded": ["platform": "virtual"]])
        #expect(backend.renderOnServerChoice(virtual) == nil && backend.cpuModeChoice(virtual) == nil)
        let pi = Frame(raw: ["id": 5, "mode": "rpios"])
        #expect(backend.renderOnServerChoice(pi) == nil && backend.cpuModeChoice(pi) == nil)
    }

    @Test func quotaRefusalInWords() {
        let none = APIError.from(status: 403, data: Data(#"{"error":"cloud_rendered_frame_quota_exceeded","max_cloud_rendered_frames":0}"#.utf8),
                                 headers: [:])
        #expect(none.message == "Your plan has no frames rendered on FrameOS Cloud. A paid plan includes them.")
        let two = APIError.from(status: 403, data: Data(#"{"error":"cloud_rendered_frame_quota_exceeded","max_cloud_rendered_frames":2}"#.utf8),
                                headers: [:])
        #expect(two.message == "Your plan renders 2 frames on FrameOS Cloud, and all of them are in use. Free one up or move to a larger plan.")
    }
}
