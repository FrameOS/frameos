import Foundation
import Security

/// The app's one secret store: each signed-in account's credentials (the
/// cloud's session cookie, a backend's token and cookie) are a Keychain item,
/// never a file or a UserDefaults key.
public enum Keychain {
    static let service = "net.frameos.app.accounts"

    public static func save(_ data: Data, for key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    public static func load(_ key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    public static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// A cookie as the Keychain keeps it.
public struct StoredCookie: Codable, Hashable, Sendable {
    public var name: String
    public var value: String
    public var domain: String
    public var path: String
    public var expires: Date?
    public var secure: Bool

    public init(_ cookie: HTTPCookie) {
        name = cookie.name
        value = cookie.value
        domain = cookie.domain
        path = cookie.path
        expires = cookie.expiresDate
        secure = cookie.isSecure
    }

    public var httpCookie: HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name, .value: value, .domain: domain, .path: path,
        ]
        if let expires { properties[.expires] = expires }
        if secure { properties[.secure] = "TRUE" }
        return HTTPCookie(properties: properties)
    }
}

/// Everything an account needs to talk to its plane again after a relaunch.
public struct AccountCredentials: Codable, Hashable, Sendable {
    /// Backend: the login JWT (7 days) or an `fb_api_` token (up to a year).
    public var bearer: String?
    /// Backend: the id of the API token the app minted at sign-in, revoked at sign-out.
    public var apiTokenId: String?
    /// The session cookies (the cloud's session, a backend's `frameos_session` for its socket).
    public var cookies: [StoredCookie]

    public init(bearer: String? = nil, apiTokenId: String? = nil, cookies: [StoredCookie] = []) {
        self.bearer = bearer
        self.apiTokenId = apiTokenId
        self.cookies = cookies
    }

    static func key(_ accountId: String) -> String { "credentials.\(accountId)" }

    public static func load(accountId: String) -> AccountCredentials? {
        guard let data = Keychain.load(key(accountId)) else { return nil }
        return try? JSONDecoder().decode(AccountCredentials.self, from: data)
    }

    public func save(accountId: String) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        Keychain.save(data, for: Self.key(accountId))
    }

    public static func delete(accountId: String) {
        Keychain.delete(key(accountId))
    }
}
