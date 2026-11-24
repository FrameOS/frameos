import Foundation
import Testing
@testable import FrameOSKit

/// Where the account's credentials may go, and when the sign-in screen warns:
/// a catalog picture's address is anyone's, and so is a typed backend address.
@Suite struct SameOriginTests {
    /// The bearer (or the cloud's cookies) goes to the plane's own origin
    /// alone. The same host on another port is another program, and the same
    /// host over plain http can be read on the way.
    @Test func credentialsStayOnTheAccountsOwnOrigin() {
        let backend = Account(kind: .backend, baseURL: URL(string: "https://frames.example.com:8443")!, email: "", projectId: 1)
        func same(_ url: String) -> Bool { backend.isSameOrigin(URL(string: url)!) }
        #expect(same("https://frames.example.com:8443/api/repositories/system/samples/templates/x/image"))
        #expect(same("HTTPS://Frames.Example.com:8443/x"))
        #expect(!same("http://frames.example.com:8443/x"))
        #expect(!same("https://frames.example.com/x"))
        #expect(!same("https://frames.example.com:9000/x"))
        #expect(!same("https://frames.example.com.evil.example:8443/x"))
        #expect(!same("https://frames.example.com:8443@evil.example/x"))
        #expect(!same("ftp://frames.example.com:8443/x"))
        #expect(!same("/api/templates/1/image"))

        // A default port said or not is one origin.
        let plain = Account(kind: .backend, baseURL: URL(string: "http://frames.local")!, email: "", projectId: 1)
        #expect(plain.isSameOrigin(URL(string: "http://frames.local:80/x")!))
        #expect(!plain.isSameOrigin(URL(string: "http://frames.local:8989/x")!))
        #expect(!plain.isSameOrigin(URL(string: "https://frames.local/x")!))

        let cloud = Account(kind: .cloud, baseURL: Account.defaultCloudURL, email: "")
        #expect(cloud.isSameOrigin(URL(string: "https://cloud.frameos.net:443/api/store/scenes")!))
        #expect(!cloud.isSameOrigin(URL(string: "https://scenes.frameos.net/x")!))
        #expect(!cloud.isSameOrigin(URL(string: "http://cloud.frameos.net/x")!))

        let v6 = Account(kind: .backend, baseURL: URL(string: "http://[fd00::10]:8989")!, email: "", projectId: 1)
        #expect(v6.isSameOrigin(URL(string: "http://[fd00::10]:8989/x")!))
        #expect(!v6.isSameOrigin(URL(string: "http://[fd00::11]:8989/x")!))
    }

    @Test func originOfAnyURL() {
        #expect(Account.origin(of: URL(string: "https://Example.com:443/a?b#c")!) == "https://example.com")
        #expect(Account.origin(of: URL(string: "http://example.com:8080")!) == "http://example.com:8080")
        #expect(Account.origin(of: URL(string: "http://[::1]:3003/x")!) == "http://[::1]:3003")
        #expect(Account.origin(of: URL(string: "file:///etc/hosts")!) == nil)
        #expect(Account.origin(of: URL(string: "relative/path")!) == nil)
    }

    /// The rule the frames use for an http:// provider, with the names a
    /// home network gives its hosts.
    @Test func localHosts() {
        for host in [
            "localhost", "LOCALHOST", "frames.local", "frames.local.", "nas", "frameos", "pi.lan", "box.fritz.box",
            "backend.home.arpa", "x.internal", "127.0.0.1", "10.4.0.16", "172.16.0.1", "172.31.255.255",
            "192.168.1.20", "169.254.3.4", "100.64.0.1", "100.127.255.255", "::1", "[::1]", "fe80::1",
            "fe80::1%en0", "febf::1", "fd00::10", "[fc00::1]",
        ] {
            #expect(LocalNetwork.isLocalHost(host), "\(host) is local")
        }
        for host in [
            "", "frames.example.com", "example.local.evil.com", "8.8.8.8", "172.15.0.1", "172.32.0.1",
            "192.169.1.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "2001:db8::1", "fec0::1",
            "999.1.1.1", "1.2.3", "localhost.example.com",
        ] {
            #expect(!LocalNetwork.isLocalHost(host), "\(host) is not local")
        }
    }

    /// The sign-in screen's note: plain http to somewhere that is not the
    /// local network. How a typed address is read is ServerAddress's rule,
    /// unchanged (docs/server-address-fixtures.json).
    @Test func plainHTTPBeyondTheLocalNetwork() {
        func warns(_ typed: String) -> Bool {
            ServerAddress.backendBaseURL(typed).map(LocalNetwork.sendsInClearBeyondIt) ?? false
        }
        #expect(warns("frames.example.com"))
        #expect(warns("frames.example.com:8989"))
        #expect(warns("http://frames.example.com"))
        #expect(warns("203.0.113.7:8989"))
        #expect(!warns("https://frames.example.com"))
        #expect(!warns("frames.example.com:8443"))
        #expect(!warns("frames.local"))
        #expect(!warns("frameos:8989"))
        #expect(!warns("192.168.1.20:8989"))
        #expect(!warns("[fd00::10]:8989"))
        #expect(!warns("100.100.20.3"))
        #expect(!warns(""))
    }
}
