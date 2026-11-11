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

    /// `scheme://host[:port]`, the value the cloud wants in `Origin`.
    public var origin: String {
        var text = "\(baseURL.scheme ?? "https")://\(baseURL.host ?? "")"
        if let port = baseURL.port { text += ":\(port)" }
        return text
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
