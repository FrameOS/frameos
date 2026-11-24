import Foundation

/// One signed-in control plane: FrameOS Cloud, or a self-hosted backend.
/// The app keeps a list of them (Settings → Accounts) and shows one at a
/// time; the credentials are in the Keychain, this is only where and who.
public struct Account: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: PlaneKind
    public var baseURL: URL
    /// The email the account signed in with.
    public var email: String
    /// Backend only: the project every `/api/...` path is scoped to.
    public var projectId: Int?
    public var addedAt: Date

    public init(id: String = UUID().uuidString, kind: PlaneKind, baseURL: URL, email: String,
                projectId: Int? = nil, addedAt: Date = Date())
    {
        self.id = id
        self.kind = kind
        self.baseURL = baseURL
        self.email = email
        self.projectId = projectId
        self.addedAt = addedAt
    }

    /// "FrameOS Cloud" or the backend's host and port.
    public var planeLabel: String {
        switch kind {
        case .cloud:
            return baseURL.host == "cloud.frameos.net" ? "FrameOS Cloud" : "FrameOS Cloud (\(baseURL.host ?? baseURL.absoluteString))"
        case .backend:
            var host = baseURL.host ?? baseURL.absoluteString
            if let port = baseURL.port { host += ":\(port)" }
            return host
        }
    }

    /// `scheme://host[:port]`, the value the cloud wants in `Origin`, written
    /// the way a browser writes it (the cloud compares it with its own
    /// origins as text, `src/lib/csrf.ts`): lowercase, the default port left
    /// out, an IPv6 address in brackets. A cloud address typed with a capital
    /// letter was refused as `invalid_origin` before.
    public var origin: String {
        let scheme = (baseURL.scheme ?? "https").lowercased()
        var host = (baseURL.host ?? "").lowercased()
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
        var text = "\(scheme)://\(host)"
        if let port = baseURL.port, port != (scheme == "https" ? 443 : 80) { text += ":\(port)" }
        return text
    }

    /// The origin of any URL, written as `origin` writes this account's; nil
    /// for what is no http(s) URL with a host.
    public static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let named = url.host?.lowercased(), !named.isEmpty
        else { return nil }
        var host = named
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
        var text = "\(scheme)://\(host)"
        if let port = url.port, port != (scheme == "https" ? 443 : 80) { text += ":\(port)" }
        return text
    }

    /// Whether `url` is this plane's own origin: the same scheme, host and
    /// port. Only such a URL is sent the account's credentials (a backend's
    /// bearer, the cloud's cookies): the same host on another port is another
    /// program, and the same host over plain http can be read on the way.
    public func isSameOrigin(_ url: URL) -> Bool {
        guard let other = Account.origin(of: url) else { return false }
        return other == origin
    }

    public static let defaultCloudURL = URL(string: "https://cloud.frameos.net")!
}

/// The saved account list (no secrets: those are `AccountCredentials`).
public enum AccountList {
    static let key = "frameos.accounts"
    static let currentKey = "frameos.currentAccount"

    public static func load(defaults: UserDefaults = .standard) -> [Account] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([Account].self, from: data)) ?? []
    }

    public static func save(_ accounts: [Account], defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(accounts) {
            defaults.set(data, forKey: key)
        }
    }

    public static func currentId(defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: currentKey)
    }

    public static func setCurrentId(_ id: String?, defaults: UserDefaults = .standard) {
        defaults.set(id, forKey: currentKey)
    }
}
