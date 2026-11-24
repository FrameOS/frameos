import Foundation

/// Which hosts plain http stays private on: the device itself, the local
/// network, a name only the local network resolves. The rule the frames use
/// for an `http://` provider (`fos_url_host_is_local`,
/// embedded/esp32/main/fos_url_guard.c; the backend's `_is_local_host`), with
/// the home-network names the backend's setup check knows
/// (`setup_host_allowed`, app/api/cloud.py). It decides a warning on the
/// sign-in screen, never whether the app connects: how a typed address is
/// read stays `ServerAddress`'s.
public enum LocalNetwork {
    static let localSuffixes = [
        ".local", ".localhost", ".lan", ".home", ".internal", ".localdomain", ".home.arpa", ".fritz.box",
    ]

    /// Loopback, a private or link-local address (RFC 1918, 169.254/16, the
    /// carrier-grade 100.64/10, fc00::/7, fe80::/10), `localhost`, a name
    /// without a dot, or one under a home-network suffix.
    public static func isLocalHost(_ rawHost: String) -> Bool {
        var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return false }
        if host.contains(":") {
            // An IPv6 literal, its zone (`%en0`) aside.
            if let zone = host.firstIndex(of: "%") { host = String(host[..<zone]) }
            if host == "::1" { return true }
            return ["fc", "fd", "fe8", "fe9", "fea", "feb"].contains { host.hasPrefix($0) }
        }
        if let octets = ipv4Octets(host) {
            let a = octets[0]
            let b = octets[1]
            return a == 127 || a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
                || (a == 169 && b == 254) || (a == 100 && (64...127).contains(b))
        }
        if !host.contains(".") { return true }
        return localSuffixes.contains { host.hasSuffix($0) }
    }

    /// `a.b.c.d` with four decimal numbers up to 255, or nil.
    static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let digits: ClosedRange<Character> = "0"..."9"
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ digits.contains($0) }),
                  let value = Int(part), value <= 255
            else { return nil }
            octets.append(value)
        }
        return octets
    }

    /// Whether what the app sends to `url` (the password at sign-in, its API
    /// token on every request after) crosses a network that is not the local
    /// one unencrypted: plain http to a host that is not local.
    public static func sendsInClearBeyondIt(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http", let host = url.host, !host.isEmpty else { return false }
        return !isLocalHost(host)
    }
}
