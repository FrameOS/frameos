import Foundation

/// A typed backend address, split the way every plane splits one
/// (docs/server-address-fixtures.json; the SPA's `splitServerAddress` in
/// frontend/src/utils/backendAddress.ts, the backend's
/// app/utils/server_address.py, the runtime's types.nim). The app reads the
/// address typed on the self-hosted sign-in screen with it, so
/// `frames.local:8989`, `https://frames.example.com` and `[fd00::10]:8989`
/// mean what they mean everywhere else. Replayed by ServerAddressTests.
public struct ServerAddressParts: Equatable, Sendable {
    /// "" when the address did not say.
    public var scheme: String
    public var host: String
    /// nil when the address did not say.
    public var port: Int?

    public init(scheme: String, host: String, port: Int?) {
        self.scheme = scheme
        self.host = host
        self.port = port
    }
}

public enum ServerAddress {
    /// The ONE seed rule for an address that never stated its scheme: https
    /// when the port ends in 443, http otherwise.
    public static func schemeFromPort(_ port: Int) -> String {
        port > 0 && port % 1000 == 443 ? "https" : "http"
    }

    /// What a stored scheme becomes: a trailing `://` tolerated, anything
    /// other than http or https falls back to the seed.
    public static func normalizeScheme(_ scheme: String, port: Int) -> String {
        var text = scheme.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.hasSuffix("://") { text.removeLast(3) }
        if text == "http" || text == "https" { return text }
        return schemeFromPort(port)
    }

    /// "host", "host:8989", "https://host:8443/x", "[fd00::10]:8989" → parts.
    /// A path is dropped; a port that is not a number (`user:pw@host`) and a
    /// scheme other than http(s) stay in the host, so a host check refuses
    /// the whole thing.
    public static func split(_ value: String) -> ServerAddressParts {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        var scheme = ""
        if let range = text.range(of: #"^([A-Za-z][A-Za-z0-9+.\-]*)://"#, options: .regularExpression) {
            let typed = String(text[range].dropLast(3)).lowercased()
            if typed != "http" && typed != "https" {
                return ServerAddressParts(scheme: "", host: text, port: nil)
            }
            scheme = typed
            text = String(text[range.upperBound...])
        }
        if let slash = text.firstIndex(of: "/") {
            text = String(text[..<slash])
        }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("[") {
            if let close = text.firstIndex(of: "]") {
                let host = String(text[...close])
                let rest = text[text.index(after: close)...]
                if rest.isEmpty {
                    return ServerAddressParts(scheme: scheme, host: host, port: nil)
                }
                if rest.hasPrefix(":") {
                    let digits = rest.dropFirst()
                    if !digits.isEmpty, digits.allSatisfy(\.isASCIIDigit), let port = Int(digits) {
                        return ServerAddressParts(scheme: scheme, host: host, port: port)
                    }
                }
            }
            return ServerAddressParts(scheme: scheme, host: text, port: nil)
        }
        let colons = text.filter { $0 == ":" }.count
        if colons == 1, let colon = text.firstIndex(of: ":") {
            let portText = text[text.index(after: colon)...]
            if portText.isEmpty {
                return ServerAddressParts(scheme: scheme, host: String(text[..<colon]), port: nil)
            }
            if portText.allSatisfy(\.isASCIIDigit), let port = Int(portText) {
                return ServerAddressParts(scheme: scheme, host: String(text[..<colon]), port: port)
            }
        }
        return ServerAddressParts(scheme: scheme, host: text, port: nil)
    }

    /// The base URL of a self-hosted backend typed by its owner. A bare host
    /// is the backend's default port (8989) over http, as the add-frame form
    /// reads it; a port ending in 443 is https unless the address said.
    public static func backendBaseURL(_ typed: String) -> URL? {
        let parts = split(typed)
        guard !parts.host.isEmpty, !parts.host.contains("@"), !parts.host.contains("://") else { return nil }
        let explicitPort = parts.port
        let scheme: String
        if !parts.scheme.isEmpty {
            scheme = parts.scheme
        } else if let port = explicitPort {
            scheme = schemeFromPort(port)
        } else {
            scheme = "http"
        }
        let port = explicitPort ?? (parts.scheme.isEmpty ? 8989 : nil)
        let defaultPort = scheme == "https" ? 443 : 80
        let portSuffix = port.map { $0 == defaultPort ? "" : ":\($0)" } ?? ""
        return URL(string: "\(scheme)://\(parts.host)\(portSuffix)")
    }
}

private extension Character {
    var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}
