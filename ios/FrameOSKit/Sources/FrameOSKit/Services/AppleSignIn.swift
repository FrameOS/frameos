import CryptoKit
import Foundation

/// Sign in with Apple's cloud half (cloud/docs/auth.md "Sign in with Apple").
/// The system's sheet hands the app an identity token and an authorization
/// code; `AuthService.cloudSignInWithApple` posts them to
/// `/api/auth/apple/native` with the nonce the request carried, hashed.
public enum AppleSignIn {
    /// A fresh nonce for one request. Apple gets `hash(nonce)` (and puts it in
    /// the identity token); the cloud gets the nonce itself and checks the two.
    public static func makeNonce() -> String {
        CloudWebSignIn.randomToken()
    }

    /// SHA-256 in lowercase hex, as the cloud's `appleNonceHash` computes it.
    public static func hash(_ nonce: String) -> String {
        SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

extension AuthService {
    public enum AppleStep: Sendable {
        case signedIn(Account, APIClient)
        /// The account has a second factor: ask for the code, then `cloudSecondFactor`.
        case secondFactor(PendingCloudSignIn)
        /// A FrameOS Cloud account already has this address: prove it once,
        /// with its password (`cloudLink`) or by signing in to it on the web
        /// (`cloudLinkOnWeb`).
        case linkRequired(PendingLink)
    }

    /// An Apple sign-in waiting for proof of the account it matched.
    /// The client holds the short-lived `frameos_link_pending` cookie.
    public struct PendingLink: @unchecked Sendable {
        public let email: String
        /// The cloud's sentence for it.
        public let message: String
        /// The account has a password the app can ask for. A cloud from
        /// before `methods` linked with a password only.
        public let hasPassword: Bool
        /// "Google or a passkey": the account's other ways in, which the
        /// web's sign-in sheet offers. Nil when it has none.
        public let otherWays: String?
        let account: Account
        let client: APIClient

        init(email: String, message: String, hasPassword: Bool = true, otherWays: String? = nil,
             account: Account, client: APIClient)
        {
            self.email = email
            self.message = message
            self.hasPassword = hasPassword
            self.otherWays = otherWays
            self.account = account
            self.client = client
        }

        /// The `409 link_required` answer's `methods` and `other_ways`.
        init(answer: JSONValue?, message: String, account: Account, client: APIClient) {
            let other = answer?["other_ways"]?.stringValue
            self.init(email: account.email, message: message,
                      hasPassword: answer?["methods"]?["password"]?.boolValue ?? true,
                      otherWays: other?.isEmpty == false ? other : nil, account: account, client: client)
        }
    }

    /// `POST /api/auth/apple/native`.
    public static func cloudSignInWithApple(baseURL: URL, identityToken: String, authorizationCode: String,
                                            nonce: String, givenName: String?, familyName: String?) async throws -> AppleStep
    {
        let draft = Account(kind: .cloud, baseURL: baseURL, email: "")
        let client = APIClient(account: draft, credentials: AccountCredentials())
        var body: [String: JSONValue] = [
            "authorization_code": .string(authorizationCode),
            "identity_token": .string(identityToken),
            "nonce": .string(nonce),
        ]
        if let givenName, !givenName.isEmpty { body["given_name"] = .string(givenName) }
        if let familyName, !familyName.isEmpty { body["family_name"] = .string(familyName) }
        let answer: JSONValue
        do {
            answer = try await client.call("POST", "/api/auth/apple/native", body: .json(.object(body)))
        } catch let failure as APIError where failure.code == "link_required" {
            var account = draft
            account.email = failure.body?["email"]?.stringValue ?? ""
            return .linkRequired(PendingLink(answer: failure.body, message: failure.message, account: account, client: client))
        }
        if answer["second_factor_required"]?.boolValue == true {
            return .secondFactor(PendingCloudSignIn(account: draft, client: client))
        }
        var account = draft
        account.email = answer["email"]?.stringValue ?? ""
        return .signedIn(try await finishCloud(account, client), client)
    }

    /// `POST /api/auth/link {password}`: connects the Apple ID to the account
    /// that has its address, and signs in.
    public static func cloudLink(_ pending: PendingLink, password: String) async throws -> CloudStep {
        let answer = try await pending.client.call("POST", "/api/auth/link", body: .json(["password": .string(password)]))
        if answer["second_factor_required"]?.boolValue == true {
            return .secondFactor(PendingCloudSignIn(account: pending.account, client: pending.client))
        }
        return .signedIn(try await finishCloud(pending.account, pending.client), pending.client)
    }

    /// Connects the Apple ID after signing in to the matched account through
    /// the web's sign-in sheet: `request` (made with `reauth`, so the proof is
    /// fresh) came back with `callback`. The code is traded on the pending
    /// link's own client, so the new session and the pending-link cookie go
    /// out together, and `POST /api/auth/link` with no password takes that
    /// session as the proof. The session already passed any second factor.
    public static func cloudLinkOnWeb(_ pending: PendingLink, request: CloudWebSignIn,
                                      callback: URL) async throws -> (Account, APIClient)
    {
        let code = try request.code(from: callback)
        let answer = try await pending.client.call("POST", "/api/auth/app/token", body: .json([
            "code": .string(code), "code_verifier": .string(request.verifier),
        ]))
        do {
            _ = try await pending.client.call("POST", "/api/auth/link", body: .json(.object([:])))
        } catch let failure as APIError where failure.code == "wrong_account" {
            await endCloudSession(pending.client)
            let email = answer["email"]?.stringValue ?? "another account"
            throw APIError(status: failure.status, code: failure.code,
                           message: "That browser is signed in as \(email). Sign in there as \(pending.email), then try again.")
        }
        return (try await finishCloud(pending.account, pending.client), pending.client)
    }
}
