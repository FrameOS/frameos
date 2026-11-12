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
        /// A FrameOS Cloud account with a password already has this address:
        /// ask for that password, then `cloudLink`.
        case linkRequired(PendingLink)
    }

    /// An Apple sign-in waiting for the password of the account it matched.
    /// The client holds the short-lived `frameos_link_pending` cookie.
    public struct PendingLink: @unchecked Sendable {
        public let email: String
        /// The cloud's sentence for it.
        public let message: String
        let account: Account
        let client: APIClient
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
            let email = failure.body?["email"]?.stringValue ?? ""
            var account = draft
            account.email = email
            return .linkRequired(PendingLink(email: email, message: failure.message, account: account, client: client))
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
}
