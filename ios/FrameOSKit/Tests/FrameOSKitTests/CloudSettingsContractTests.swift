import Testing
@testable import FrameOSKit

/// The generated cloud settings table decodes, and gates keys by profile and
/// firmware the way the SPA's cloudFrameSettings.ts does.
@Suite struct CloudSettingsContractTests {
    @Test func tableDecodesAndGatesKeys() throws {
        let contract = CloudSettingsContract.shared
        #expect(contract.profiles["linux"] != nil && contract.profiles["esp32"] != nil)

        let oldLinux = contract.keys(profile: "linux", frameosVersion: "2026.8.1")
        #expect(oldLinux.contains("rotate") && oldLinux.contains("interval"))
        #expect(!oldLinux.contains("render_scale"))

        let newLinux = contract.keys(profile: "linux", frameosVersion: "2026.11.6")
        #expect(newLinux.contains("render_scale") && newLinux.contains("flip"))
        #expect(!newLinux.contains("deep_sleep"))

        let esp32 = contract.keys(profile: "esp32", frameosVersion: "2026.11.6")
        #expect(esp32.contains("deep_sleep") && !esp32.contains("flip"))
        // Companion keys ride along with their key, never on their own.
        #expect(!esp32.contains("timezone_data"))

        // No version reported: only the ungated keys; a dev build: all.
        #expect(!contract.keys(profile: "linux", frameosVersion: nil).contains("render_scale"))
        #expect(contract.keys(profile: "linux", frameosVersion: "dev-build").contains("render_scale"))

        #expect(contract.options("rotate").compactMap(\.intValue) == [0, 90, 180, 270])
    }

    @Test func frameProfiles() {
        let esp = Frame(raw: ["id": "a", "hardware": ["platform": "esp32-s3"], "frameos_version": "2026.11.6"])
        let pi = Frame(raw: ["id": "b", "hardware": ["platform": "buildroot"], "frameos_version": "2026.11.6"])
        #expect(CloudSettingsContract.profile(for: esp) == "esp32")
        #expect(CloudSettingsContract.profile(for: pi) == "linux")
    }
}
