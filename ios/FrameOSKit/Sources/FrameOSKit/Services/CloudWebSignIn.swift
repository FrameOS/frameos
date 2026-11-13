import CryptoKit
import Foundation

/// Signing in to FrameOS Cloud through its web sign-in (Google, a passkey,
/// two-factor), for what a password form in the app cannot do: the system's
/// sign-in sheet opens `url`, the cloud comes back to `frameos://sign-in` with
/// a code, and `AuthService.cloudFinishWebSignIn` trades it, with this
/// request's PKCE verifier, for the app's own session. The cloud side is
/// cloud/docs/auth.md "Signing in to the app".
public struct CloudWebSignIn: Sendable {
    public enum Provider: String, Sendable {
        case google
    }

    /// The scheme the sign-in sheet waits for. The sheet catches it itself:
    /// the app registers no URL scheme, so nothing else is sent its codes.
    public static let callbackScheme = "frameos"

    public let baseURL: URL
    public let provider: Provider?
    /// Confirming it is you (sudo mode): the cloud asks for a fresh proof.
    public let reauth: Bool
    public let verifier: String
    public let state: String

    public init(baseURL: URL, provider: Provider? = nil, reauth: Bool = false,
                verifier: String = CloudWebSignIn.randomToken(), state: String = CloudWebSignIn.randomToken(bytes: 16))
    {
        self.baseURL = baseURL
        self.provider = provider
        self.reauth = reauth
        self.verifier = verifier
        self.state = state
    }

    /// What the sign-in sheet opens.
    public var url: URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/auth/app/authorize"
        var items = [
            URLQueryItem(name: "code_challenge", value: Self.challenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        if let provider { items.append(URLQueryItem(name: "provider", value: provider.rawValue)) }
        if reauth { items.append(URLQueryItem(name: "reauth", value: "1")) }
        components.queryItems = items
        return components.url!
    }

    /// PKCE S256: base64url of the verifier's SHA-256 (RFC 7636).
    public static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    }

    public static func randomToken(bytes: Int = 32) -> String {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<bytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) }).base64URLEncodedString()
    }

    /// The code the sheet came back with, or why there is none. A "Cancel"
    /// on the cloud's page reads `cancelled`, which the screens let pass
    /// quietly like the sheet's own Cancel.
    public func code(from callback: URL) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard callback.scheme == Self.callbackScheme, value("state") == state else {
            throw APIError(status: 0, code: "invalid_state", message: "The sign-in came back for another request. Try again.")
        }
        if let error = value("error") {
            if error == "access_denied" { throw APIError(status: 0, code: "cancelled", message: "Cancelled.") }
            throw APIError(status: 0, code: error, message: "The sign-in did not finish. Try again.")
        }
        guard let code = value("code"), !code.isEmpty else {
            throw APIError(status: 0, code: "invalid_grant", message: "The sign-in did not finish. Try again.")
        }
        return code
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension AuthService {
    /// `POST /api/auth/app/token {code, code_verifier}`: the cloud sets the
    /// app's own session cookie. Confirming it is you (`expecting`), the
    /// session must be the same account's; it is kept under that account.
    public static func cloudFinishWebSignIn(_ request: CloudWebSignIn, callback: URL,
                                            expecting existing: Account? = nil) async throws -> (Account, APIClient)
    {
        let code = try request.code(from: callback)
        let draft = existing ?? Account(kind: .cloud, baseURL: request.baseURL, email: "")
        let client = APIClient(account: draft, credentials: AccountCredentials())
        let answer = try await client.call("POST", "/api/auth/app/token", body: .json([
            "code": .string(code), "code_verifier": .string(request.verifier),
        ]))
        let email = answer["email"]?.stringValue ?? ""
        if let existing, email.lowercased() != existing.email.lowercased() {
            await endCloudSession(client)
            throw APIError(status: 0, code: "other_account",
                           message: "That browser is signed in as \(email). Sign in there as \(existing.email), then try again.")
        }
        var account = draft
        if !email.isEmpty { account.email = email }
        return (try await finishCloud(account, client), client)
    }

    /// Signs one cloud session out on the cloud, leaving the Keychain alone
    /// (a session replaced by a fresher one).
    public static func endCloudSession(_ client: APIClient) async {
        var request = client.request("POST", "/api/auth/logout")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        _ = try? await client.session.data(for: request)
    }
}
