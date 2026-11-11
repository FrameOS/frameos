import Testing
@testable import FrameOSKit

/// The iOS runner of docs/server-address-fixtures.json: an address typed on
/// the self-hosted sign-in screen means what it means on every other plane.
@Suite struct ServerAddressTests {
    @Test func splitAddressCases() throws {
        let fixtures = try RepoFixtures.json("docs/server-address-fixtures.json")
        let cases = try #require(fixtures["splitAddress"]?["cases"]?.arrayValue)
        #expect(!cases.isEmpty)
        for kase in cases {
            let input = kase["input"]?.stringValue ?? ""
            let expected = ServerAddressParts(
                scheme: kase["scheme"]?.stringValue ?? "",
                host: kase["host"]?.stringValue ?? "",
                port: kase["port"]?.intValue
            )
            #expect(ServerAddress.split(input) == expected, "split(\(input))")
        }
    }

    @Test func schemeFromPortCases() throws {
        let fixtures = try RepoFixtures.json("docs/server-address-fixtures.json")
        for kase in fixtures["schemeFromPort"]?["cases"]?.arrayValue ?? [] {
            #expect(ServerAddress.schemeFromPort(kase["port"]?.intValue ?? 0) == kase["scheme"]?.stringValue)
        }
    }

    @Test func normalizeSchemeCases() throws {
        let fixtures = try RepoFixtures.json("docs/server-address-fixtures.json")
        for kase in fixtures["normalizeScheme"]?["cases"]?.arrayValue ?? [] {
            let scheme = kase["scheme"]?.stringValue ?? ""
            let port = kase["port"]?.intValue ?? 0
            #expect(ServerAddress.normalizeScheme(scheme, port: port) == kase["expected"]?.stringValue, "\(scheme) \(port)")
        }
    }

    @Test func backendBaseURL() {
        #expect(ServerAddress.backendBaseURL("frames.local")?.absoluteString == "http://frames.local:8989")
        #expect(ServerAddress.backendBaseURL("frames.local:8989")?.absoluteString == "http://frames.local:8989")
        #expect(ServerAddress.backendBaseURL("https://frames.example.com")?.absoluteString == "https://frames.example.com")
        #expect(ServerAddress.backendBaseURL("https://frames.example.com:443/")?.absoluteString == "https://frames.example.com")
        #expect(ServerAddress.backendBaseURL("frames.example.com:8443")?.absoluteString == "https://frames.example.com:8443")
        #expect(ServerAddress.backendBaseURL("[fd00::10]:8989")?.absoluteString == "http://[fd00::10]:8989")
        #expect(ServerAddress.backendBaseURL("user:pw@frames.local") == nil)
        #expect(ServerAddress.backendBaseURL("ftp://frames.local") == nil)
        #expect(ServerAddress.backendBaseURL("") == nil)
    }
}
